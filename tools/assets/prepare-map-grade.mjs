import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { mapGradeBytes, mapGradeFile, validMapGrade } from '../../shared/map-grade.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const maxPostProcessBytes = 512 * 1024;
export const maxPostProcessDumpBytes = 512 * 1024;

/** Read the compiled DATA block, where the LUT is already RGBA8 in RGB-axis order. */
export function prepareMapGrade(authored, text) {
  if (
    !authored ||
    typeof text !== 'string' ||
    Buffer.byteLength(text) > maxPostProcessDumpBytes ||
    text.includes('\0')
  )
    throw Error('Expected bounded authored post-processing DATA.');
  const field = (input, name, valuePattern) => {
    const matches = [
      ...input.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*(${valuePattern})\\s*$`, 'gm')),
    ];
    if (matches.length !== 1) throw Error(`Missing or ambiguous post-processing field ${name}.`);
    return matches[0][1];
  };
  const numeric = (input, name) =>
    Number(field(input, name, '[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?'));
  field(text, 'm_bHasTonemapParams', 'true');
  const colorCorrection = field(text, 'm_bHasColorCorrection', 'true|false') === 'true';
  const tone = field(text, 'm_toneMapParams', '\\{[^{}]*\\}');
  const parameter = (name) => numeric(tone, `m_fl${name}`);
  // The viewer has no exposure meter. Decline authored luminance-dependent bias
  // and leave the viewer to use a fixed value from the entity's range.
  if (
    ['LuminanceSource', 'ExposureBiasShadows', 'ExposureBiasHighlights'].some(
      (key) => parameter(key) !== 0,
    )
  )
    throw Error('Unsupported luminance-dependent post-processing bias.');
  const size = colorCorrection ? numeric(text, 'm_nColorCorrectionVolumeDim') : 2;
  if (!Number.isInteger(size) || size < 2 || size > 32) throw Error('Unsupported LUT size.');
  let lut;
  if (colorCorrection) {
    const hex = field(text, 'm_colorCorrectionVolumeData', '#\\[[^\\]]*\\]')
      .slice(2, -1)
      .trim()
      .split(/\s+/);
    if (hex.length !== mapGradeBytes(size) || hex.some((byte) => !/^[a-f0-9]{2}$/i.test(byte)))
      throw Error('Invalid authored RGBA8 LUT.');
    lut = Buffer.from(hex.join(''), 'hex');
  } else {
    // The renderer interpolates this identity volume for a tone-only source.
    lut = Buffer.from(
      Array.from({ length: 8 }, (_, pixel) => [
        255 * (pixel & 1),
        255 * ((pixel >> 1) & 1),
        255 * ((pixel >> 2) & 1),
        255,
      ]).flat(),
    );
  }
  const grade = {
    exposure: { min: authored.min, max: authored.max, bias: parameter('ExposureBias') },
    curve: {
      shoulder: parameter('ShoulderStrength'),
      linear: parameter('LinearStrength'),
      angle: parameter('LinearAngle'),
      toe: parameter('ToeStrength'),
      numerator: parameter('ToeNum'),
      denominator: parameter('ToeDenom'),
      whiteStops: parameter('WhitePoint'),
    },
    ...(authored.lighting ? { lighting: authored.lighting } : {}),
    lut: { size, sha256: hash(lut) },
  };
  if (!validMapGrade(grade)) throw Error('Authored grading exceeds the supported contract.');
  return { grade, lut, colorCorrection };
}

/** The caller owns a new private environment stage and publishes it as a unit. */
export async function writeMapGrade(directory, authored, text) {
  const { grade, lut, colorCorrection } = prepareMapGrade(authored, text);
  await writeFile(join(directory, mapGradeFile), lut, { flag: 'wx', mode: 0o644 });
  return { grade, colorCorrection };
}
