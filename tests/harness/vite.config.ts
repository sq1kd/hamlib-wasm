import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['hamlib-web'],
  },
  build: {
    target: 'es2022',
    /* Two pages: the package-on-window harness the transport specs drive, and
     * the hook harness the connection-cancellation specs drive. */
    rollupOptions: {
      input: {
        index: 'index.html',
        hooks: 'hooks.html',
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
});
