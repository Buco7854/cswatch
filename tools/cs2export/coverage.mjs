// Radar coverage: the share of the official radar's playable pixels that a top-down orthographic
// material-ID render of the pack covers, with the 3D sky and fog off.
// node coverage.mjs <map-dir> <overview-dir> <out-dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from '../../frontend/node_modules/pngjs/lib/png.js';

const SIZE = 1024;

/** The lab pose that frames Valve's overview calibration in a SIZE-pixel square. */
export function coveragePose(manifest, overview) {
  const half = (overview.referenceSize / 2) * overview.scale;
  return {
    name: 'coverage',
    pos: [overview.origin.x + half, overview.origin.y - half, manifest.bounds[5] + 512],
    // Straight down with the radar's north up; 0.1 degree keeps the look-at basis defined.
    ang: [89.9, 90],
    fov: 73.74,
    ortho: half,
    view: 7,
    skybox3D: false,
    fog: false,
  };
}

// Some radars are transparent outside the map, others are opaque with a flat backdrop: the colour
// most common along the image border, within a small tolerance, is background too.
function backdrop(radar) {
  const counts = new Map();
  const at = (x, y) => (y * radar.width + x) * 4;
  for (let i = 0; i < radar.width; i++)
    for (const index of [
      at(i, 0),
      at(i, radar.height - 1),
      at(0, i % radar.height),
      at(radar.width - 1, i % radar.height),
    ]) {
      if (radar.data[index + 3] <= 128) continue;
      const key = [0, 1, 2].map((c) => radar.data[index + c] >> 3).join();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] > radar.width ? top[0].split(',').map((v) => Number(v) * 8 + 4) : undefined;
}

/**
 * Playable radar pixels are opaque and not the backdrop; covered render pixels carry a material ID.
 * Near-black radar pixels mark solid walls and closed blocks, which Valve's compiled worlds can
 * leave hollow and unfloored (de_cbble's interiors have neither render nor collision surfaces), so
 * they are counted apart as `solid`.
 */
export function radarCoverage(radar, render) {
  const background = backdrop(radar);
  const output = new PNG({ width: radar.width, height: radar.height });
  let playable = 0,
    covered = 0,
    solid = 0;
  for (let y = 0; y < radar.height; y++)
    for (let x = 0; x < radar.width; x++) {
      const i = (y * radar.width + x) * 4;
      const rx = Math.min(render.width - 1, Math.floor(((x + 0.5) * render.width) / radar.width)),
        ry = Math.min(render.height - 1, Math.floor(((y + 0.5) * render.height) / radar.height));
      const hit = render.data[(ry * render.width + rx) * 4 + 2] > 200;
      const opaque =
        radar.data[i + 3] > 128 &&
        !(background && [0, 1, 2].every((c) => Math.abs(radar.data[i + c] - background[c]) <= 12));
      const black = opaque && Math.max(radar.data[i], radar.data[i + 1], radar.data[i + 2]) < 24;
      const play = opaque && !black;
      if (black) solid++;
      if (play) playable++;
      if (play && hit) covered++;
      const grey = (radar.data[i] + radar.data[i + 1] + radar.data[i + 2]) / 3;
      output.data.set(
        play
          ? hit
            ? [grey, grey, grey, 255]
            : [255, 0, 255, 255]
          : hit
            ? [32, 40, 64, 255]
            : [0, 0, 0, 255],
        i,
      );
    }
  return {
    playable,
    covered,
    solid,
    percent: playable ? +((100 * covered) / playable).toFixed(2) : null,
    png: PNG.sync.write(output),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [map, overviewDir, out] = process.argv.slice(2);
  if (!map || !overviewDir || !out)
    throw Error('Usage: coverage.mjs <map-dir> <overview-dir> <out-dir>');
  mkdirSync(out, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(map, 'map.json'), 'utf8'));
  const overview = JSON.parse(readFileSync(join(overviewDir, 'overview.json'), 'utf8'));
  const poses = join(out, 'coverage-pose.json');
  writeFileSync(poses, JSON.stringify([coveragePose(manifest, overview)]));
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('./capture.mjs', import.meta.url)),
      map,
      out,
      poses,
      String(SIZE),
      String(SIZE),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], timeout: 900000 },
  );
  const result = radarCoverage(
    PNG.sync.read(readFileSync(join(overviewDir, 'overview.png'))),
    PNG.sync.read(readFileSync(join(out, `coverage-${SIZE}x${SIZE}.png`))),
  );
  writeFileSync(join(out, 'coverage.png'), result.png);
  const summary = {
    map: manifest.map,
    playable: result.playable,
    covered: result.covered,
    solid: result.solid,
    percent: result.percent,
  };
  writeFileSync(join(out, 'coverage.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
