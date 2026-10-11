import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  /* Relative asset URLs: the same build works at the repository root and under
   * the `/<repository>/` path GitHub Pages serves a project site from. */
  base: './',
  plugins: [react()],
  /* hamlib-web is a linked workspace package: bundling it would break the
   * `new URL(..., import.meta.url)` wasm lookup, so let Vite serve it as is. */
  optimizeDeps: {
    exclude: ['hamlib-web'],
  },
  build: {
    target: 'es2022',
  },
  /* Bind explicitly: `localhost` resolves to ::1 on Node 17+, which makes the
   * documented 127.0.0.1 URL unreachable for tests and users alike. */
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4175,
    strictPort: true,
  },
});
