/** Bounded container validation before native/browser decoding. No compressed duration guesses. */
export const gameplayAudioLimits = Object.freeze({
  bankItems: 256,
  bytes: 2 * 1024 ** 2,
  durationMs: 10000,
  sampleRate: 48000,
  channels: 2,
  bankBytes: 64 * 1024 ** 2,
});
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;

export function inspectGameplayAudio(input) {
  // Check genuine backing-store brands before constructing a view. Never coerce
  // array-like objects, proxies, iterables or attacker-supplied length properties.
  let buffer, byteOffset, byteLength;
  if (input instanceof Uint8Array) {
    buffer = typedBuffer.call(input);
    byteOffset = typedOffset.call(input);
    byteLength = typedLength.call(input);
    bufferLength.call(buffer); // Shared backing stores are deliberately unsupported.
  } else if (input instanceof ArrayBuffer) {
    buffer = input;
    byteOffset = 0;
    byteLength = bufferLength.call(input);
  } else {
    throw TypeError('Sound input must be a Uint8Array or ArrayBuffer.');
  }
  if (byteLength < 24 || byteLength > gameplayAudioLimits.bytes)
    throw Error('Sound file size is invalid.');
  const view = new DataView(buffer, byteOffset, byteLength);
  const fourCC = (offset) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  let samples, sampleRate, channels, mime, extension;
  if (fourCC(0) === 'RIFF' && fourCC(8) === 'WAVE') {
    if (view.getUint32(4, true) !== byteLength - 8) throw Error('Invalid WAVE length.');
    let format,
      payload,
      offset = 12,
      chunks = 0;
    while (offset < byteLength) {
      if (++chunks > 64 || offset + 8 > byteLength) throw Error('Invalid WAVE chunks.');
      const kind = fourCC(offset),
        length = view.getUint32(offset + 4, true),
        start = offset + 8;
      if (start + length > byteLength) throw Error('Truncated WAVE chunk.');
      if (kind === 'fmt ') {
        if (format || length !== 16) throw Error('Unsupported WAVE format.');
        format = {
          codec: view.getUint16(start, true),
          channels: view.getUint16(start + 2, true),
          sampleRate: view.getUint32(start + 4, true),
          byteRate: view.getUint32(start + 8, true),
          align: view.getUint16(start + 12, true),
          bits: view.getUint16(start + 14, true),
        };
      }
      if (kind === 'data') {
        if (payload !== undefined) throw Error('Duplicate WAVE data.');
        payload = length;
      }
      offset = start + length + (length % 2);
    }
    if (
      offset !== byteLength ||
      !format ||
      !payload ||
      format.codec !== 1 ||
      ![8, 16].includes(format.bits) ||
      format.align !== (format.channels * format.bits) / 8 ||
      format.byteRate !== format.sampleRate * format.align ||
      payload % format.align
    )
      throw Error('Unsupported WAVE encoding.');
    ({ sampleRate, channels } = format);
    samples = payload / format.align;
    mime = 'audio/wav';
    extension = 'wav';
  } else {
    throw Error('Only bounded uncompressed PCM WAVE is supported.');
  }
  const durationMs = (samples / sampleRate) * 1000;
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > gameplayAudioLimits.sampleRate ||
    ![1, 2].includes(channels) ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs > gameplayAudioLimits.durationMs
  )
    throw Error('Sound duration or decoded format exceeds limits.');
  return {
    mime,
    extension,
    durationMs,
    sampleRate,
    channels,
    decodedBytes: samples * channels * 4,
  };
}
