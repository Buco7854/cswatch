// Source 2's v1 VTEX stores its linear reflectivity directly in the verified DATA header.
// The material's contrast is centered on this value, which can differ from the current mip's average.
export function textureReflectivity(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 16 ||
    bytes.readUInt16LE(4) !== 12 ||
    bytes.readUInt16LE(6) !== 1
  )
    return;
  const end = bytes.readUInt32LE(0),
    table = 8 + bytes.readUInt32LE(8),
    count = bytes.readUInt32LE(12);
  if (end > bytes.length || table < 16 || count < 1 || count > 128 || table + count * 12 > end)
    return;
  let pivot;
  for (let i = 0; i < count; i++) {
    const row = table + i * 12,
      at = row + 4 + bytes.readUInt32LE(row + 4),
      size = bytes.readUInt32LE(row + 8);
    if (at < table + count * 12 || at + size > end) return;
    if (bytes.toString('ascii', row, row + 4) !== 'DATA') continue;
    if (pivot || size < 20 || bytes.readUInt16LE(at) !== 1) return;
    pivot = [0, 1, 2].map((c) => bytes.readFloatLE(at + 4 + c * 4));
  }
  if (pivot?.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return pivot;
}

export function colorAdjustment(vmat, i) {
  const f = vmat.FloatParams ?? {},
    t = vmat.VectorParams?.['g_vTextureColorTint' + i],
    mode = vmat.IntParams?.['g_nColorCorrectionMode' + i] ?? 0;
  if (
    (t && (!Array.isArray(t) || t.length < 3 || t.slice(0, 3).some((v) => v !== 1))) ||
    ![0, 1].includes(mode)
  )
    return;
  const values = ['Contrast', 'Saturation', 'Brightness'].map(
    (name) => f['g_fTextureColor' + name + i] ?? 1,
  );
  const mask = [f['g_fTintMaskContrast' + i] ?? 1, f['g_fTintMaskBrightness' + i] ?? 1];
  if (
    values.every((x) => x === 1) ||
    [...values, ...mask].some((x) => !Number.isFinite(x) || x < 0 || x > 8)
  )
    return;
  return { values, mode, mask };
}

// See ValveResourceFormat VfxEvalFunctions.MatrixColorCorrect2 and RenderMaterial at
// 942df5b37ebbde6153f6c488880b91d4bed003e6 and frontend/public/licenses/valve-resource-format.txt.
// MatrixColorCorrect2 first centers the contrast around the VTEX pivot, then adjusts brightness.
// Its saturation transform projects onto the BT.709 axis after scaling by the normalized axis itself.
const squared = [0.2125, 0.7154, 0.0721].map((x) => x * x);
export const saturationWeights = squared.map((x) => x / squared.reduce((sum, v) => sum + v, 0));
export function colorAxes(adjust, pivot) {
  if (!adjust || !pivot) return;
  const [contrast, saturation, brightness] = adjust.values;
  const shift = pivot.map((v) => (1 - contrast) * v * brightness);
  const grey = shift.reduce((s, x, i) => s + x * saturationWeights[i], 0);
  return {
    scale: [brightness * contrast * saturation, brightness * contrast * (1 - saturation)],
    offset: shift.map((x) => x * saturation + grey * (1 - saturation)),
    mode: adjust.mode,
    mask: adjust.mask,
  };
}
