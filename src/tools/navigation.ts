import type { Camera } from './camera';

export type NavAction = 'orbit' | 'pan' | 'dolly';

/**
 * Maps a pointer-down to a camera action. Presets are tables so more styles
 * (e.g. a no-modifier pen preset) can be added without touching the
 * controller.
 */
export interface NavPreset {
  name: string;
  /** Returns the action for this pointer-down, or null to let the tool have it. */
  match(e: {
    button: number;
    altKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  }): NavAction | null;
}

/** Mudbox/Maya default: Alt + LMB orbit, Alt + MMB pan, Alt + RMB dolly. */
export const MUDBOX_NAV: NavPreset = {
  name: 'Mudbox',
  match(e) {
    if (!e.altKey) return null;
    if (e.button === 0) return 'orbit';
    if (e.button === 1) return 'pan';
    if (e.button === 2) return 'dolly';
    return null;
  },
};

export function applyNavDrag(camera: Camera, action: NavAction, dx: number, dy: number): void {
  if (action === 'orbit') camera.orbit(dx, dy);
  else if (action === 'pan') camera.pan(dx, dy);
  // Drag right or down to move in, as in Maya.
  else camera.dolly((dx + dy) * 0.005);
}

export function applyWheel(camera: Camera, deltaY: number, deltaMode: number): void {
  // Normalize line/page deltas to roughly pixels.
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  camera.dolly(-px * 0.0015);
}
