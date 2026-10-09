import { pickTree, type TreeHit } from '../core/armature/pick';
import {
  addChild,
  cloneTree,
  deleteNode,
  insertOnLink,
  isOnPlane,
  rotateNodes,
  scaleNodes,
  setSphere,
  subtree,
  translateNodes,
  type Armature,
} from '../core/armature/tree';
import type { ArmatureOverlay } from '../gpu/renderer';
import type { Camera } from './camera';
import { Emitter } from './emitter';

export type ArmatureToolKind = 'draw' | 'move' | 'scale' | 'rotate' | 'delete';

export const ARMATURE_TOOLS: Record<ArmatureToolKind, { label: string; hint: string }> = {
  draw: { label: 'Draw', hint: 'Drag from a sphere to add a child; click a link to insert one' },
  move: { label: 'Move', hint: 'Drag a sphere to move it; Shift moves its whole branch' },
  scale: { label: 'Scale', hint: 'Drag right or up to grow; Shift scales the whole branch' },
  rotate: { label: 'Rotate', hint: 'Drag to turn a branch around its parent' },
  delete: { label: 'Delete', hint: 'Click a sphere to delete it (children re-attach)' },
};
export const ARMATURE_TOOL_ORDER = Object.keys(ARMATURE_TOOLS) as ArmatureToolKind[];

export interface ArmatureSettings {
  tool: ArmatureToolKind;
  /** Show the skinned mesh (with the tree drawn see-through over it). */
  preview: boolean;
  /** Joint softness for skinning. */
  blend: number;
  /** Most grid cells along any axis for "Make mesh". */
  resolution: number;
}

export interface ArmatureToolEvents extends Record<string, unknown> {
  settings: ArmatureSettings;
  /** The tree changed (live, during a drag, or after an edit). */
  edited: undefined;
}

/** What the document provides: the tree and a way to record an edit for undo. */
export interface TreeHost {
  readonly tree: Armature;
  commitTree(before: Armature): void;
}

/** A new child starts at this fraction of its parent's radius. */
const CHILD_SCALE = 0.7;
const DRAG_THRESHOLD_PX = 4;

const COLOR = [0.74, 0.64, 0.52];
const COLOR_PLANE = [0.66, 0.66, 0.6];
const COLOR_HOVER = [0.98, 0.82, 0.38];
const COLOR_ACTIVE = [1.0, 0.62, 0.3];

type Drag =
  | { kind: 'grow'; node: number; sx: number; sy: number; baseR: number; depth: number }
  | { kind: 'move'; nodes: number[]; depth: number }
  | { kind: 'scale'; nodes: number[]; node: number }
  | { kind: 'rotate'; nodes: number[]; pivot: [number, number, number]; last: number };

/**
 * Armature editing: hover/pick, then one of the tools on drag. Edits go
 * straight into `host.tree`; each finished drag is one undo step.
 */
export class ArmatureTool {
  readonly events = new Emitter<ArmatureToolEvents>();
  readonly settings: ArmatureSettings = {
    tool: 'draw',
    preview: false,
    blend: 0.5,
    resolution: 160,
  };

  private hoverHit: TreeHit | null = null;
  /** What a Draw click at the hover point would add: x, y, z, r per sphere. */
  private ghost: Float32Array = new Float32Array(0);
  private drag: Drag | null = null;
  private before: Armature | null = null;
  private lastX = 0;
  private lastY = 0;
  private changed = false;
  private overlayData: ArmatureOverlay = {
    spheres: new Float32Array(64),
    colors: new Float32Array(64),
    links: new Float32Array(128),
    count: 0,
    linkCount: 0,
    xray: false,
    ghosts: new Float32Array(0),
    ghostCount: 0,
  };

  constructor(
    private readonly host: TreeHost,
    private readonly camera: Camera,
    private readonly symmetric: () => boolean,
  ) {}

  get isDragging(): boolean {
    return this.drag !== null;
  }

  get hovered(): number {
    return this.hoverHit?.node ?? -1;
  }

  // --- settings -----------------------------------------------------------------

  setTool(tool: ArmatureToolKind): void {
    this.settings.tool = tool;
    if (tool !== 'draw') this.ghost = new Float32Array(0);
    this.emitSettings();
  }

  setPreview(on: boolean): void {
    this.settings.preview = on;
    this.emitSettings();
  }

  setBlend(blend: number): void {
    this.settings.blend = Math.min(1, Math.max(0, blend));
    this.emitSettings();
    this.events.emit('edited', undefined);
  }

  setResolution(cells: number): void {
    this.settings.resolution = Math.round(Math.min(256, Math.max(48, cells)));
    this.emitSettings();
  }

  private emitSettings(): void {
    this.events.emit('settings', { ...this.settings });
  }

  // --- input --------------------------------------------------------------------

  hover(x: number, y: number): void {
    if (this.drag) return;
    this.hoverHit = this.pick(x, y);
    this.ghost =
      this.settings.tool === 'draw' && this.hoverHit
        ? this.ghostFor(this.hoverHit)
        : new Float32Array(0);
  }

  clearHover(): void {
    if (this.drag) return;
    this.hoverHit = null;
    this.ghost = new Float32Array(0);
  }

  /** The spheres a Draw click on `hit` would create (so the ghost always matches). */
  ghostFor(hit: TreeHit): Float32Array {
    // Run the real edit on a throwaway copy and read back what it added.
    const t = cloneTree(this.host.tree);
    const sym = this.symmetric();
    const n =
      hit.kind === 'link'
        ? insertOnLink(t, hit.node, hit.s, sym)
        : addChild(
            t,
            hit.node,
            hit.x,
            hit.y,
            hit.z,
            t.spheres[hit.node * 4 + 3] * CHILD_SCALE,
            sym,
          );
    const m = t.mirror[n];
    const added = m >= 0 && m !== n ? [n, m] : [n];
    const out = new Float32Array(added.length * 4);
    added.forEach((i, k) => out.set(t.spheres.subarray(i * 4, i * 4 + 4), k * 4));
    return out;
  }

  /** Starts a drag at screen (x, y). Returns false if nothing was under the pointer. */
  begin(x: number, y: number, shift: boolean): boolean {
    const hit = this.pick(x, y);
    this.hoverHit = hit;
    if (!hit) return false;
    const t = this.host.tree;
    const sym = this.symmetric();
    this.before = cloneTree(t);
    this.changed = false;
    this.lastX = x;
    this.lastY = y;
    const depthOf = (i: number) =>
      this.camera.depthOf([t.spheres[i * 4], t.spheres[i * 4 + 1], t.spheres[i * 4 + 2]]);
    const tool = this.settings.tool;

    if (tool === 'delete') {
      if (hit.kind === 'sphere') this.changed = deleteNode(t, hit.node, sym);
      this.hoverHit = null;
      this.finish();
      return true;
    }

    if (tool === 'draw') {
      if (hit.kind === 'link') {
        const n = insertOnLink(t, hit.node, hit.s, sym);
        this.changed = true;
        this.drag = { kind: 'move', nodes: [n], depth: depthOf(n) };
      } else {
        const r = t.spheres[hit.node * 4 + 3] * CHILD_SCALE;
        const n = addChild(t, hit.node, hit.x, hit.y, hit.z, r, sym);
        this.changed = true;
        this.drag = {
          kind: 'grow',
          node: n,
          sx: x,
          sy: y,
          baseR: r,
          depth: this.camera.depthOf([hit.x, hit.y, hit.z]),
        };
      }
      this.events.emit('edited', undefined);
      return true;
    }

    // Move, scale and rotate act on a sphere (a link means its child).
    const node = hit.node;
    const nodes = shift || tool === 'rotate' ? subtree(t, node) : [node];
    if (tool === 'move') this.drag = { kind: 'move', nodes, depth: depthOf(node) };
    else if (tool === 'scale') this.drag = { kind: 'scale', nodes, node };
    else {
      const p = t.parent[node];
      if (p < 0) {
        this.before = null;
        return true; // the root has nothing to turn around
      }
      const pivot: [number, number, number] = [
        t.spheres[p * 4],
        t.spheres[p * 4 + 1],
        t.spheres[p * 4 + 2],
      ];
      const [px, py] = this.camera.worldToScreen(pivot);
      this.drag = { kind: 'rotate', nodes, pivot, last: Math.atan2(y - py, x - px) };
    }
    return true;
  }

  move(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    const t = this.host.tree;
    const sym = this.symmetric();
    const dxPx = x - this.lastX,
      dyPx = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    const { right, up, forward } = this.camera.basis();

    if (d.kind === 'grow') {
      const dist = Math.hypot(x - d.sx, y - d.sy);
      if (dist < DRAG_THRESHOLD_PX) return;
      const r = Math.max(d.baseR * 0.15, dist * this.camera.worldPerPixel(d.depth));
      const i = d.node * 4;
      setSphere(t, d.node, t.spheres[i], t.spheres[i + 1], t.spheres[i + 2], r, sym);
    } else if (d.kind === 'move') {
      const s = this.camera.worldPerPixel(d.depth);
      const mx = (right[0] * dxPx - up[0] * dyPx) * s,
        my = (right[1] * dxPx - up[1] * dyPx) * s,
        mz = (right[2] * dxPx - up[2] * dyPx) * s;
      translateNodes(t, d.nodes, mx, my, mz, sym);
    } else if (d.kind === 'scale') {
      const f = Math.exp((dxPx - dyPx) * 0.01);
      const i = d.node * 4;
      scaleNodes(t, d.nodes, t.spheres[i], t.spheres[i + 1], t.spheres[i + 2], f, sym);
    } else {
      const [px, py] = this.camera.worldToScreen(d.pivot);
      const a = Math.atan2(y - py, x - px);
      let delta = a - d.last;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      d.last = a;
      // Screen angles grow clockwise; a clockwise turn on screen is a positive
      // rotation about the view direction.
      rotateNodes(
        t,
        d.nodes,
        d.pivot[0],
        d.pivot[1],
        d.pivot[2],
        forward[0],
        forward[1],
        forward[2],
        delta,
        sym,
      );
    }
    this.changed = true;
    this.events.emit('edited', undefined);
  }

  end(): void {
    if (!this.before) return;
    this.finish();
  }

  /** Deletes the sphere under the pointer (the Delete key). */
  deleteHovered(): boolean {
    const hit = this.hoverHit;
    if (this.drag || !hit || hit.kind !== 'sphere') return false;
    const before = cloneTree(this.host.tree);
    if (!deleteNode(this.host.tree, hit.node, this.symmetric())) return false;
    this.hoverHit = null;
    this.host.commitTree(before);
    this.events.emit('edited', undefined);
    return true;
  }

  /** Re-picks after the tree was replaced (undo/redo). */
  treeReplaced(): void {
    this.drag = null;
    this.before = null;
    this.hoverHit = null;
    this.ghost = new Float32Array(0);
  }

  // --- drawing ------------------------------------------------------------------

  /** Instance data for the renderer. */
  overlay(xray: boolean): ArmatureOverlay {
    const t = this.host.tree;
    const o = this.overlayData;
    if (o.spheres.length < t.count * 4) {
      o.spheres = new Float32Array(t.count * 8);
      o.colors = new Float32Array(t.count * 8);
      o.links = new Float32Array(t.count * 16);
    }
    o.spheres.set(t.spheres.subarray(0, t.count * 4));
    const hovered = this.hoverHit?.node ?? -1;
    const active = this.drag ? this.activeNode(this.drag) : -1;
    for (let i = 0; i < t.count; i++) {
      const c =
        i === active
          ? COLOR_ACTIVE
          : i === hovered && this.hoverHit?.kind === 'sphere'
            ? COLOR_HOVER
            : isOnPlane(t, i)
              ? COLOR_PLANE
              : COLOR;
      o.colors.set([c[0], c[1], c[2], 1], i * 4);
    }
    let l = 0;
    for (let i = 1; i < t.count; i++) {
      const p = t.parent[i];
      o.links.set(t.spheres.subarray(p * 4, p * 4 + 4), l * 8);
      o.links.set(t.spheres.subarray(i * 4, i * 4 + 4), l * 8 + 4);
      l++;
    }
    o.count = t.count;
    o.linkCount = l;
    o.xray = xray;
    // No ghost while dragging: the new sphere is real by then.
    const showGhost = !this.drag && this.settings.tool === 'draw';
    o.ghosts = this.ghost;
    o.ghostCount = showGhost ? this.ghost.length / 4 : 0;
    return o;
  }

  // --- internals ----------------------------------------------------------------

  private activeNode(d: Drag): number {
    if (d.kind === 'grow') return d.node;
    if (d.kind === 'scale') return d.node;
    return d.nodes[0];
  }

  private finish(): void {
    const before = this.before;
    this.drag = null;
    this.before = null;
    if (before && this.changed) this.host.commitTree(before);
    this.changed = false;
    this.events.emit('edited', undefined);
  }

  private pick(x: number, y: number): TreeHit | null {
    const { origin, dir } = this.camera.rayAt(x, y);
    return pickTree(this.host.tree, origin[0], origin[1], origin[2], dir[0], dir[1], dir[2]);
  }
}
