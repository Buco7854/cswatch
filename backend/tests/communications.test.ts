import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { steamOpusFrames, voiceFrames, opusDuration } from '../src/voice-packets.js';
import { voicePacketSchema, validateReplayArtifacts, writeReplay } from '../src/replay.js';
import { sample } from '../../frontend/src/sample.js';
import { readCommunications } from '../src/communications.js';

const silence = Buffer.from([0xf8, 0xff, 0xfe]);
function steamPacket() {
  const header = Buffer.alloc(8);
  header.writeBigUInt64LE(76561198000000001n);
  const body = Buffer.concat([header, Buffer.from([11, 0xc0, 0x5d, 6, 7, 0, 3, 0, 1, 0]), silence]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32LE(crc32(body));
  return Buffer.concat([body, checksum]);
}
test('recorded Steam voice framing validates CRC/lengths and exposes exact Opus duration without inferring speech', () => {
  const packet = steamPacket();
  const frames = steamOpusFrames(packet);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].sampleRate, 24000);
  assert.equal(frames[0].durationMs, 20);
  assert.deepEqual(Buffer.from(frames[0].data), silence);
  const corrupt = Buffer.from(packet);
  corrupt[10] ^= 1;
  assert.throws(() => steamOpusFrames(corrupt), /checksum/);
  assert.throws(() => steamOpusFrames(packet.subarray(0, 8)));
  assert.throws(() => opusDuration(Buffer.from([0xfb, 63])), /duration/);
  assert.throws(() => voiceFrames({ format: 1, voice_data: silence }), /Unsupported/);
  const opus = voiceFrames({
    format: 2,
    voice_data: Buffer.concat([silence, silence]),
    packet_offsets: [3, 6],
    num_packets: 2,
    sample_rate: 48000,
  });
  assert.equal(opus.length, 2);
  assert.throws(() => voiceFrames({ format: 2, voice_data: silence, packet_offsets: [2, 1] }));
  assert.throws(() => voiceFrames({ format: 2, voice_data: silence, num_packets: 3 }));
});
test('streamed replay voice remains bounded, retains speaker identity and cannot forge decoded duration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-media-'));
  try {
    const voice = {
      id: 'voice-0',
      speaker: '76561198000000001',
      tick: 400,
      opus: silence.toString('base64'),
      sampleRate: 48000 as const,
      channels: 1 as const,
      durationMs: 20,
    };
    assert.equal(voicePacketSchema.safeParse({ ...voice, durationMs: 120 }).success, false);
    assert.equal(voicePacketSchema.safeParse({ ...voice, channels: 2 }).success, false);
    assert.equal(voicePacketSchema.safeParse({ ...voice, opus: 'not base64' }).success, false);
    await writeReplay(dir, {
      ...sample,
      voice: [voice],
      chat: [
        {
          id: 'chat-0',
          tick: 400,
          speaker: voice.speaker,
          name: 'Recorded player',
          text: '<script>plain text only</script>',
          channel: 'team',
        },
      ],
      communications: {
        voice: 'available',
        chat: 'available',
        captions: 'disabled',
        unsupportedPackets: 0,
      },
    });
    const output = validateReplayArtifacts(dir);
    assert.equal(output.manifest.communications?.voice, 'available');
    assert.equal(output.manifest.chat?.[0].text, '<script>plain text only</script>');
    assert.equal('voice' in output.manifest, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the actual TypeScript demo reader extracts voice from explicit synthetic Source 2 protocol framing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-voice-protocol-'));
  const variable = (value: number) => {
    const bytes = [];
    do {
      let byte = value & 127;
      value = Math.floor(value / 128);
      if (value) byte |= 128;
      bytes.push(byte);
    } while (value);
    return Buffer.from(bytes);
  };
  const field = (number: number, data: Buffer) =>
    Buffer.concat([variable(number * 8 + 2), variable(data.length), data]);
  const command = (type: number, tick: number, payload: Buffer) =>
    Buffer.concat([variable(type), variable(tick), variable(payload.length), payload]);
  try {
    const audio = Buffer.concat([
      Buffer.from([8, 2]),
      field(2, silence),
      Buffer.from([40]),
      variable(48000),
      Buffer.from([56]),
      variable(1),
      // A real Source 2 message carries packet ENDS in a capacity table.
      // Only the one declared packet is meaningful, not the trailing slots.
      field(
        8,
        Buffer.concat([variable(silence.length), variable(0), variable(0), variable(123456789)]),
      ),
    ]);
    const speaker = Buffer.alloc(8);
    speaker.writeBigUInt64LE(76561198000000001n);
    const message = Buffer.concat([field(1, audio), Buffer.from([33]), speaker]);
    const bits: number[] = [];
    const write = (value: number, count: number) => {
      for (let i = 0; i < count; i++) bits.push((value >>> i) & 1);
    };
    // Network messages use Source 2's bit-packed UBitVar ID, followed by varint size.
    write(0x10 | (47 & 15), 6);
    write(47 >>> 4, 4);
    for (const byte of variable(message.length)) write(byte, 8);
    for (const byte of message) write(byte, 8);
    const network = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((bit, i) => {
      network[Math.floor(i / 8)] |= bit << (i % 8);
    });
    const header = Buffer.alloc(16);
    header.write('PBDEMS2\0');
    const file = join(dir, 'synthetic-voice.dem');
    writeFileSync(
      file,
      Buffer.concat([
        header,
        command(
          1,
          0,
          Buffer.concat([field(1, Buffer.from('PBDEMS2\0')), field(5, Buffer.from('de_mirage'))]),
        ),
        command(7, 64, field(3, network)),
        command(0, 128, Buffer.alloc(0)),
      ]),
    );
    const result = await readCommunications(file, 64, 256, new Set(['76561198000000001']));
    assert.equal(result.communications.voice, 'available', JSON.stringify(result));
    assert.equal(result.voice.length, 1);
    assert.equal(result.voice[0].speaker, '76561198000000001');
    assert.equal(result.voice[0].tick, 64);
    assert.equal(result.voice[0].opus, silence.toString('base64'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
