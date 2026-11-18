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
  for (const row of rows) if (row.width > 1 || row.height > 1) heapPush(heap, row);
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
  return { width: info.width, height: info.height, bytes: image.byteLength, sha256: sha(image) };
}

/** Serial encodes avoid the old hundreds-of-images Promise.all decode peak. */
export async function applyTextureBudget(document, { tier, ...overrides }) {
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
  const images = [];
  for (const [index, texture] of textures.entries()) {
    const target = targets.get(String(index)),
      source = sources[index],
      input = texture.getImage();
    const alreadyWebP =
      texture.getMimeType() === 'image/webp' &&
      input.byteLength >= 12 &&
      Buffer.from(input.buffer, input.byteOffset, 4).toString('ascii') === 'RIFF' &&
      Buffer.from(input.buffer, input.byteOffset + 8, 4).toString('ascii') === 'WEBP';
    const encoded =
      alreadyWebP && source.width === target.width && source.height === target.height
        ? input
        : await sharp(Buffer.from(input.buffer, input.byteOffset, input.byteLength), {
            limitInputPixels: textureBudgetLimits.sourcePixels,
          })
            .resize(target.width, target.height, {
              fit: 'fill',
              withoutEnlargement: true,
              kernel: 'lanczos3',
            })
            .webp({ quality: 80, effort: 4 })
            .toBuffer();
    const actual = await metadata(encoded);
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
