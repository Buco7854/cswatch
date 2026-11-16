import { crc32 } from 'node:zlib';

export type OpusFrame = {
  data: Uint8Array;
  sampleRate: 8000 | 12000 | 16000 | 24000 | 48000;
  durationMs: number;
  channels: 1 | 2;
};
const rates = [8000, 12000, 16000, 24000, 48000];

/** RFC 6716 packet duration, bounded to the codec's 120 ms maximum. */
export function opusDuration(data: Uint8Array): number {
  if (!data.length || data.length > 8192) throw new Error('Invalid Opus frame');
  const config = data[0] >> 3,
    code = data[0] & 3;
  const perFrame =
    config >= 16
      ? 2.5 * 2 ** (config & 3)
      : config >= 12
        ? 10 * 2 ** (config & 1)
        : [10, 20, 40, 60][config & 3];
  const count = code === 0 ? 1 : code === 3 ? (data.length > 1 ? data[1] & 63 : 0) : 2;
  if (!count || count * perFrame > 120) throw new Error('Invalid Opus duration');
  return count * perFrame;
}
function frame(data: Uint8Array, rate: number): OpusFrame {
  if (!rates.includes(rate)) throw new Error('Unsupported voice sample rate');
  return {
    data,
    durationMs: opusDuration(data),
    sampleRate: rate as OpusFrame['sampleRate'],
    channels: data[0] & 4 ? 2 : 1,
  };
}

/** Steam container framing: identity, typed records and CRC32; unknown records fail closed.
 * https://docs.rs/steam-audio-codec/latest/steam_audio_codec/ */
export function steamOpusFrames(bytes: Uint8Array): OpusFrame[] {
  if (bytes.length < 12 || bytes.length > 256 * 1024) throw new Error('Invalid Steam voice packet');
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = data.length - 4;
  if (crc32(data.subarray(0, end)) !== data.readUInt32LE(end))
    throw new Error('Steam voice checksum mismatch');
  const result: OpusFrame[] = [];
  let offset = 8,
    rate = 24000;
  while (offset < end) {
    const type = data[offset++];
    if (offset + 2 > end) throw new Error('Truncated Steam voice record');
    const length = data.readUInt16LE(offset);
    offset += 2;
    if (type === 11) {
      if (!rates.includes(length)) throw new Error('Unsupported Steam voice rate');
      rate = length;
      continue;
    }
    if (type === 0) continue; // Recorded silence carries sample count, no compressed audio.
    if (type !== 6 || offset + length > end) throw new Error('Unsupported Steam voice codec');
    const sectionEnd = offset + length;
    while (offset < sectionEnd) {
      if (offset + 2 > sectionEnd) throw new Error('Truncated Steam Opus frame');
      const size = data.readUInt16LE(offset);
      offset += 2;
      if (size === 65535) break;
      if (offset + 2 + size > sectionEnd || size < 1)
        throw new Error('Invalid Steam Opus frame length');
      offset += 2; // Recorded per-speaker sequence, not part of the Opus frame.
      result.push(frame(data.subarray(offset, offset + size), rate));
      offset += size;
      if (result.length > 128) throw new Error('Too many Steam voice frames');
    }
    if (offset !== sectionEnd) throw new Error('Invalid Steam voice section');
  }
  return result;
}

export function voiceFrames(audio: {
  format?: number;
  voice_data?: Uint8Array;
  sample_rate?: number;
  packet_offsets?: number[];
  num_packets?: number;
}): OpusFrame[] {
  const bytes = audio.voice_data;
  if (!bytes?.length) return [];
  if (bytes.length > 256 * 1024) throw new Error('Voice packet limit');
  if ((audio.format ?? 0) === 0) return steamOpusFrames(bytes);
  if (audio.format !== 2) throw new Error('Unsupported recorded voice codec');
  const rate = audio.sample_rate || 48000;
  const offsets = audio.packet_offsets || [];
  if (!offsets.length) {
    if ((audio.num_packets ?? 1) > 1) throw new Error('Missing Opus packet boundaries');
    return [frame(bytes, rate)];
  }
  if (
    offsets.length > 128 ||
    offsets.some(
      (offset, i) =>
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset >= bytes.length ||
        (i > 0 && offset <= offsets[i - 1]),
    )
  )
    throw new Error('Invalid Opus packet offsets');
  const starts = offsets[0] === 0 ? offsets : [0, ...offsets];
  if (audio.num_packets && audio.num_packets !== starts.length)
    throw new Error('Opus packet count mismatch');
  return starts.map((offset, i) =>
    frame(bytes.subarray(offset, starts[i + 1] ?? bytes.length), rate),
  );
}
