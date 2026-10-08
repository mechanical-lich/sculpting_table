import { BrushEngine, type BrushKind } from '../core/brush';
import type { Mesh } from '../core/mesh';
import { NormalUpdater } from '../core/normals';
import { RaycastScratch, raycastMesh, type RayHit } from '../core/raycast';
import { SpatialGrid } from '../core/spatialGrid';
import { StrokeRecorder, UndoStack } from '../core/undo';
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
  symmetryX: boolean;
}

export interface ToolEvents extends Record<string, unknown> {
  settings: ToolSettings;
  history: { canUndo: boolean; canRedo: boolean };
  /** The mesh changed (stroke, undo, redo). */
  edited: undefined;
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

/**
 * Sculpt tool state machine: hover, stroke (begin -> samples -> end), and
 * undo/redo. Pointer input is queued; `update()` does the work once per frame.
 */
export class SculptTool {
  readonly events = new Emitter<ToolEvents>();
  readonly settings: ToolSettings = {
    brush: 'sculpt',
    radiusPx: 60,
    strength: { sculpt: 0.5, smooth: 0.5 },
    symmetryX: false,
  };

  private readonly grid = new SpatialGrid();
  private readonly raycastScratch = new RaycastScratch();
  private readonly engine: BrushEngine;
  private readonly normals: NormalUpdater;
  private readonly recorder: StrokeRecorder;
  private readonly undoStack = new UndoStack();
  private readonly sampler = new StrokeSampler();

  private stroking = false;
  private strokeBrush: BrushKind = 'sculpt';
  private strokeSign = 1;
  /** World radius, fixed at the first hit of a stroke so zoom can't change it mid-stroke. */
  private strokeRadius = 0;
  private dabCursor = 0;
  /** Running average cost of one dab, to avoid starting one that would blow the frame budget. */
  private dabCostMs = 1;

  private hoverPending = false;
  private hoverX = 0;
  private hoverY = 0;
  private lastHit: RayHit | null = null;
  private lastRadius = 0;
  private modifiers: StrokeModifiers = { invert: false, smooth: false };

  constructor(
    private readonly mesh: Mesh,
    private readonly camera: Camera,
    private readonly sink: MeshSink,
  ) {
    this.engine = new BrushEngine(mesh.vertexCount);
    this.normals = new NormalUpdater(mesh);
    this.recorder = new StrokeRecorder(mesh.vertexCount);
    this.grid.buildFromMesh(mesh);
  }

  get isStroking(): boolean {
    return this.stroking;
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
    this.sampler.begin(s);
    this.recorder.begin();
  }

  addSample(s: StrokeSample): void {
    if (!this.stroking) return;
    this.sampler.add(s, this.settings.radiusPx * SPACING);
  }

  endStroke(s: StrokeSample): void {
    if (!this.stroking) return;
    this.sampler.end(s, this.settings.radiusPx * SPACING);
    this.applyPendingDabs(Infinity);
    this.stroking = false;
    this.sampler.dabs.length = 0;

    const entry = this.recorder.end(this.mesh);
    if (entry) {
      this.undoStack.push(entry);
      this.emitHistory();
      this.events.emit('edited', undefined);
    }
    this.hover(s.x, s.y);
  }

  // --- history ------------------------------------------------------------

  undo(): boolean {
    if (this.stroking) return false;
    return this.applyHistory(this.undoStack.undo(this.mesh));
  }

  redo(): boolean {
    if (this.stroking) return false;
    return this.applyHistory(this.undoStack.redo(this.mesh));
  }

  private applyHistory(indices: Uint32Array | null): boolean {
    if (!indices) return false;
    this.sink.markDirty(this.normals.update(this.mesh, indices));
    this.grid.updateFromMesh(this.mesh, indices);
    this.hoverPending = true;
    this.emitHistory();
    this.events.emit('edited', undefined);
    return true;
  }

  private emitHistory(): void {
    this.events.emit('history', {
      canUndo: this.undoStack.canUndo,
      canRedo: this.undoStack.canRedo,
    });
  }

  // --- per frame ----------------------------------------------------------

  /** Applies queued work. Returns true if the view needs redrawing. */
  update(): boolean {
    let changed = false;
    if (this.stroking) {
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

      const base = settings.strength[this.strokeBrush] * pressure;
      const touched = this.engine.applyDab(
        this.mesh,
        this.grid,
        {
          kind: this.strokeBrush,
          x: hit.x,
          y: hit.y,
          z: hit.z,
          radius: this.strokeRadius,
          strength: this.strokeBrush === 'smooth' ? base * SMOOTH_SCALE : base * this.strokeSign,
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
