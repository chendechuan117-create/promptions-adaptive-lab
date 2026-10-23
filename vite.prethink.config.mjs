import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5193,
    strictPort: true,
    open: '/prethink.html',
  },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
  build: {
    outDir: path.join(root, 'dist-prethink'),
    emptyOutDir: false,
    rollupOptions: { input: path.join(root, 'prethink.html') },
  },
});
