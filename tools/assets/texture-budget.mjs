/** Decoded texture residency policy for trusted offline map preparation. */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import { listTextureInfo, listTextureSlots } from '@gltf-transform/functions';

const MiB = 1024 ** 2;
export const textureBudgetPolicies = Object.freeze({
  desktop: Object.freeze({ budgetBytes: 512 * MiB, maxEdge: 2048 }),
  mobile: Object.freeze({ budgetBytes: 256 * MiB, maxEdge: 1024 }),
});
export const textureBudgetLimits = Object.freeze({
  images: 20000,
  imageBytes: 64 * MiB,
  sourcePixels: 64 * MiB,
  edge: 16384,
  planBytes: 4 * MiB,
  budgetBytes: 1024 * MiB,
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
function policy(tier, overrides = {}) {
  const defaults = textureBudgetPolicies[tier];
  if (!defaults) throw new Error('Texture budget requires desktop or mobile tier.');
  const result = { tier, ...defaults, ...overrides };
  if (
    !integer(result.budgetBytes, 1, textureBudgetLimits.budgetBytes) ||
    !integer(result.maxEdge, 1, defaults.maxEdge)
  )
    throw new Error('Invalid bounded decoded texture policy.');
  return result;
}
export function rgbaMipBytes(width, height) {
  if (!integer(width, 1, textureBudgetLimits.edge) || !integer(height, 1, textureBudgetLimits.edge))
    throw new Error('Invalid texture dimensions.');
  let total = width * height * 4;
  while (width > 1 || height > 1) {
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
    total += width * height * 4;
  }
  return total;
}
const resident = (row) => row.width * row.height * 4 * row.copies;
const bakedAtlas = (roles) =>
  roles.includes('irradianceTexture') || roles.includes('lightingDirectionTexture');
const higher = (a, b) =>
  resident(a) / a.priority > resident(b) / b.priority ||
  (resident(a) / a.priority === resident(b) / b.priority &&
    (a.priority < b.priority || (a.priority === b.priority && a.id < b.id)));
function heapPush(heap, row) {
  let index = heap.length;
  heap.push(row);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!higher(row, heap[parent])) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = row;
}
function heapPop(heap) {
  const result = heap[0],
    last = heap.pop();
  if (heap.length) {
    let index = 0;
    while (true) {
      let child = index * 2 + 1;
      if (child >= heap.length) break;
      if (child + 1 < heap.length && higher(heap[child + 1], heap[child])) child++;
      if (!higher(heap[child], last)) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  }
  return result;
}

/** Deterministic weighted halving. Shared images keep their highest slot priority.
 * All images remain, aspect is preserved to integer pixel precision, never enlarged. */
export function planTextureBudget(images, { tier, ...overrides }) {
  const selected = policy(tier, overrides);
  if (!Array.isArray(images) || images.length > textureBudgetLimits.images)
    throw new Error('Texture image count exceeds its bound.');
  const ids = new Set();
  const rows = images
    .map((image) => {
      if (typeof image?.id !== 'string' && !Number.isSafeInteger(image?.id))
        throw new Error('Texture image requires an explicit identifier.');
      const id = String(image.id);
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id))
        throw new Error('Texture image IDs must be unique bounded identifiers.');
      ids.add(id);
      if (
        !integer(image.width, 1, textureBudgetLimits.edge) ||
        !integer(image.height, 1, textureBudgetLimits.edge) ||
        image.width * image.height > textureBudgetLimits.sourcePixels ||
        !integer(image.copies ?? 1, 1, 64) ||
        !Array.isArray(image.roles) ||
        image.roles.length > 64 ||
        image.roles.some((role) => typeof role !== 'string' || !/^[a-zA-Z0-9_]{1,80}$/.test(role))
      )
        throw new Error('Invalid bounded source texture metadata.');
      const scale = Math.min(1, selected.maxEdge / Math.max(image.width, image.height));
      return {
        id,
        sourceWidth: image.width,
        sourceHeight: image.height,
        width: Math.max(1, Math.floor(image.width * scale)),
        height: Math.max(1, Math.floor(image.height * scale)),
        copies: image.copies ?? 1,
        roles: [...new Set(image.roles)].sort(),
        priority: image.roles.some((role) => ['baseColorTexture', 'emissiveTexture'].includes(role))
          ? 2
          : 1,
        scale,
        halvings: 0,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (rows.reduce((sum, row) => sum + row.copies * 4, 0) > selected.budgetBytes)
    throw new Error('Decoded texture budget cannot retain even one pixel per image.');
  let total = rows.reduce((sum, row) => sum + resident(row), 0);
  const heap = [];
  for (const row of rows)
    if (!bakedAtlas(row.roles) && (row.width > 1 || row.height > 1)) heapPush(heap, row);
  while (total > selected.budgetBytes) {
    const row = heapPop(heap);
    if (!row) throw new Error('Decoded texture budget is unattainable without removing images.');
    const previous = resident(row);
    row.halvings++;
    const factor = row.scale / 2 ** row.halvings;
    row.width = Math.max(1, Math.floor(row.sourceWidth * factor));
    row.height = Math.max(1, Math.floor(row.sourceHeight * factor));
    total -= previous - resident(row);
    if (row.width > 1 || row.height > 1) heapPush(heap, row);
  }
  return {
    policy: selected,
    images: rows.map(({ scale, ...row }) => row),
    residentBaseRGBABytes: total,
    decodedRGBABytes: rows.reduce((sum, row) => sum + row.width * row.height * 4, 0),
  };
}

function samplerCopies(texture) {
  const samplers = new Set(
    listTextureInfo(texture).map((info) =>
      JSON.stringify([info.getMagFilter(), info.getMinFilter(), info.getWrapS(), info.getWrapT()]),
    ),
  );
  return Math.max(1, samplers.size);
}
async function metadata(image) {
  if (
    !(image instanceof Uint8Array) ||
    !integer(image.byteLength, 1, textureBudgetLimits.imageBytes)
  )
    throw new Error('Texture encoded image exceeds its bound.');
  const info = await sharp(Buffer.from(image.buffer, image.byteOffset, image.byteLength), {
    limitInputPixels: textureBudgetLimits.sourcePixels,
  }).metadata();
  if (
    !['png', 'jpeg', 'webp'].includes(info.format) ||
    (info.pages ?? 1) !== 1 ||
    !integer(info.width, 1, textureBudgetLimits.edge) ||
    !integer(info.height, 1, textureBudgetLimits.edge) ||
    info.width * info.height > textureBudgetLimits.sourcePixels
  )
    throw new Error('Texture image has unsupported format or bounded dimensions.');
  return {
    width: info.width,
    height: info.height,
    bytes: image.byteLength,
    sha256: sha(image),
    hasAlpha: info.hasAlpha,
  };
}

function cutoutCutoffs(document) {
  const uses = new Map();
  for (const material of document.getRoot().listMaterials()) {
    const texture = material.getBaseColorTexture();
    if (!texture) continue;
    const cutoff =
      material.getAlphaMode() === 'MASK' ? material.getAlphaCutoff() / material.getAlpha() : 0;
    const use = Number.isFinite(cutoff) && cutoff > 0 && cutoff < 1 ? cutoff : 0;
    uses.set(texture, !uses.has(texture) || uses.get(texture) === use ? use : 0);
  }
  return uses;
}

export function preserveAlphaCoverage(source, rgba, cutoff) {
  const threshold = cutoff * 255;
  let covered = 0;
  for (const alpha of source) if (alpha >= threshold) covered++;
  const area = covered / source.length;
  if (area === 0 || area === 1) return;
  const histogram = new Uint32Array(256);
  for (let index = 3; index < rgba.length; index += 4) histogram[rgba[index]]++;
  const pixels = rgba.length / 4;
  let cumulative = 0,
    closest = pixels,
    selected = threshold;
  for (let value = 255; value > 0; value--) {
    cumulative += histogram[value];
    const difference = Math.abs(cumulative - pixels * area);
    if (
      difference < closest ||
      (difference === closest && Math.abs(value - threshold) < Math.abs(selected - threshold))
    ) {
      closest = difference;
      selected = value;
    }
  }
  const gain = Math.max(0.67, Math.min(1.5, Math.ceil(threshold) / selected));
  if (Math.abs(gain - 1) < 0.01) return;
  for (let index = 3; index < rgba.length; index += 4)
    rgba[index] = Math.min(255, Math.round(rgba[index] * gain));
}

/** Serial encodes keep only one image decode live at a time. */
export async function applyTextureBudget(
  document,
  { tier, preserveCutoutCoverage = false, ...overrides },
) {
  const textures = document.getRoot().listTextures();
  if (textures.length > textureBudgetLimits.images) throw new Error('Too many map texture images.');
  const sources = [];
  for (const [index, texture] of textures.entries())
    sources.push({
      id: String(index),
      roles: listTextureSlots(texture),
      copies: samplerCopies(texture),
      ...(await metadata(texture.getImage())),
    });
  if (sources.reduce((sum, row) => sum + row.bytes, 0) > 4 * 1024 ** 3)
    throw new Error('Encoded texture sources exceed the 4 GiB preparation bound.');
  const planned = planTextureBudget(sources, { tier, ...overrides }),
    targets = new Map(planned.images.map((row) => [row.id, row]));
  const cutoffs = preserveCutoutCoverage ? cutoutCutoffs(document) : new Map();
  const images = [];
  for (const [index, texture] of textures.entries()) {
    const target = targets.get(String(index)),
      source = sources[index],
      input = texture.getImage();
    const baked = bakedAtlas(target.roles);
    const cutoff = source.hasAlpha && target.roles.length === 1 && cutoffs.get(texture);
    const alreadyWebP =
      texture.getMimeType() === 'image/webp' &&
      input.byteLength >= 12 &&
      Buffer.from(input.buffer, input.byteOffset, 4).toString('ascii') === 'RIFF' &&
      Buffer.from(input.buffer, input.byteOffset + 8, 4).toString('ascii') === 'WEBP';
    const unchanged = source.width === target.width && source.height === target.height;
    let encoded = input;
    if (!alreadyWebP || !unchanged) {
      const decoder = () =>
        sharp(Buffer.from(input.buffer, input.byteOffset, input.byteLength), {
          limitInputPixels: textureBudgetLimits.sourcePixels,
        });
      let resized = decoder().resize(target.width, target.height, {
        fit: 'fill',
        withoutEnlargement: true,
        kernel: baked ? 'nearest' : 'lanczos3',
      });
      if (cutoff && !unchanged) {
        const alpha = await decoder().toColourspace('srgb').extractChannel(3).raw().toBuffer();
        const raw = await resized.toColourspace('srgb').ensureAlpha().raw().toBuffer();
        preserveAlphaCoverage(alpha, raw, cutoff);
        resized = sharp(raw, { raw: { width: target.width, height: target.height, channels: 4 } });
      }
      encoded = await resized
        .webp(
          baked || target.roles.includes('layerBlendTexture') || target.roles.includes('baseHeight')
            ? { lossless: true, effort: 4 }
            : { quality: 80, effort: 4 },
        )
        .toBuffer();
    }
    const { hasAlpha: _hasAlpha, ...actual } = await metadata(encoded);
    if (
      actual.width > target.width ||
      actual.height > target.height ||
      actual.width > planned.policy.maxEdge ||
      actual.height > planned.policy.maxEdge
    )
      throw new Error('Compressed image dimensions exceed their decoded residency plan.');
    texture
      .setImage(encoded)
      .setMimeType('image/webp')
      .setURI(texture.getURI().replace(/\.[^./]+$/, '.webp'));
    images.push({
      id: source.id,
      roles: target.roles,
      copies: target.copies,
      source: {
        width: source.width,
        height: source.height,
        bytes: source.bytes,
        sha256: source.sha256,
      },
      planned: { width: target.width, height: target.height, halvings: target.halvings },
      actual,
    });
  }
  if (textures.length) document.createExtension(EXTTextureWebP).setRequired(true);
  const summary = {
    schemaVersion: 1,
    budgetBytes: planned.policy.budgetBytes,
    maxEdge: planned.policy.maxEdge,
    textures: images.length,
    decodedRGBABytes: images.reduce(
      (sum, row) => sum + row.actual.width * row.actual.height * 4,
      0,
    ),
    residentBaseRGBABytes: images.reduce(
      (sum, row) => sum + row.actual.width * row.actual.height * 4 * row.copies,
      0,
    ),
    gpuMipRGBABytes: images.reduce(
      (sum, row) => sum + rgbaMipBytes(row.actual.width, row.actual.height) * row.copies,
      0,
    ),
    sourceDecodedRGBABytes: sources.reduce((sum, row) => sum + row.width * row.height * 4, 0),
    sourceEncodedImageBytes: sources.reduce((sum, row) => sum + row.bytes, 0),
    encodedImageBytes: images.reduce((sum, row) => sum + row.actual.bytes, 0),
  };
  if (
    summary.residentBaseRGBABytes > summary.budgetBytes ||
    summary.decodedRGBABytes > summary.residentBaseRGBABytes
  )
    throw new Error('Actual encoded textures exceed their decoded residency budget.');
  const plan = { schemaVersion: 1, policy: planned.policy, summary, images };
  const planBytes = Buffer.from(JSON.stringify(plan, null, 2));
  if (planBytes.length > textureBudgetLimits.planBytes)
    throw new Error('Texture provenance plan exceeds its 4 MiB bound.');
  return { manifest: { ...summary, planSha256: sha(planBytes) }, plan, planBytes };
}
