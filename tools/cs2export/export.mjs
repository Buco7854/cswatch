// Local development export. The assets worker runs the same stages as separate confined children.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    game: { type: 'string' },
    map: { type: 'string' },
    manifest: { type: 'string' },
    out: { type: 'string' },
    source: { type: 'string' },
    astcenc: { type: 'string', default: process.env.ASTCENC ?? '/opt/astcenc/astcenc' },
  },
});
const out = resolve(values.out ?? '');
if (!values.out || existsSync(out)) throw Error('Choose a new --out directory');
const stage = mkdtempSync(join(dirname(out), '.cs2export-'));
const time = {};
const step = (name, command, args) => {
  const start = performance.now();
  execFileSync(command, args, { stdio: 'inherit' });
  time[name] = Math.round(performance.now() - start);
};
try {
  let source = values.source && resolve(values.source);
  if (!source) {
    source = join(stage, 'source');
    mkdirSync(source);
    const vpk = join(values.game, 'csgo', 'maps', values.map + '.vpk');
    const sha256 = createHash('sha256').update(readFileSync(vpk)).digest('hex');
    step('extract', 'dotnet', [
      join(here, 'bin/Release/net11.0/cs2export.dll'),
      ...['--extract', '--game', values.game, '--map', values.map],
      ...['--manifest', values.manifest, '--sha256', sha256, '--out', source],
    ]);
  }
  const pack = join(stage, 'pack');
  mkdirSync(pack);
  step('desktop', process.execPath, [join(here, 'pack.mjs'), source, pack, stage]);
  step('phone-inputs', 'dotnet', [
    join(here, 'bin/Release/net11.0/cs2export.dll'),
    '--astc-inputs',
    join(stage, 'astc-plan.json'),
    source,
    join(stage, 'astc'),
  ]);
  const start = performance.now();
  for (const name of readdirSync(join(stage, 'astc')).filter((n) => n.endsWith('.tga'))) {
    const group = JSON.parse(readFileSync(join(stage, 'astc', 'layout.json'), 'utf8')).groups.find(
      (g) => g.name + '.tga' === name,
    );
    execFileSync(values.astcenc, [
      group.srgb ? '-cs' : '-cl',
      join(stage, 'astc', name),
      join(stage, 'astc', group.name + '.astc'),
      group.block.join('x'),
      '-medium',
      '-silent',
    ]);
  }
  time.astcenc = Math.round(performance.now() - start);
  step('finish', process.execPath, [join(here, 'finish.mjs'), pack, stage]);
  renameSync(pack, out);
  console.log(JSON.stringify({ timeMs: time }));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
