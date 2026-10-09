import { mount } from 'svelte';
import { Multires } from '../core/multires';
import { createQuadSphere } from '../core/quadSphere';
import { quadTopology } from '../core/subdivision';
import { createWebGPURenderer } from '../gpu/webgpuRenderer';
import App from '../ui/App.svelte';
import { loadKeyboardLayout } from '../ui/hotkeys';
import { AppController } from './controller';
import { SculptDocument } from './document';
import './style.css';

/** Starter: a 16-segment quad sphere (1,536 quads) at level 4 = 786,432 triangles. */
const STARTER_SEGMENTS = 16;
const STARTER_LEVELS = 4;

async function start(): Promise<void> {
  const root = document.getElementById('app')!;
  const canvas = document.createElement('canvas');
  canvas.className = 'viewport';
  root.appendChild(canvas);

  let renderer;
  try {
    renderer = await createWebGPURenderer(canvas);
  } catch (err) {
    showError(root, err instanceof Error ? err.message : String(err));
    return;
  }
  renderer.device.lost.then((info) => {
    if (info.reason !== 'destroyed') showError(root, `The GPU device was lost: ${info.message}`);
  });

  const sphere = createQuadSphere(STARTER_SEGMENTS);
  const multires = new Multires(
    quadTopology(sphere.quads, sphere.positions.length / 3),
    sphere.positions,
  );
  for (let i = 0; i < STARTER_LEVELS; i++) multires.addLevel();
  const controller = new AppController(canvas, renderer, new SculptDocument(multires));

  void loadKeyboardLayout();
  mount(App, { target: root, props: { controller } });

  if (import.meta.hot) import.meta.hot.dispose(() => controller.destroy());
  // Debug handle for the console in dev builds.
  if (import.meta.env.DEV) (window as unknown as { app: AppController }).app = controller;
}

function showError(root: HTMLElement, message: string): void {
  const el = document.createElement('div');
  el.className = 'fatal';
  el.innerHTML = `<h1>Can't start Sculpting Table</h1><p></p>
    <p>Sculpting Table needs WebGPU: a recent Chrome, Edge or Safari, or Firefox with WebGPU enabled.</p>`;
  el.querySelector('p')!.textContent = message;
  root.replaceChildren(el);
}

void start();
