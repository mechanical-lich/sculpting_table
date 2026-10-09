import type { Mesh } from '../core/mesh';
import type { Stamp } from '../core/stamp';

export interface BrushOverlay {
  /** World-space center and radius; radius <= 0 hides it. */
  x: number;
  y: number;
  z: number;
  radius: number;
  mirror: boolean;
  active: boolean;
  inverted: boolean;
  smoothing: boolean;
}

/** Screen-space stencil overlay, in framebuffer pixels. */
export interface StencilOverlay {
  centerX: number;
  centerY: number;
  halfSize: number;
  /** Clockwise, radians. */
  angle: number;
  opacity: number;
  tile: boolean;
}

/** An armature to draw. Arrays may be longer than the counts. */
export interface ArmatureOverlay {
  /** x, y, z, radius per sphere. */
  spheres: Float32Array;
  /** r, g, b, a per sphere. */
  colors: Float32Array;
  /** a.xyz, ra, b.xyz, rb per link. */
  links: Float32Array;
  count: number;
  linkCount: number;
  /** Draw see-through on top of everything (over a skin preview or a sculpt). */
  xray: boolean;
  /** Translucent "what a click would add" spheres: x, y, z, radius each. */
  ghosts: Float32Array;
  ghostCount: number;
}

export interface FrameParams {
  viewProj: Float32Array;
  eye: ArrayLike<number>;
  /** Unit directions toward the lights, in world space. */
  keyLight: ArrayLike<number>;
  fillLight: ArrayLike<number>;
  brush: BrushOverlay | null;
  /** Drawn only when an image was set with `setStencilImage`. */
  stencil: StencilOverlay | null;
  /** Draw the line where the surface crosses the X-symmetry plane. */
  symmetryX: boolean;
  /** Draw the mesh set with `setMesh` (off while editing the armature without a preview). */
  showMesh: boolean;
  armature: ArmatureOverlay | null;
}

/**
 * The rendering backend. Kept small so a WebGL2 implementation can be added
 * later without touching tools or UI.
 */
export interface Renderer {
  setMesh(mesh: Mesh): void;
  /** Marks vertices whose position and normal changed; uploaded on the next render. */
  markDirty(vertices: Uint32Array): void;
  resize(widthPx: number, heightPx: number): void;
  /** The image the stencil overlay shows, or null for none. */
  setStencilImage(image: Stamp | null): void;
  render(frame: FrameParams): void;
  destroy(): void;
}
