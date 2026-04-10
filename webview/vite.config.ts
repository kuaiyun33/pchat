import path from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  /** Webview 非站点根路径，必须用相对资源 URL，否则 boxicons 等字体 404、图标空白。 */
  base: './',
  plugins: [preact()],
  root,
  build: {
    outDir: path.resolve(root, '../dist/webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(root, 'index.html'),
      output: {
        entryFileNames: 'webview.js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: (info) => {
          if (info.names?.some((n) => n.endsWith('.css'))) {
            return 'assets/webview.css';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
});
