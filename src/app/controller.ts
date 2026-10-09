import { computeBounds } from '../core/mesh';
import type { Vec3 } from '../core/math';
import type { Renderer } from '../gpu/renderer';
import { Camera } from '../tools/camera';
import { Emitter } from '../tools/emitter';
import {
  applyNavDrag,
  applyWheel,
  MUDBOX_NAV,
  type NavAction,
  type NavPreset,
} from '../tools/navigation';
import { SculptTool } from '../tools/sculptTool';
import type { StrokeSample } from '../tools/stroke';
import {
  IS_MAC,
  isEditable,
  learnKey,
  matchHotkey,
  STENCIL_KEY,
  type HotkeyId,
} from '../ui/hotkeys';
import type { MaskCommand, SculptDocument } from './document';

/** An SVG cursor drawn white with a dark outline, so it reads on any background. */
function svgCursor(path: string, fallback: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${path}" stroke="#111" stroke-width="4"/><path d="${path}" stroke="#fff" stroke-width="2"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, ${fallback}`;
}

/** Cursors for camera actions. Orbit is a curved double arrow (no CSS keyword for it). */
const NAV_CURSORS: Record<NavAction, string> = {
  orbit: svgCursor(
    'M4 11 A8 6 0 0 0 20 11 M1.5 13.5 L4 10 L7 12.5 M17 12.5 L20 10 L22.5 13.5',
    'move',
  ),
  pan: 'move',
  // Zoom drags along the diagonal: right/down moves in.
  dolly: 'nwse-resize',
};

export interface Stats {
  fps: number;
  /** Worst CPU time per frame over the sample window, in ms. */
  frameMs: number;
}

export interface ControllerEvents extends Record<string, unknown> {
  stats: Stats;
}

/**
 * Wires the canvas, camera, sculpt tool, document and renderer together and
 * runs the frame loop. Owns no mesh logic itself.
 */
export class AppController {
  readonly camera = new Camera();
  readonly tool: SculptTool;
  readonly events = new Emitter<ControllerEvents>();
  nav: NavPreset = MUDBOX_NAV;

  private needsRender = true;
  private dirtyDocument = false;
  private navAction: NavAction | null = null;
  /** True while the stencil key is held. */
  private stencilKey = false;
  /** True while Alt/Option is held: the mouse drives the camera. */
  private altHeld = false;
  /** Latest modifier state, so the Alt cursor can show pan/zoom before clicking. */
  private mods = { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false };
  /** Mudbox stencil drags: S + LMB rotate, S + MMB move, S + RMB scale. */
  private stencilAction: 'rotate' | 'move' | 'scale' | null = null;
  private stencilImageId: string | null = null;
  private activePointer: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private rect: DOMRect;
  private rafId = 0;
  private statFrames = 0;
  private statWorstMs = 0;
  private statStart = performance.now();
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: Renderer,
    readonly document: SculptDocument,
  ) {
    this.rect = canvas.getBoundingClientRect();
    this.tool = new SculptTool(document.mesh, this.camera, renderer, (stroke, kind) =>
      document.commitStroke(stroke, kind),
    );
    document.attach({
      setMesh: (mesh) => {
        this.tool.setMesh(mesh);
        renderer.setMesh(mesh);
        this.afterCameraMove();
      },
      meshEdited: (vertices) => {
        this.tool.meshEdited(vertices);
        this.needsRender = true;
      },
      maskEdited: (vertices) => {
        renderer.markDirty(vertices);
        this.needsRender = true;
      },
    });
    document.events.on('edited', () => {
      this.dirtyDocument = true;
      this.needsRender = true;
    });
    this.tool.events.on('settings', (s) => {
      this.needsRender = true;
      // Keep the overlay texture in step with the chosen stencil image.
      if (s.stencil.id !== this.stencilImageId) {
        this.stencilImageId = s.stencil.id;
        renderer.setStencilImage(this.tool.stamps.get(s.stencil.id)?.stamp ?? null);
      }
    });
    renderer.setMesh(document.mesh);
    this.frame();
    this.bindInput();
    this.observeSize();
    this.rafId = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    for (const fn of this.cleanup) fn();
    this.renderer.destroy();
  }

  // --- commands (called by hotkeys and UI) ---------------------------------

  run(cmd: HotkeyId): void {
    // Nothing that swaps or rewrites the mesh may happen mid-stroke.
    if (this.tool.isStroking && cmd !== 'radiusDown' && cmd !== 'radiusUp') return;
    switch (cmd) {
      case 'undo':
        this.document.undo();
        break;
      case 'redo':
      case 'redoAlt':
        this.document.redo();
        break;
      case 'levelUp':
        this.document.stepLevel(1);
        break;
      case 'levelDown':
        this.document.stepLevel(-1);
        break;
      case 'addLevel':
        this.document.addLevel();
        break;
      case 'radiusDown':
        this.tool.stepRadius(-1);
        break;
      case 'radiusUp':
        this.tool.stepRadius(1);
        break;
      case 'frame':
        this.frame();
        break;
      case 'symmetry':
        this.tool.setSymmetryX(!this.tool.settings.symmetryX);
        break;
    }
  }

  /** Invert, clear or fill the mask (not mid-stroke). */
  maskCommand(cmd: MaskCommand): void {
    if (!this.tool.isStroking) this.document.maskCommand(cmd);
  }

  frame(): void {
    const mesh = this.document.mesh;
    const b = computeBounds(mesh.positions, mesh.vertexCount);
    this.camera.frame(b.center as Vec3, b.radius);
    this.afterCameraMove();
  }

  // --- frame loop ----------------------------------------------------------

  private readonly tick = (): void => {
    this.rafId = requestAnimationFrame(this.tick);
    const t0 = performance.now();
    if (this.tool.update()) this.needsRender = true;
    if (this.needsRender) {
      this.needsRender = false;
      const { eye, right, up, forward } = this.camera.basis();
      // Lights ride with the camera: key from upper left, fill from lower right.
      const key = normalize([
        -forward[0] - right[0] * 0.6 + up[0] * 0.8,
        -forward[1] - right[1] * 0.6 + up[1] * 0.8,
        -forward[2] - right[2] * 0.6 + up[2] * 0.8,
      ]);
      const fill = normalize([
        -forward[0] + right[0] * 0.8 - up[0] * 0.3,
        -forward[1] + right[1] * 0.8 - up[1] * 0.3,
        -forward[2] + right[2] * 0.8 - up[2] * 0.3,
      ]);
      this.renderer.render({
        viewProj: this.camera.viewProj(),
        eye,
        keyLight: key,
        fillLight: fill,
        // No brush ring while the mouse drives the camera or the stencil.
        brush:
          this.navAction || this.stencilAction || (this.altHeld && !this.tool.isStroking)
            ? null
            : this.tool.overlay(),
        stencil: this.stencilOverlay(),
        symmetryX: this.tool.settings.symmetryX,
      });
      this.statFrames++;
    }
    this.statWorstMs = Math.max(this.statWorstMs, performance.now() - t0);
    const elapsed = t0 - this.statStart;
    if (elapsed >= 500) {
      this.events.emit('stats', {
        fps: Math.round((this.statFrames * 1000) / elapsed),
        frameMs: this.statWorstMs,
      });
      this.statFrames = 0;
      this.statWorstMs = 0;
      this.statStart = t0;
    }
  };

  private afterCameraMove(): void {
    this.needsRender = true;
    this.tool.hover(this.lastX, this.lastY);
  }

  // --- input ---------------------------------------------------------------

  private listen<K extends keyof WindowEventMap>(
    target: Window | HTMLElement,
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn as EventListener, opts);
    this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
  }

  private bindInput(): void {
    const c = this.canvas;
    c.style.touchAction = 'none';

    this.listen(c, 'pointerdown', (e) => this.onPointerDown(e));
    this.listen(c, 'pointermove', (e) => this.onPointerMove(e));
    this.listen(c, 'pointerup', (e) => this.onPointerUp(e));
    this.listen(c, 'pointercancel', (e) => this.onPointerUp(e));
    this.listen(c, 'pointerleave', () => {
      if (this.activePointer === null) {
        this.tool.clearHover();
        this.needsRender = true;
      }
    });
    this.listen(c, 'contextmenu', (e) => e.preventDefault());
    this.listen(
      c,
      'wheel',
      (e) => {
        e.preventDefault();
        applyWheel(this.camera, e.deltaY, e.deltaMode);
        this.afterCameraMove();
      },
      { passive: false },
    );

    this.listen(window, 'keydown', (e) => this.onKey(e, true));
    this.listen(window, 'keyup', (e) => this.onKey(e, false));
    this.listen(window, 'blur', () => {
      this.syncModifiers({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
      this.setStencilKey(false);
    });
    this.listen(window, 'beforeunload', (e) => {
      if (this.dirtyDocument) e.preventDefault();
    });
  }

  private localPoint(e: PointerEvent): [number, number] {
    return [e.clientX - this.rect.left, e.clientY - this.rect.top];
  }

  private sample(e: PointerEvent): StrokeSample {
    const [x, y] = this.localPoint(e);
    // Mice report a constant 0.5 while pressed; treat them as full pressure.
    const pressure = e.pointerType === 'pen' ? e.pressure : 1;
    return { x, y, pressure, tiltX: e.tiltX, tiltY: e.tiltY, time: e.timeStamp };
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.activePointer !== null) return;
    this.rect = this.canvas.getBoundingClientRect();
    // macOS turns Ctrl + click into a secondary click in some browsers; Ctrl
    // means "invert" here, so treat it as the primary button.
    const button =
      IS_MAC && e.ctrlKey && e.button === 2 && e.pointerType === 'mouse' ? 0 : e.button;
    const nav = this.nav.match({ ...modifiersOf(e), button });
    [this.lastX, this.lastY] = this.localPoint(e);

    if (this.stencilKey && this.tool.settings.stencil.id !== null) {
      this.stencilAction = button === 0 ? 'rotate' : button === 1 ? 'move' : 'scale';
    } else if (nav) {
      this.navAction = nav;
      this.updateCursor();
    } else if (button === 0) {
      this.tool.beginStroke(this.sample(e), { invert: e.ctrlKey, smooth: e.shiftKey });
    } else {
      return;
    }
    e.preventDefault();
    this.activePointer = e.pointerId;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (e.g. synthetic or cancelled); carry on uncaptured.
    }
    this.needsRender = true;
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.activePointer !== null && e.pointerId !== this.activePointer) return;
    const [x, y] = this.localPoint(e);

    if (this.stencilAction) {
      this.dragStencil(this.stencilAction, this.lastX, this.lastY, x, y);
      this.lastX = x;
      this.lastY = y;
      this.needsRender = true;
      return;
    }
    if (this.navAction) {
      applyNavDrag(this.camera, this.navAction, x - this.lastX, y - this.lastY);
      this.lastX = x;
      this.lastY = y;
      this.needsRender = true;
      return;
    }
    this.lastX = x;
    this.lastY = y;

    if (this.tool.isStroking) {
      // Pens report at a higher rate than pointermove fires; use every sample.
      const events = e.getCoalescedEvents?.() ?? [];
      if (events.length > 0) for (const ce of events) this.tool.addSample(this.sample(ce));
      else this.tool.addSample(this.sample(e));
    } else {
      this.syncModifiers(e);
      this.tool.hover(x, y);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.stencilAction) {
      this.stencilAction = null;
      this.tool.hover(this.lastX, this.lastY);
    } else if (this.navAction) {
      this.navAction = null;
      this.updateCursor();
      this.afterCameraMove();
    } else {
      this.tool.endStroke(this.sample(e));
    }
    this.needsRender = true;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    // Keep Alt from focusing the browser menu bar (Windows, Firefox).
    if (e.key === 'Alt') e.preventDefault();
    this.syncModifiers(e);
    if (e.code === STENCIL_KEY && !isEditable(e.target)) {
      this.setStencilKey(down && !e.ctrlKey && !e.metaKey && !e.altKey);
      return;
    }
    if (!down) return;
    learnKey(e);
    const cmd = matchHotkey(e);
    if (cmd) {
      e.preventDefault();
      this.run(cmd);
    }
  }

  private setStencilKey(held: boolean): void {
    if (held === this.stencilKey) return;
    this.stencilKey = held;
    this.updateCursor();
  }

  /** The cursor says what the mouse will do: camera, stencil, or sculpt (default). */
  private updateCursor(): void {
    let cursor = '';
    if (this.navAction) cursor = NAV_CURSORS[this.navAction];
    else if (this.stencilAction) cursor = 'move';
    else if (this.altHeld && !this.tool.isStroking) {
      // What a left-button drag would do with the modifiers held right now.
      cursor = NAV_CURSORS[this.nav.match({ ...this.mods, button: 0 }) ?? 'orbit'];
    } else if (this.stencilKey && this.tool.settings.stencil.id !== null) cursor = 'move';
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
  }

  /** Applies one pointer step of a stencil drag (CSS pixels). */
  private dragStencil(
    action: 'rotate' | 'move' | 'scale',
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void {
    const st = this.tool.settings.stencil;
    let { centerX, centerY, size, angle } = st;
    if (action === 'move') {
      centerX += x1 - x0;
      centerY += y1 - y0;
    } else if (action === 'rotate') {
      // Turn by the change in the pointer's angle around the stencil center.
      angle += Math.atan2(y1 - centerY, x1 - centerX) - Math.atan2(y0 - centerY, x0 - centerX);
    } else {
      // Drag right or up to grow.
      size *= Math.exp((x1 - x0 - (y1 - y0)) * 0.005);
    }
    this.tool.setStencilPlacement(centerX, centerY, size, angle);
  }

  /** The stencil overlay in framebuffer pixels, or null when no stencil is set. */
  private stencilOverlay() {
    const st = this.tool.settings.stencil;
    if (st.id === null) return null;
    const ratio = this.canvas.width / Math.max(1, this.camera.widthPx);
    return {
      centerX: st.centerX * ratio,
      centerY: st.centerY * ratio,
      halfSize: (st.size / 2) * ratio,
      angle: st.angle,
      opacity: st.opacity,
      tile: st.tile,
    };
  }

  private syncModifiers(e: {
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  }): void {
    this.tool.setModifiers({ invert: e.ctrlKey, smooth: e.shiftKey });
    const altKey = e.altKey ?? this.mods.altKey;
    const m = this.mods;
    if (
      altKey !== m.altKey ||
      e.shiftKey !== m.shiftKey ||
      e.ctrlKey !== m.ctrlKey ||
      (e.metaKey ?? m.metaKey) !== m.metaKey
    ) {
      this.mods = {
        altKey,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey ?? m.metaKey,
      };
      this.altHeld = altKey;
      this.updateCursor();
    }
    this.needsRender = true;
  }

  private observeSize(): void {
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      const css = entry.contentRect;
      const device = entry.devicePixelContentBoxSize?.[0];
      const dpr = window.devicePixelRatio || 1;
      this.camera.widthPx = Math.max(1, css.width);
      this.camera.heightPx = Math.max(1, css.height);
      this.renderer.resize(
        device ? device.inlineSize : css.width * dpr,
        device ? device.blockSize : css.height * dpr,
      );
      this.rect = this.canvas.getBoundingClientRect();
      this.needsRender = true;
    });
    try {
      ro.observe(this.canvas, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(this.canvas);
    }
    this.cleanup.push(() => ro.disconnect());
  }
}

function modifiersOf(e: PointerEvent) {
  return { altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey };
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
