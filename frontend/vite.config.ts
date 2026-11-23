import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Let the viewer's dynamic Scene import keep renderer dependencies out of the app entry.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'precompress-app-assets',
      apply: 'build',
      enforce: 'post',
      writeBundle({ dir }, bundle) {
        if (!dir) return;
        for (const output of Object.values(bundle)) {
          if (!/\.(?:js|css)$/.test(output.fileName)) continue;
          // Vite resolves preload dependencies after generating the entry chunk.
          const path = join(dir, output.fileName);
          const source = readFileSync(path);
          writeFileSync(
            path + '.br',
            brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
          );
          writeFileSync(path + '.gz', gzipSync(source));
        }
      },
    },
  ],
  server: {
    proxy: { '/api': 'http://localhost:8000', '/map-assets': 'http://localhost:8000' },
  },
});
