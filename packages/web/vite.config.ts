import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const hub = `http://127.0.0.1:${process.env.AGENTCHAT_PORT ?? 4317}`;

export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: hub, changeOrigin: true },
      // The hub checks Origin on /ws, so present the hub's own origin through the dev proxy.
      '/ws': { target: hub.replace('http', 'ws'), ws: true, changeOrigin: true, headers: { origin: hub } },
    },
  },
});
