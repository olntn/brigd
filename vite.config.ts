import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// One PORT variable moves both the API server and this proxy, so a second
// checkout can run next to an existing brigd without editing files.
const apiPort = Number(process.env.PORT ?? 4310);

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } }
  },
  build: { target: 'es2022' }
});
