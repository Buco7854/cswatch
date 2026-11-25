// Phase two: page the phone ASTC payloads, then publish the manifest and Brotli siblings.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packFiles } from './pack-files.mjs';
import { precompress } from './precompress.mjs';

const [out, stage] = process.argv.slice(2);
if (!out || !stage) throw Error('Usage: finish.mjs <pack> <stage>');
const manifest = JSON.parse(readFileSync(join(stage, 'desktop.json'), 'utf8'));
const plan = JSON.parse(readFileSync(join(stage, 'astc-plan.json'), 'utf8'));
const layout = JSON.parse(readFileSync(join(stage, 'astc', 'layout.json'), 'utf8'));
const { files, addMip, flush } = packFiles(out, manifest.files);

const payloads = layout.groups.map((group) => {
  const bytes = readFileSync(join(stage, 'astc', group.name + '.astc'));
  const [bw, bh] = group.block;
  if (
    bytes.readUInt32LE(0) !== 0x5ca1ab13 ||
    bytes[4] !== bw ||
    bytes[5] !== bh ||
    bytes[6] !== 1 ||
    bytes.readUIntLE(7, 3) !== group.w ||
    bytes.readUIntLE(10, 3) !== group.rows ||
    bytes.length !== 16 + Math.ceil(group.w / bw) * Math.ceil(group.rows / bh) * 16
  )
    throw Error('Unexpected ASTC output ' + group.name);
  return bytes.subarray(16);
});
// Each slice is a contiguous run of block rows inside its stacked group.
const levels = plan.items.map((item) => item.levels.map(() => []));
for (const s of layout.slices) {
  const group = layout.groups[s.group],
    [bw, bh] = group.block,
    row = Math.ceil(s.w / bw) * 16;
  const start = (s.row / bh) * row,
    size = Math.ceil(s.h / bh) * row;
  levels[s.item][s.level][s.index] = payloads[s.group].subarray(start, start + size);
}
const format = (item) => 'ASTC' + item.block.join('x');
function mips(item, index, category) {
  return item.levels.map((level, i) => {
    const parts = levels[index][i];
    if (parts.length === 0 || parts.some((part) => !part)) throw Error('Missing ASTC slice');
    const bytes = Buffer.concat(parts);
    return addMip(
      category,
      format(item),
      { level: item.levels.length - 1 - i, w: level.w, h: level.h, d: parts.length },
      bytes,
      i === 0,
    );
  });
}
const phone = { arrays: [], specials: {}, rgbm: {}, lightmaps: {}, volumes: {} };
const range = (index) => layout.ranges[String(index)];
plan.items.forEach((item, index) => {
  const target = plan.targets[index];
  if (target.kind === 'array') {
    const bank = manifest.arrays[target.bank];
    const bankMips = mips(item, index, 'textures');
    for (const mip of bankMips) delete mip.d;
    const top = bankMips.at(-1);
    phone.arrays.push({
      ...bank,
      format: format(item),
      w: top.w,
      h: top.h,
      levels: bankMips.length,
      mips: bankMips,
    });
    return;
  }
  const name = target.name;
  const base =
    target.kind === 'lightmap'
      ? manifest.specials[target.world + '/lightmaps/irradiance.vtex']
      : manifest.specials[name];
  phone.specials[name] = {
    ...base,
    format: format(item),
    first: 0,
    levels: mips(item, index, target.kind === 'special' ? 'cubemaps' : 'lightmaps'),
  };
  if (range(index) !== undefined) phone.rgbm[name] = range(index);
  if (target.kind === 'lightmap') phone.lightmaps[target.world] = name;
  if (target.kind === 'volume')
    phone.volumes[name] = { shadow: target.shadow, shadowBase: target.shadowBase };
});
for (const [name, texture] of Object.entries(manifest.specials))
  if (!(name in phone.specials) && !/^(BC|DXT|ATI)/.test(texture.format))
    phone.specials[name] = texture;
flush();
for (const texture of Object.values(phone.specials))
  if (texture.levels[0].file) texture.file = texture.levels[0].file;
for (const bank of phone.arrays) bank.file = bank.mips[0].file;
manifest.phone = phone;
for (const [name, record] of Object.entries(files)) record.br = precompress(out, name);
writeFileSync(join(out, 'map.json'), JSON.stringify(manifest), { flag: 'wx' });
precompress(out, 'map.json');
