import { readFileSync } from 'node:fs';
import { PNG } from '../../frontend/node_modules/pngjs/lib/png.js';

// RGB display levels. An outlier pixel has at least one channel more than eight levels apart.
const [beforePath, afterPath, ...region] = process.argv.slice(2);
const [before, after] = [beforePath, afterPath].map((path) => PNG.sync.read(readFileSync(path)));
if (before.width !== after.width || before.height !== after.height)
  throw Error('Image sizes differ');
const [left, top, width, height] = region.length
  ? region.map(Number)
  : [0, 0, before.width, before.height];
if (
  ![left, top, width, height].every(Number.isSafeInteger) ||
  left < 0 ||
  top < 0 ||
  width < 1 ||
  height < 1 ||
  left + width > before.width ||
  top + height > before.height
)
  throw Error('Invalid patch bounds');
let difference = 0,
  outliers = 0,
  changed = 0;
const original = [0, 0, 0],
  revised = [0, 0, 0],
  pixels = width * height;
for (let y = top; y < top + height; y++)
  for (let x = left; x < left + width; x++) {
    const index = 4 * (y * before.width + x);
    let maximum = 0;
    for (let channel = 0; channel < 3; channel++) {
      const a = before.data[index + channel],
        b = after.data[index + channel];
      original[channel] += a;
      revised[channel] += b;
      const delta = Math.abs(a - b);
      difference += delta;
      maximum = Math.max(maximum, delta);
    }
    changed += Number(maximum > 0);
    outliers += Number(maximum > 8);
  }
console.log(
  JSON.stringify({
    before: original.map((sum) => sum / pixels),
    after: revised.map((sum) => sum / pixels),
    changed,
    meanAbsoluteDifference: difference / (pixels * 3),
    percentOver8: (outliers * 100) / pixels,
  }),
);
