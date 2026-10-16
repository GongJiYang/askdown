import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Tauri expects a fixed port and must not clear the terminal it prints Rust errors to.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), viteStaticCopy({
    targets: ['cmaps', 'standard_fonts', 'wasm', 'iccs'].map((directory) => ({
      src: `node_modules/pdfjs-dist/${directory}/*`,
      dest: `pdfjs/${directory}`,
      rename: { stripBase: true },
    })),
  })],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    manifest: true,
  },
});
