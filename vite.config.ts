import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [svelte()],
  // Cross-origin isolation, so SharedArrayBuffer is available (docs/multires.md).
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
