import { defineConfig } from 'vite';

const serverUrl = process.env.SUPER_VOX_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  resolve: {
    conditions: ['source'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': serverUrl,
      '/ws': { target: serverUrl.replace(/^http/, 'ws'), ws: true },
    },
  },
});
