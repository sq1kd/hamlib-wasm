import { defineConfig } from 'vite';

export default defineConfig({
  /* hamlib-wasm is a linked workspace package: bundling it would break the
   * `new URL(..., import.meta.url)` wasm lookup, so let Vite serve it as is. */
  optimizeDeps: {
    exclude: ['hamlib-wasm'],
  },
  build: {
    target: 'es2022',
  },
  /* Bind explicitly: `localhost` resolves to ::1 on Node 17+, which makes the
   * documented 127.0.0.1 URL unreachable for tests and users alike. */
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
