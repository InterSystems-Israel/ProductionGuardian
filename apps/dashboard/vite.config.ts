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
      '/api/healthscan': {
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
