import { BRUSH_ORDER, BRUSHES, BrushEngine, type BrushKind } from '../core/brush';
import type { FalloffKind } from '../core/falloff';
import type { Mesh } from '../core/mesh';
import { NormalUpdater } from '../core/normals';
import { RaycastScratch, raycastMesh, type RayHit } from '../core/raycast';
import { SpatialGrid } from '../core/spatialGrid';
import { StrokeRecorder, type ArrayPatch } from '../core/undo';
import type { BrushOverlay } from '../gpu/renderer';
import type { Camera } from './camera';
import { Emitter } from './emitter';
import { StrokeSampler, type StrokeSample } from './stroke';

export interface ToolSettings {
  brush: BrushKind;
  /** Brush radius in CSS pixels, shared by all brushes. */
  radiusPx: number;
  /** Per-brush strength, 0..1. */
  strength: Record<BrushKind, number>;
  /** Per-brush falloff curve. */
  falloff: Record<BrushKind, FalloffKind>;
  symmetryX: boolean;
}

export interface ToolEvents extends Record<string, unknown> {
  settings: ToolSettings;
}

export interface StrokeModifiers {
  /** Mudbox: Ctrl inverts the brush. */
  invert: boolean;
  /** Mudbox: Shift temporarily switches to Smooth. */
  smooth: boolean;
}

export const RADIUS_MIN_PX = 2;
export const RADIUS_MAX_PX = 600;
/** Dab spacing as a fraction of the brush radius. */
const SPACING = 0.15;
/** Time budget for applying dabs in one frame; the rest carries to the next frame. */
const FRAME_BUDGET_MS = 10;
/** Smooth at strength 1 moves this fraction of the way to the neighbor average per dab. */
const SMOOTH_SCALE = 0.5;

/** Receives mesh changes for upload; implemented by the renderer. */
export interface MeshSink {
  markDirty(vertices: Uint32Array): void;
}

/** Receives each finished stroke (a patch on the mesh positions), e.g. for multires and undo. */
export type StrokeCommit = (stroke: ArrayPatch) => void;

/**
 * Sculpt tool state machine: hover and stroke (begin -> samples -> end) on
 * the current mesh. Pointer input is queued; `update()` does the work once
 * per frame. Finished strokes go to `onStroke`; the tool keeps no history.
 */
export class SculptTool {
  readonly events = new Emitter<ToolEvents>();
  readonly settings: ToolSettings = {
    brush: 'sculpt',
    radiusPx: 60,
    strength: perBrush((b) => BRUSHES[b].defaultStrength),
    falloff: perBrush((b) => BRUSHES[b].defaultFalloff),
    symmetryX: false,
  };

  private readonly grid = new SpatialGrid();
  private readonly raycastScratch = new RaycastScratch();
  private engine!: BrushEngine;
  private normals!: NormalUpdater;
  private recorder!: StrokeRecorder;
  private readonly sampler = new StrokeSampler();

  private stroking = false;
  private strokeBrush: BrushKind = 'sculpt';
  private strokeSign = 1;
  /** World radius, fixed at the first hit of a stroke so zoom can't change it mid-stroke. */
  private strokeRadius = 0;
  private dabCursor = 0;
  /** Running average cost of one dab, to avoid starting one that would blow the frame budget. */
  private dabCostMs = 1;

  // Grab strokes: vertices are picked up at the first hit and follow the
  // pointer in the screen plane at that hit's depth.
  private grabbing = false;
  private grabHit: RayHit | null = null;
  private grabStartX = 0;
  private grabStartY = 0;
  private grabX = 0;
  private grabY = 0;
  private grabPending = false;

  private hoverPending = false;
  private hoverX = 0;
  private hoverY = 0;
  private lastHit: RayHit | null = null;
  private lastRadius = 0;
  private modifiers: StrokeModifiers = { invert: false, smooth: false };

  constructor(
    private mesh: Mesh,
    private readonly camera: Camera,
    private readonly sink: MeshSink,
    private readonly onStroke: StrokeCommit,
  ) {
    this.setMesh(mesh);
  }

  get isStroking(): boolean {
    return this.stroking;
  }

  /** Switches to another mesh (e.g. a different subdivision level). */
  setMesh(mesh: Mesh): void {
    this.mesh = mesh;
    this.engine = new BrushEngine(mesh.vertexCount);
    this.normals = new NormalUpdater(mesh);
    this.recorder = new StrokeRecorder(mesh.vertexCount);
    this.grid.buildFromMesh(mesh);
    this.lastHit = null;
    this.hoverPending = true;
  }

  /** Refreshes normals, the spatial grid and GPU data after outside edits (undo, redo). */
  meshEdited(vertices: Uint32Array): void {
    this.sink.markDirty(this.normals.update(this.mesh, vertices));
    this.grid.updateFromMesh(this.mesh, vertices);
    this.hoverPending = true;
  }

  // --- settings -----------------------------------------------------------

  setBrush(brush: BrushKind): void {
    this.settings.brush = brush;
    this.emitSettings();
  }

  setRadius(px: number): void {
    this.settings.radiusPx = Math.round(Math.min(RADIUS_MAX_PX, Math.max(RADIUS_MIN_PX, px)));
    this.hoverPending = true;
    this.emitSettings();
  }

  /** Multiplicative step, so `[`/`]` feel the same at any size. */
  stepRadius(direction: 1 | -1): void {
    const r = this.settings.radiusPx;
    this.setRadius(direction > 0 ? Math.max(r + 1, r * 1.15) : Math.min(r - 1, r / 1.15));
  }

  setStrength(brush: BrushKind, value: number): void {
    this.settings.strength[brush] = Math.min(1, Math.max(0, value));
    this.emitSettings();
  }

  setFalloff(brush: BrushKind, falloff: FalloffKind): void {
    this.settings.falloff[brush] = falloff;
    this.emitSettings();
  }

  setSymmetryX(on: boolean): void {
    this.settings.symmetryX = on;
    this.emitSettings();
  }

  /** Live modifier state, for the cursor color while hovering. */
  setModifiers(mods: StrokeModifiers): void {
    this.modifiers = mods;
  }

  private emitSettings(): void {
    this.events.emit('settings', {
      ...this.settings,
      strength: { ...this.settings.strength },
      falloff: { ...this.settings.falloff },
    });
  }

  // --- input --------------------------------------------------------------

  hover(x: number, y: number): void {
    this.hoverX = x;
    this.hoverY = y;
    this.hoverPending = true;
  }

  /** Called when the pointer leaves the viewport. */
  clearHover(): void {
    this.hoverPending = false;
    this.lastHit = null;
  }

  beginStroke(s: StrokeSample, mods: StrokeModifiers): void {
    this.stroking = true;
    this.modifiers = mods;
    this.strokeBrush = mods.smooth ? 'smooth' : this.settings.brush;
    this.strokeSign = mods.invert ? -1 : 1;
    this.strokeRadius = 0;
    this.dabCursor = 0;
    this.recorder.begin();
    if (this.strokeBrush === 'grab') this.beginGrab(s);
    else this.sampler.begin(s);
  }

  addSample(s: StrokeSample): void {
    if (!this.stroking) return;
    if (this.strokeBrush === 'grab') {
      this.grabX = s.x;
      this.grabY = s.y;
      this.grabPending = this.grabbing;
    } else {
      this.sampler.add(s, this.settings.radiusPx * SPACING);
    }
  }

  endStroke(s: StrokeSample): void {
    if (!this.stroking) return;
    if (this.strokeBrush === 'grab') {
      this.addSample(s);
      this.applyGrab();
      this.grabbing = false;
      this.grabHit = null;
    } else {
      this.sampler.end(s, this.settings.radiusPx * SPACING);
      this.applyPendingDabs(Infinity);
    }
    this.stroking = false;
    this.sampler.dabs.length = 0;

    const stroke = this.recorder.end(this.mesh);
    if (stroke) this.onStroke(stroke);
    this.hover(s.x, s.y);
  }

  // --- per frame ----------------------------------------------------------

  /** Applies queued work. Returns true if the view needs redrawing. */
  update(): boolean {
    let changed = false;
    if (this.stroking && this.strokeBrush === 'grab') {
      changed = this.applyGrab();
    } else if (this.stroking) {
      changed = this.applyPendingDabs(FRAME_BUDGET_MS);
    } else if (this.hoverPending) {
      this.hoverPending = false;
      const hit = this.raycast(this.hoverX, this.hoverY);
      this.lastHit = hit;
      if (hit) this.lastRadius = this.radiusAt(hit);
      changed = true;
    }
    return changed;
  }

  /** Brush ring for the renderer, or null when not over the mesh. */
  overlay(): BrushOverlay | null {
    const hit = this.lastHit;
    if (!hit) return null;
    const smoothing = this.stroking
      ? this.strokeBrush === 'smooth'
      : this.modifiers.smooth || this.settings.brush === 'smooth';
    const inverted = this.stroking ? this.strokeSign < 0 : this.modifiers.invert;
    return {
      x: hit.x,
      y: hit.y,
      z: hit.z,
      radius: this.lastRadius,
      mirror: this.settings.symmetryX,
      active: this.stroking,
      inverted: inverted && !smoothing,
      smoothing,
    };
  }

  private beginGrab(s: StrokeSample): void {
    this.grabStartX = this.grabX = s.x;
    this.grabStartY = this.grabY = s.y;
    this.grabPending = false;
    const hit = this.raycast(s.x, s.y);
    if (!hit) return;
    this.strokeRadius = this.radiusAt(hit);
    this.grabbing = this.engine.beginGrab(
      this.mesh,
      this.grid,
      hit.x,
      hit.y,
      hit.z,
      this.strokeRadius,
      this.settings.symmetryX,
      this.settings.falloff.grab,
      this.recorder,
    );
    this.grabHit = hit;
    this.lastHit = hit;
    this.lastRadius = this.strokeRadius;
  }

  /** Moves the grabbed vertices to follow the latest pointer position. */
  private applyGrab(): boolean {
    const hit = this.grabHit;
    if (!this.grabPending || !hit) return false;
    this.grabPending = false;
    const { right, up } = this.camera.basis();
    const wpp = this.camera.worldPerPixel(this.camera.depthOf([hit.x, hit.y, hit.z]));
    const dx = (this.grabX - this.grabStartX) * wpp,
      dy = (this.grabY - this.grabStartY) * wpp;
    const ox = right[0] * dx - up[0] * dy,
      oy = right[1] * dx - up[1] * dy,
      oz = right[2] * dx - up[2] * dy;
    const moved = this.engine.dragGrab(this.mesh, this.grid, ox, oy, oz);
    this.sink.markDirty(this.normals.update(this.mesh, moved));
    this.lastHit = { ...hit, x: hit.x + ox, y: hit.y + oy, z: hit.z + oz };
    return true;
  }

  private applyPendingDabs(budgetMs: number): boolean {
    const dabs = this.sampler.dabs;
    if (this.dabCursor >= dabs.length) return false;
    const start = performance.now();
    const { settings } = this;
    let any = false;

    while (this.dabCursor < dabs.length) {
      // Always make progress, but don't start a dab that likely overruns the frame.
      if (any && performance.now() - start + this.dabCostMs > budgetMs) break;
      const dabStart = performance.now();
      const x = dabs[this.dabCursor],
        y = dabs[this.dabCursor + 1],
        pressure = dabs[this.dabCursor + 2];
      this.dabCursor += 3;

      const hit = this.raycast(x, y);
      if (!hit) continue;
      if (this.strokeRadius === 0) this.strokeRadius = this.radiusAt(hit);
      this.lastHit = hit;
      this.lastRadius = this.strokeRadius;

      const kind = this.strokeBrush === 'grab' ? 'sculpt' : this.strokeBrush;
      const base = settings.strength[kind] * pressure;
      const touched = this.engine.applyDab(
        this.mesh,
        this.grid,
        {
          kind,
          x: hit.x,
          y: hit.y,
          z: hit.z,
          radius: this.strokeRadius,
          strength: kind === 'smooth' ? base * SMOOTH_SCALE : base * this.strokeSign,
          falloff: settings.falloff[kind],
          symmetryX: settings.symmetryX,
        },
        this.recorder,
      );
      if (touched.length > 0) {
        this.sink.markDirty(this.normals.update(this.mesh, touched));
        any = true;
      }
      this.dabCostMs = this.dabCostMs * 0.8 + (performance.now() - dabStart) * 0.2;
    }

    // Reclaim consumed dabs once the queue is drained.
    if (this.dabCursor >= dabs.length) {
      dabs.length = 0;
      this.dabCursor = 0;
    }
    return any || this.lastHit !== null;
  }

  private raycast(x: number, y: number): RayHit | null {
    if (this.grid.needsRebuild()) this.grid.buildFromMesh(this.mesh);
    const { origin, dir } = this.camera.rayAt(x, y);
    return raycastMesh(
      this.mesh,
      this.grid,
      this.raycastScratch,
      origin[0],
      origin[1],
      origin[2],
      dir[0],
      dir[1],
      dir[2],
    );
  }

  private radiusAt(hit: RayHit): number {
    const depth = this.camera.depthOf([hit.x, hit.y, hit.z]);
    return this.settings.radiusPx * this.camera.worldPerPixel(depth);
  }
}

function perBrush<T>(value: (brush: BrushKind) => T): Record<BrushKind, T> {
  return Object.fromEntries(BRUSH_ORDER.map((b) => [b, value(b)])) as Record<BrushKind, T>;
}
