import { describe, expect, it } from 'vitest';
import { addChild, cloneTree, createTree, type Armature } from '../core/armature/tree';
import { ArmatureTool } from './armatureTool';
import { Camera } from './camera';

function setup(symmetric = true) {
  const tree = createTree(0, 0, 0, 1);
  const host = {
    tree,
    commits: 0,
    commitTree() {
      this.commits++;
    },
  };
  const camera = new Camera();
  camera.widthPx = 800;
  camera.heightPx = 600;
  camera.target = [0, 0, 0];
  camera.distance = 6;
  camera.yaw = 0;
  camera.pitch = 0;
  const tool = new ArmatureTool(host, camera, () => symmetric);
  return { host, camera, tool };
}

/** Hovers at a world point's screen position and returns the ghost spheres. */
function hoverAt(tool: ArmatureTool, camera: Camera, p: [number, number, number]) {
  const [x, y] = camera.worldToScreen(p);
  tool.hover(x, y);
  const o = tool.overlay(false);
  return { x, y, ghosts: Array.from(o.ghosts.subarray(0, o.ghostCount * 4)) };
}

/** Spheres present after the click that weren't before, as sorted rows. */
function added(before: Armature, after: Armature): number[][] {
  const key = (t: Armature, i: number) =>
    Array.from(t.spheres.subarray(i * 4, i * 4 + 4)).join(',');
  const old = new Set(Array.from({ length: before.count }, (_, i) => key(before, i)));
  const rows: number[][] = [];
  for (let i = 0; i < after.count; i++) {
    if (!old.has(key(after, i))) rows.push(Array.from(after.spheres.subarray(i * 4, i * 4 + 4)));
  }
  return rows.sort((a, b) => a[0] - b[0]);
}

const rows = (flat: number[]) =>
  Array.from({ length: flat.length / 4 }, (_, k) => flat.slice(k * 4, k * 4 + 4)).sort(
    (a, b) => a[0] - b[0],
  );

describe('Draw ghost', () => {
  it('matches the mirrored pair a click adds', () => {
    const { host, camera, tool } = setup();
    const p: [number, number, number] = [0.5, 0.3, Math.sqrt(1 - 0.34)];
    const { x, y, ghosts } = hoverAt(tool, camera, p);
    expect(ghosts.length).toBe(8);
    const before = cloneTree(host.tree);
    tool.begin(x, y, false);
    tool.end();
    expect(host.commits).toBe(1);
    const real = added(before, host.tree);
    const ghost = rows(ghosts);
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < 4; k++) expect(ghost[i][k]).toBeCloseTo(real[i][k], 5);
    }
  });

  it('shows a single ghost on the center line when a click would snap there', () => {
    const { tool, camera } = setup();
    const { ghosts } = hoverAt(tool, camera, [0.02, 0.2, Math.sqrt(1 - 0.0404)]);
    expect(ghosts.length).toBe(4);
    expect(ghosts[0]).toBe(0);
  });

  it('previews an insert on a link', () => {
    const { host, tool, camera } = setup();
    addChild(host.tree, 0, 1.5, 3, 0, 0.6, true); // a mirrored pair of links
    const { x, y, ghosts } = hoverAt(tool, camera, [0.75, 1.5, 0.2]);
    expect(ghosts.length).toBe(8);
    const before = cloneTree(host.tree);
    tool.begin(x, y, false);
    tool.end();
    const real = added(before, host.tree);
    const ghost = rows(ghosts);
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < 4; k++) expect(ghost[i][k]).toBeCloseTo(real[i][k], 5);
    }
  });

  it('shows nothing with other tools or over empty space', () => {
    const { tool, camera } = setup();
    hoverAt(tool, camera, [5, 5, 0]);
    expect(tool.overlay(false).ghostCount).toBe(0);
    tool.setTool('move');
    hoverAt(tool, camera, [0, 0, 1]);
    expect(tool.overlay(false).ghostCount).toBe(0);
  });
});
