// Local development export. The assets worker runs the same stages as separate confined children.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
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
  const exporter = join(here, 'bin/Release/net11.0/cs2export.dll'),
    plan = join(stage, 'astc-plan.json'),
    astc = join(stage, 'astc');
  step('phone-inputs', 'dotnet', [exporter, '--astc-inputs', plan, source, astc]);
  const layout = JSON.parse(readFileSync(join(astc, 'layout.json'), 'utf8'));
  let start = performance.now();
  time.phoneGroups = 0;
  time.astcenc = 0;
  for (const [index, group] of layout.groups.entries()) {
    execFileSync('dotnet', [exporter, '--astc-group', plan, source, astc, String(index)]);
    time.phoneGroups += performance.now() - start;
    start = performance.now();
    execFileSync(values.astcenc, [
      group.srgb ? '-cs' : '-cl',
      join(astc, group.name + '.tga'),
      join(astc, group.name + '.astc'),
      group.block.join('x'),
      '-medium',
      '-silent',
    ]);
    rmSync(join(astc, group.name + '.tga'));
    time.astcenc += performance.now() - start;
    start = performance.now();
  }
  time.phoneGroups = Math.round(time.phoneGroups);
  time.astcenc = Math.round(time.astcenc);
  step('finish', process.execPath, [join(here, 'finish.mjs'), pack, stage]);
  renameSync(pack, out);
  console.log(JSON.stringify({ timeMs: time }));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
