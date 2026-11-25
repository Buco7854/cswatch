import { build, createServer, preview } from '../../frontend/node_modules/vite/dist/node/index.js';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
function mapFiles(directory, mbit, downloads) {
  let available = 0;
  async function* limited(path) {
    for await (const chunk of createReadStream(path, { highWaterMark: 32768 })) {
      available = Math.max(available, performance.now()) + (chunk.length * 8) / (mbit * 1000);
      await delay(Math.max(0, available - performance.now()));
      yield chunk;
    }
  }
  return (server) => {
    server.middlewares.use('/world-data', async (req, res) => {
      const name = req.url?.slice(1);
      if (
        req.method !== 'GET' ||
        !name ||
        !(name === 'map.json' || /^[a-f0-9]{64}\.bin$/.test(name))
      ) {
        res.statusCode = 404;
        res.end();
        return;
      }
      try {
        let path = join(directory, name);
        res.setHeader('Vary', 'Accept-Encoding');
        const acceptsBrotli = String(req.headers['accept-encoding'] ?? '')
          .split(',')
          .some((token) => /^br(?:\s*;\s*q=(?!0(?:\.0*)?$)[\d.]+)?$/i.test(token.trim()));
        if (acceptsBrotli && (await lstat(path + '.br').catch(() => null))?.isFile()) {
          path += '.br';
          res.setHeader('Content-Encoding', 'br');
        }
        const st = await lstat(path);
        if (!st.isFile()) throw Error();
        res.setHeader('Content-Length', st.size);
        res.setHeader(
          'Content-Type',
          name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        );
        res.once('finish', () => downloads.push({ name, bytes: st.size }));
        (mbit ? Readable.from(limited(path)) : createReadStream(path))
          .on('error', () => res.destroy())
          .pipe(res);
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
  };
}
export async function serve(directory, port = 0, production = false, mbit = 0) {
  const downloads = [];
  const mount = mapFiles(directory, mbit, downloads),
    options = { host: '127.0.0.1', port, strictPort: true };
  const config = {
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    plugins: [{ name: 'native-world-lab', configureServer: mount, configurePreviewServer: mount }],
  };
  let server, buildDir;
  try {
    if (production) {
      buildDir = await mkdtemp(join(tmpdir(), 'cswatch-world-lab-'));
      const isolated = {
        ...config,
        build: {
          outDir: buildDir,
          emptyOutDir: true,
          rollupOptions: { input: join(root, 'world-lab.html') },
        },
      };
      await build(isolated);
      server = await preview({ ...isolated, preview: options });
    } else {
      server = await createServer({ ...config, server: options });
      await server.listen();
    }
  } catch (error) {
    if (buildDir) await rm(buildDir, { recursive: true });
    throw error;
  }
  return {
    downloads,
    url: `http://127.0.0.1:${server.httpServer.address().port}/world-lab.html?map=/world-data/`,
    close: async () => {
      try {
        await server.close();
      } finally {
        if (buildDir) await rm(buildDir, { recursive: true });
      }
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await serve(resolve(process.argv[2]), Number(process.argv[3]) || 4198);
  console.log(server.url);
}
