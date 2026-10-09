import { multiply, perspective, viewFromBasis, type Vec3 } from '../core/math';

export interface Ray {
  origin: Vec3;
  /** Unit length. */
  dir: Vec3;
}

/**
 * Turntable camera: yaw around world Y, then pitch around the camera's right
 * axis. Pitch is unclamped, so the view can tumble over the top like Maya.
 */
export class Camera {
  target: Vec3 = [0, 0, 0];
  distance = 3.5;
  yaw = 0.6;
  pitch = -0.35;
  fovY = (40 * Math.PI) / 180;
  widthPx = 1;
  heightPx = 1;

  get aspect(): number {
    return this.widthPx / this.heightPx;
  }

  /** Camera basis: right, up, forward (eye -> target). */
  basis(): { eye: Vec3; right: Vec3; up: Vec3; forward: Vec3 } {
    const cy = Math.cos(this.yaw),
      sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch),
      sp = Math.sin(this.pitch);
    // R = Ry(yaw) * Rx(pitch) applied to the camera-space axes.
    const right: Vec3 = [cy, 0, -sy];
    const up: Vec3 = [sy * sp, cp, cy * sp];
    const back: Vec3 = [sy * cp, -sp, cy * cp];
    const forward: Vec3 = [-back[0], -back[1], -back[2]];
    const t = this.target;
    const eye: Vec3 = [
      t[0] + back[0] * this.distance,
      t[1] + back[1] * this.distance,
      t[2] + back[2] * this.distance,
    ];
    return { eye, right, up, forward };
  }

  viewProj(): Float32Array {
    const { eye, right, up, forward } = this.basis();
    const near = this.distance * 0.01;
    const far = this.distance * 100;
    return multiply(
      perspective(this.fovY, this.aspect, near, far),
      viewFromBasis(eye, right, up, forward),
    );
  }

  /** World ray through a point in CSS pixels relative to the viewport's top-left. */
  rayAt(px: number, py: number): Ray {
    const { eye, right, up, forward } = this.basis();
    const tanHalf = Math.tan(this.fovY / 2);
    const sx = ((px / this.widthPx) * 2 - 1) * tanHalf * this.aspect;
    const sy = (1 - (py / this.heightPx) * 2) * tanHalf;
    const d: Vec3 = [
      forward[0] + right[0] * sx + up[0] * sy,
      forward[1] + right[1] * sx + up[1] * sy,
      forward[2] + right[2] * sx + up[2] * sy,
    ];
    const len = Math.hypot(d[0], d[1], d[2]);
    return { origin: eye, dir: [d[0] / len, d[1] / len, d[2] / len] };
  }

  /** CSS-pixel screen position of a world point (in front of the camera). */
  worldToScreen(p: Vec3): [number, number] {
    const { eye, right, up, forward } = this.basis();
    const dx = p[0] - eye[0],
      dy = p[1] - eye[1],
      dz = p[2] - eye[2];
    const depth = dx * forward[0] + dy * forward[1] + dz * forward[2];
    const tanHalf = Math.tan(this.fovY / 2);
    const sx = (dx * right[0] + dy * right[1] + dz * right[2]) / (depth * tanHalf * this.aspect);
    const sy = (dx * up[0] + dy * up[1] + dz * up[2]) / (depth * tanHalf);
    return [((sx + 1) / 2) * this.widthPx, ((1 - sy) / 2) * this.heightPx];
  }

  /** World units per CSS pixel at a given view depth. */
  worldPerPixel(depth: number): number {
    return (2 * depth * Math.tan(this.fovY / 2)) / this.heightPx;
  }

  /** View depth (along forward) of a world point. */
  depthOf(p: Vec3): number {
    const { eye, forward } = this.basis();
    return (
      (p[0] - eye[0]) * forward[0] + (p[1] - eye[1]) * forward[1] + (p[2] - eye[2]) * forward[2]
    );
  }

  orbit(dxPx: number, dyPx: number): void {
    this.yaw -= dxPx * 0.006;
    this.pitch -= dyPx * 0.006;
  }

  pan(dxPx: number, dyPx: number): void {
    const { right, up } = this.basis();
    const s = this.worldPerPixel(this.distance);
    for (let i = 0; i < 3; i++) this.target[i] += (-right[i] * dxPx + up[i] * dyPx) * s;
  }

  /** Positive amount moves closer. */
  dolly(amount: number): void {
    this.distance = Math.min(1e4, Math.max(1e-3, this.distance * Math.exp(-amount)));
  }

  /** Fits a bounding sphere in view, keeping the current orientation. */
  frame(center: Vec3, radius: number): void {
    this.target = [center[0], center[1], center[2]];
    const halfFov = Math.min(this.fovY / 2, Math.atan(Math.tan(this.fovY / 2) * this.aspect));
    this.distance = (radius / Math.sin(halfFov)) * 1.1;
  }
}
