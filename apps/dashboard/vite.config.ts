import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `base: './'` plus viteSingleFile() is what makes `dist/index.html` open from
// file:// with no server — the MVP's demo fallback requirement (CLAUDE.md §6).
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Proxying in dev means CORS is never the dashboard's problem, and Dev B's
      // findings API can be Node or Python without a change here.
      //
      // '/api' AND NOT '/api/healthscan' -- the narrower prefix left every MVP 2 endpoint
      // (/api/earlywarning, /api/investigate, /api/resolve) unproxied, so Vite served index.html
      // for them and a GET looked like a 200. Same defect as the nginx template had; both were
      // written when /api/healthscan/* was the only family. One prefix, because the engine owns
      // everything under /api and 404s what it does not have -- listing endpoints here would be a
      // second copy of its routing table, which is how this broke in the first place.
      '/api': {
        target: process.env.VITE_HEALTHSCAN_TARGET ?? 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Inlining everything is the point of the single-file fallback; silence the
    // expected "chunk larger than 500 kB" advice.
    chunkSizeWarningLimit: 4096,
  },
});
