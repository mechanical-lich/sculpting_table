import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [svelte()],
  // Relative asset paths, so the build works under any subpath
  // (GitHub Pages project sites serve from /<repo-name>/).
  base: './',
  // Cross-origin isolation, so SharedArrayBuffer is available (docs/multires.md).
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
