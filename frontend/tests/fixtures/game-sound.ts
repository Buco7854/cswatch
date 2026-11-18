import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { originalMapReplay, qaActor } from './original-map';
import { manualMapAssets } from './map-assets';

/** Original authored PCM tone for decoder/lifecycle assertions, never game artwork. */
export function originalSoundWAV(durationMs = 250, sampleRate = 44100) {
  const frames = Math.round((durationMs / 1000) * sampleRate),
    bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    bytes.writeInt16LE(
      Math.round(Math.sin((i / sampleRate) * 440 * Math.PI * 2) * 3000),
      44 + i * 2,
    );
  return bytes;
}
export function originalSoundDescriptor(id = 'ak47-fire', bytes = originalSoundWAV()) {
  return {
    url: `/api/sound-assets/${id}.wav`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    durationMs: ((bytes.length - 44) / 2 / 44100) * 1000,
    sampleRate: 44100,
    channels: 1,
    mime: 'audio/wav' as const,
  };
}
export function originalGameSoundReplay() {
  return {
    ...originalMapReplay(),
    sounds: [32, 96, 224, 448, ...Array.from({ length: 16 }, (_, i) => 456 + i * 8)].map(
      (tick) => ({
        id: `original-shot-${tick}`,
        tick,
        soundId: 'ak47-fire',
        category: 'weapon' as const,
        evidence: 'network-sound' as const,
        selection: 'representative' as const,
        actor: qaActor,
        position: { x: 0, y: 0, z: 64 },
        ...(tick === 32 ? { endTick: 40 } : {}),
      }),
    ),
    gameplaySounds: {
      coverage: {
        weapon: 'partial' as const,
        footstep: 'unavailable' as const,
        reload: 'unavailable' as const,
        utility: 'unavailable' as const,
        objective: 'unavailable' as const,
        round: 'unavailable' as const,
      },
      truncated: false,
    },
    voice: Array.from({ length: 250 }, (_, i) => ({
      id: `original-voice-${i}`,
      speaker: qaActor,
      tick: i * 1.28,
      opus: '+P/+',
      sampleRate: 48000 as const,
      channels: 1 as const,
      durationMs: 20,
    })),
    communications: {
      voice: 'available' as const,
      chat: 'available' as const,
      captions: 'disabled' as const,
      unsupportedPackets: 0,
    },
  };
}
export async function installGameSoundFixture(page: Page) {
  const wave = originalSoundWAV(),
    descriptor = originalSoundDescriptor('ak47-fire', wave);
  const requests: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem(
      'viewer-settings',
      JSON.stringify({
        autoHideControls: false,
        killReplay: false,
        grenadeLanding: false,
        matchScore: false,
      }),
    );
    localStorage.setItem(
      'viewer-settings-mobile',
      JSON.stringify({
        autoHideControls: false,
        killReplay: false,
        grenadeLanding: false,
        matchScore: false,
      }),
    );
  });
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: null,
        guest_session: { csrf: 'original-audio-capability', expires_at: 2000000000 },
      },
    }),
  );
  await page.route('**/api/sound-assets', (route) => {
    requests.push('catalog');
    return route.fulfill({ json: { schemaVersion: 1, items: { 'ak47-fire': descriptor } } });
  });
  await page.route('**/api/sound-assets/*.wav', (route) => {
    requests.push(route.request().url());
    return route.fulfill({ contentType: 'audio/wav', body: wave });
  });
  for (const id of ['game-sound-a', 'game-sound-b']) {
    await page.route(`**/api/demos/${id}`, (route) =>
      route.fulfill({
        json: {
          id,
          name: 'Original synthetic audio QA',
          status: 'ready',
          guest_owned: true,
          public: false,
          owned: false,
          map: 'de_original_map_qa',
        },
      }),
    );
    await page.route(`**/api/demos/${id}/playback`, (route) =>
      route.fulfill({ json: originalGameSoundReplay() }),
    );
    await page.route(`**/api/demos/${id}/map-assets`, (route) =>
      route.fulfill({
        json: manualMapAssets({ model: null, mobile: null, overview: null, environment: null }),
      }),
    );
  }
  return { requests, wave, descriptor };
}
export async function observeActualAudio(page: Page) {
  await page.addInitScript(() => {
    const state = {
      contexts: 0,
      closed: 0,
      game: [] as { rate: number; sampleRate: number; tick: number }[],
      voice: 0,
      stops: 0,
      panners: 0,
      violations: [] as string[],
      analyser: null as AnalyserNode | null,
      peakRMS: 0,
    };
    (window as any).__audioQA = state;
    document.addEventListener('securitypolicyviolation', (event) =>
      state.violations.push(event.violatedDirective),
    );
    const Original = AudioContext;
    (window as any).AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        state.contexts++;
      }
      close() {
        state.closed++;
        return super.close();
      }
      createPanner() {
        state.panners++;
        return super.createPanner();
      }
    };
    const connect = AudioNode.prototype.connect;
    (AudioNode.prototype as any).connect = function (target: AudioNode, ...args: number[]) {
      if (target instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 2048;
        state.analyser = analyser;
        connect.call(this, analyser);
        connect.call(analyser, target);
        return target;
      }
      return (connect as any).call(this, target, ...args);
    };
    const start = AudioBufferSourceNode.prototype.start,
      stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args: [number?, number?, number?]) {
      if (this.buffer && this.buffer.duration > 0.1)
        state.game.push({
          rate: this.playbackRate.value,
          sampleRate: this.buffer.sampleRate,
          tick: Number(
            document.querySelector<HTMLInputElement>(
              '[aria-label="Playback position"],[aria-label="Position de lecture"]',
            )?.value || 0,
          ),
        });
      else state.voice++;
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args: [number?]) {
      state.stops++;
      return stop.apply(this, args);
    };
    (window as any).__audioRMS = () => {
      if (!state.analyser) return 0;
      const samples = new Float32Array(state.analyser.fftSize);
      state.analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    };
    // The assertion runner's sparse polling can alias short one-shots. Capture
    // the real analyser signal continuously from before the Play gesture.
    setInterval(() => {
      state.peakRMS = Math.max(state.peakRMS, (window as any).__audioRMS());
    }, 16);
  });
}
