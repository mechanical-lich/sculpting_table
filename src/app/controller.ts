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
import { IS_MAC, learnKey, matchHotkey, type HotkeyId } from '../ui/hotkeys';
import type { SculptDocument } from './document';

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
    this.tool = new SculptTool(document.mesh, this.camera, renderer, (stroke) =>
      document.commitStroke(stroke),
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
    });
    document.events.on('edited', () => {
      this.dirtyDocument = true;
      this.needsRender = true;
    });
    this.tool.events.on('settings', () => (this.needsRender = true));
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
        brush: this.navAction ? null : this.tool.overlay(),
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
    this.listen(window, 'blur', () => this.syncModifiers({ shiftKey: false, ctrlKey: false }));
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

    if (nav) {
      this.navAction = nav;
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
    if (this.navAction) {
      this.navAction = null;
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
    if (!down) return;
    learnKey(e);
    const cmd = matchHotkey(e);
    if (cmd) {
      e.preventDefault();
      this.run(cmd);
    }
  }

  private syncModifiers(e: { shiftKey: boolean; ctrlKey: boolean }): void {
    this.tool.setModifiers({ invert: e.ctrlKey, smooth: e.shiftKey });
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
