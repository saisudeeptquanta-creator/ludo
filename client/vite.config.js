import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(__dirname, '..', 'server', 'src', 'game-engine');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // The board geometry is imported straight from the server's engine so the
      // renderer and the rules can never disagree about where a square is.
      '@engine': ENGINE_DIR,
    },
  },
  server: {
    port: 5173,
    // Bind all interfaces so the app can be opened from a phone on the same
    // network. The server's origin policy allows private addresses in dev.
    host: true,
    fs: {
      // Permit importing the shared engine from outside the client root.
      allow: [path.resolve(__dirname, '..')],
    },
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          realtime: ['socket.io-client'],
        },
      },
    },
  },
});
