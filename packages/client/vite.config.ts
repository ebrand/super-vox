import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const serverUrl = process.env.SUPER_VOX_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  resolve: {
    conditions: ['source'],
  },
  build: {
    rollupOptions: {
      // The entry page, the game (/play.html), the world generator (/generator.html) and the
      // dashboard (/dashboard.html).
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        play: fileURLToPath(new URL('./play.html', import.meta.url)),
        generator: fileURLToPath(new URL('./generator.html', import.meta.url)),
        dashboard: fileURLToPath(new URL('./dashboard.html', import.meta.url)),
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
