import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const serverUrl = process.env.SUPER_VOX_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  resolve: {
    conditions: ['source'],
  },
  build: {
    rollupOptions: {
      // The game, and the world generator page (/generator.html).
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        generator: fileURLToPath(new URL('./generator.html', import.meta.url)),
      },
    },
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
