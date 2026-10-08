import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const serverUrl = process.env.SUPER_VOX_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  resolve: {
    conditions: ['source'],
  },
  build: {
    rollupOptions: {
      // The entry page, the game (/play.html), the world generator (/generator.html), world
      // management (/worlds.html; /dashboard.html sends there), the castle site finder (/sites.html), the terraformer
      // (/terraform.html), the object designer (/designer.html), claims (/claim.html), settings
      // (/settings.html) and players (/players.html: admins).
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        play: fileURLToPath(new URL('./play.html', import.meta.url)),
        generator: fileURLToPath(new URL('./generator.html', import.meta.url)),
        dashboard: fileURLToPath(new URL('./dashboard.html', import.meta.url)),
        worlds: fileURLToPath(new URL('./worlds.html', import.meta.url)),
        sites: fileURLToPath(new URL('./sites.html', import.meta.url)),
        terraform: fileURLToPath(new URL('./terraform.html', import.meta.url)),
        designer: fileURLToPath(new URL('./designer.html', import.meta.url)),
        claim: fileURLToPath(new URL('./claim.html', import.meta.url)),
        settings: fileURLToPath(new URL('./settings.html', import.meta.url)),
        players: fileURLToPath(new URL('./players.html', import.meta.url)),
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
