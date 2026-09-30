import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['hamlib-web'],
  },
  build: {
    target: 'es2022',
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
});
