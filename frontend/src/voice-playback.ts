import type { VoicePacket } from '../../shared/communications';
import type { OpusDecoder } from 'opus-decoder';
import { ViewerAudio } from './viewer-audio';

/** Local, bounded decoded audio. No microphone, external audio URL or remote service. */
export class VoicePlayback {
  private gain: GainNode | null = null;
  private decoders = new Map<string, Promise<OpusDecoder<any>>>();
  private sources = new Map<AudioBufferSourceNode, () => void>();
  private scheduled = new Map<string, number>();
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private previous: { tick: number; now: number; speed: number; scope: string } | null = null;
  private closed = false;
  private release: () => void;
  constructor(
    private report: (error: string) => void,
    private audio: ViewerAudio,
  ) {
    this.release = audio.onFlush(() => this.stop());
  }

  async unlock() {
    if (this.closed) return;
    const running = await this.audio.unlock();
    if (this.closed) return;
    this.report(
      running
        ? ''
        : this.audio.snapshot() === 'unavailable'
          ? 'Voice playback is unavailable in this browser.'
          : 'Press Enable audio to allow voice playback in this browser.',
    );
  }

  private reset() {
    this.generation++;
    for (const stop of [...this.sources.values()]) stop();
    this.sources.clear();
    this.scheduled.clear();
    for (const decoder of this.decoders.values())
      void decoder.then((value) => value.free()).catch(() => {});
    this.decoders.clear();
    this.tail = Promise.resolve();
  }

  stop() {
    if (this.previous || this.sources.size || this.decoders.size) this.reset();
    this.previous = null;
  }

  sync(
    packets: VoicePacket[],
    tick: number,
    rate: number,
    speed: number,
    volume: number,
    speakers: string[],
  ) {
    const context = this.audio.context;
    if (!context || context.state !== 'running' || this.closed) return;
    if (!this.gain) this.gain = this.audio.channel();
    if (!this.gain) return;
    const scope = speakers.join(',');
    const now = performance.now();
    const previous = this.previous;
    if (
      previous &&
      (previous.scope !== scope ||
        previous.speed !== speed ||
        tick < previous.tick - 1 ||
        Math.abs((tick - previous.tick) / rate - ((now - previous.now) / 1000) * speed) >
          0.3 * speed)
    )
      this.reset();
    this.previous = { tick, now, speed, scope };
    this.gain.gain.value = Math.max(0, Math.min(1, volume));
    const allowed = new Set(speakers),
      generation = this.generation;
    for (const [id, position] of this.scheduled)
      if (position < tick - rate * 3) this.scheduled.delete(id);
    const batch = packets
      .filter(
        (packet) =>
          allowed.has(packet.speaker) &&
          packet.tick >= tick - rate * 0.1 &&
          packet.tick <= tick + rate * speed * 0.35 &&
          !this.scheduled.has(packet.id),
      )
      .slice(0, 256);
    for (const packet of batch) {
      this.scheduled.set(packet.id, packet.tick);
      const start = context.currentTime + (packet.tick - tick) / rate / speed;
      this.tail = this.tail
        .then(async () => {
          if (generation !== this.generation || this.closed) return;
          const key = `${packet.speaker}:${packet.sampleRate}:${packet.channels}`;
          let ready = this.decoders.get(key);
          if (!ready) {
            if (this.decoders.size >= 64) throw new Error('Voice decoder limit');
            ready = import('opus-decoder').then(async ({ OpusDecoder }) => {
              const decoder = new OpusDecoder({
                sampleRate: packet.sampleRate,
                channels: packet.channels,
              });
              await decoder.ready;
              return decoder;
            });
            this.decoders.set(key, ready);
          }
          const decoder = await ready;
          if (generation !== this.generation || this.closed) return;
          const encoded = Uint8Array.from(atob(packet.opus), (character) =>
            character.charCodeAt(0),
          );
          const audio = decoder.decodeFrame(encoded);
          if (
            audio.errors.length ||
            !audio.samplesDecoded ||
            audio.samplesDecoded > audio.sampleRate * 0.12 + 1 ||
            audio.channelData.length > 2
          )
            throw new Error('Voice decoding failed');
          const duration = audio.samplesDecoded / audio.sampleRate / speed;
          if (start + duration < context.currentTime) return;
          const buffer = context.createBuffer(
            audio.channelData.length,
            audio.samplesDecoded,
            audio.sampleRate,
          );
          audio.channelData.forEach((channel, index) => buffer.getChannelData(index).set(channel));
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.playbackRate.value = speed;
          source.connect(this.gain!);
          const stop = this.audio.track(source, () => {
            this.sources.delete(source);
          });
          if (!stop) {
            source.disconnect();
            return;
          }
          this.sources.set(source, stop);
          const offset = Math.max(0, (context.currentTime - start) * speed);
          if (offset >= buffer.duration) {
            stop();
            return;
          }
          source.start(Math.max(context.currentTime, start), offset);
        })
        .catch(() => {
          if (generation === this.generation && !this.closed)
            this.report('Some recorded voice could not be decoded in this browser.');
        });
    }
  }

  close() {
    this.closed = true;
    this.release();
    this.stop();
    this.audio.releaseChannel(this.gain);
    this.gain = null;
  }
}
