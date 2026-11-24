import { isDeepStrictEqual as equal } from 'node:util';
import { boundedFile, digest, compareReferenceImage } from './capture-report.mjs';

export async function compareReplayFrame(frame, bytes, referencePath) {
  if (!referencePath) return { status: 'no-reference', metrics: null };
  const raw = await boundedFile(referencePath, 128 * 1024),
    ref = JSON.parse(raw);
  const external = ref.kind === 'external-replay-frame-reference';
  const reasons = [];
  if (ref.schemaVersion !== 1 || (!external && ref.kind !== 'cswatch-replay-frame'))
    reasons.push('reference-kind');
  for (const key of [
    'map',
    'assetVersion',
    'sourceSha256',
    'replaySha256',
    'tick',
    'player',
    'coordinateSystem',
    'hudFree',
    'cameraMode',
    'viewport',
    'buffer',
    'colorSpace',
  ])
    if (!equal(frame[key], ref[key])) reasons.push(key);
  // Fixed tolerances permit decimal serialization of independent camera transforms.
  for (const [key, epsilon] of [
    ['worldMatrix', 1e-5],
    ['projectionMatrix', 1e-6],
  ]) {
    const values = ref.camera?.[key];
    if (
      !Array.isArray(values) ||
      values.length !== 16 ||
      values.some((n, i) => !Number.isFinite(n) || Math.abs(n - frame.camera[key][i]) > epsilon)
    )
      reasons.push(key);
  }
  const a = frame.equipmentProjection,
    b = ref.equipmentProjection;
  if (
    a === null
      ? b !== null
      : !Array.isArray(b) ||
        b.length !== 16 ||
        b.some((n, i) => !Number.isFinite(n) || Math.abs(n - a[i]) > 1e-6)
  )
    reasons.push('equipmentProjection');
  if (external) {
    const p = ref.provenance;
    if (
      !['CS2', 'reference'].includes(p?.producer) ||
      ['version', 'captureSource', 'renderSettings', 'mapRevisionEvidence'].some(
        (k) => typeof p[k] !== 'string' || !p[k].trim() || p[k].length > 1000,
      )
    )
      reasons.push('external-provenance');
  } else {
    for (const key of [
      'modelSha256',
      'theme',
      'imageSource',
      'chunkSha256',
      'manifestSha256',
      'settings',
      'status',
      'screenPass',
      'nativePovModel',
      'toneMapping',
      'exposure',
      'visualResourcesSha256',
    ])
      if (!equal(frame[key], ref[key])) reasons.push(key);
  }
  const compared = await compareReferenceImage({
    image: bytes,
    ref,
    file: referencePath,
    width: frame.buffer[0],
    height: frame.buffer[1],
    external,
    reasons,
  });
  return {
    ...compared,
    referenceManifestSha256: digest(raw),
    ...(external && compared.metrics
      ? {
          provenance: {
            producer: ref.provenance.producer,
            version: ref.provenance.version,
            captureSource: ref.provenance.captureSource,
            renderSettings: ref.provenance.renderSettings,
            mapRevisionEvidence: ref.provenance.mapRevisionEvidence,
          },
        }
      : {}),
  };
}
