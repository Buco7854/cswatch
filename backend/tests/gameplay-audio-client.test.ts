import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GameplayAudioTimeline } from '../../frontend/src/gameplay-audio-timeline.js';
import {
  GameplaySoundBuffers,
  validateGameplaySoundCatalog,
  validateGameplaySoundCues,
  validateGameplaySoundInfo,
  validateSoundPCM,
} from '../../frontend/src/gameplay-sound-assets.js';
import { ViewerAudio } from '../../frontend/src/viewer-audio.js';
import { GameplayPlayback } from '../../frontend/src/gameplay-playback.js';
import {
  originalSoundWAV,
  originalSoundDescriptor,
} from '../../frontend/tests/fixtures/game-sound.js';
import type { GameplaySoundCue } from '../../shared/gameplay-sounds.js';
const cue = (id: string, tick: number): GameplaySoundCue => ({
  id,
  tick,
  soundId: 'ak47-fire',
  category: 'weapon',
  evidence: 'network-sound',
  selection: 'representative',
});
test('game sound timeline de-duplicates chunk boundaries and discards historical cues after seeks and speed changes', () => {
  const timeline = new GameplayAudioTimeline(),
    sounds = [cue('a', 4), cue('b', 10), cue('c', 100), cue('d', 104)];
  assert.deepEqual(
    timeline.plan(sounds, 0, 64, 1, 0).sounds.map((x) => x.cue.id),
    ['a', 'b'],
  );
  assert.deepEqual(timeline.plan([...sounds], 4, 64, 1, 62.5).sounds, []);
  const sought = timeline.plan(sounds, 101, 64, 1, 100);
  assert.equal(sought.reset, true);
  assert.deepEqual(
    sought.sounds.map((x) => x.cue.id),
    ['d'],
  );
  const faster = timeline.plan(sounds, 102, 64, 2, 120);
  assert.equal(faster.reset, true);
  assert.equal(faster.sounds[0].delay, 2 / 64 / 2);
  timeline.reset();
  assert.deepEqual(timeline.plan(sounds, 105, 64, 1, 200).sounds, []);
});
test('game sound lookahead adapts to slow delivered frames while remaining bounded and never catching up old audio', () => {
  const timeline = new GameplayAudioTimeline(),
    sounds = [cue('old', 16), cue('next', 100), cue('far', 120)];
  timeline.plan(sounds, 0, 64, 1, 0);
  const plan = timeline.plan(sounds, 44.8, 64, 1, 700);
  assert.equal(plan.reset, false);
  assert.deepEqual(
    plan.sounds.map((x) => x.cue.id),
    ['next'],
  );
  assert.ok(plan.sounds[0].delay <= 1);
  assert.ok(
    new GameplayAudioTimeline().plan(
      Array.from({ length: 4096 }, (_, i) => cue(String(i), 0)),
      0,
      64,
      1,
      0,
    ).sounds.length <= 128,
  );
});
test('game sound contract accepts fixed bounded PCM assets and rejects external, compressed and oversized claims', () => {
  const item = originalSoundDescriptor();
  assert.equal(
    validateGameplaySoundCatalog({ schemaVersion: 1, items: { 'ak47-fire': item } }).items[
      'ak47-fire'
    ].sampleRate,
    44100,
  );
  for (const changed of [
    { url: 'https://untrusted.invalid/a.wav' },
    { mime: 'audio/mpeg' },
    { bytes: 3 * 1024 ** 2 },
    { durationMs: 11000 },
    { sampleRate: 96000 },
    { channels: 8 },
    { sha256: 'x' },
  ])
    assert.throws(() =>
      validateGameplaySoundCatalog({
        schemaVersion: 1,
        items: { 'ak47-fire': { ...item, ...changed } },
      }),
    );
  assert.throws(() =>
    validateGameplaySoundCatalog({ schemaVersion: 1, items: { unlisted: item } }),
  );
});
test('PCM preflight bounds actual frames before decoding and rejects lying durations or compressed codecs', () => {
  const wave = originalSoundWAV(),
    item = originalSoundDescriptor('ak47-fire', wave);
  validateSoundPCM(wave, item);
  assert.throws(() => validateSoundPCM(wave, { ...item, durationMs: 9000 }));
  const compressed = Buffer.from(wave);
  compressed.writeUInt16LE(85, 20);
  assert.throws(() => validateSoundPCM(compressed, item));
  const badRate = Buffer.from(wave);
  badRate.writeUInt32LE(1000000, 24);
  assert.throws(() => validateSoundPCM(badRate, item));
  assert.throws(() => validateSoundPCM(wave.subarray(0, wave.length - 2), item));
});
test('recorded sound validation preserves evidence, explicit stop ticks and unknown coverage without inferring actions', () => {
  const sounds = [
    {
      ...cue('a', 10.5),
      eventName: 'Weapon_AK47.Single',
      endTick: 20,
      position: { x: 1, y: 2, z: 3 },
      actor: '76561198000000001',
    },
  ];
  assert.deepEqual(validateGameplaySoundCues(sounds, 0, 15, 30), sounds);
  for (const changed of [
    { endTick: 9 },
    { endTick: 31 },
    { category: 'footstep' },
    { tick: Infinity },
    { actor: 'nickname' },
    { position: { x: NaN, y: 0, z: 0 } },
    { eventName: 'x'.repeat(129) },
  ])
    assert.throws(() => validateGameplaySoundCues([{ ...sounds[0], ...changed }], 0, 15, 30));
  assert.throws(() => validateGameplaySoundCues([...sounds, ...sounds]));
  const info = {
    coverage: {
      weapon: 'partial',
      footstep: 'unavailable',
      reload: 'unavailable',
      utility: 'unavailable',
      objective: 'unavailable',
      round: 'unavailable',
    },
    truncated: false,
  };
  assert.deepEqual(validateGameplaySoundInfo(info), info);
  assert.throws(() =>
    validateGameplaySoundInfo({ ...info, coverage: { ...info.coverage, footstep: 'inferred' } }),
  );
});

test('shared viewer audio stays lazy, survives development effect replay and stops every source on final release', async () => {
  const original = (globalThis as any).AudioContext;
  let created = 0,
    closed = 0,
    stopped = 0;
  class Context {
    state = 'suspended';
    destination = {};
    onstatechange: (() => void) | null = null;
    constructor() {
      created++;
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    async resume() {
      this.state = 'running';
      this.onstatechange?.();
    }
    async suspend() {
      this.state = 'suspended';
      this.onstatechange?.();
    }
    async close() {
      this.state = 'closed';
      closed++;
    }
  }
  (globalThis as any).AudioContext = Context;
  try {
    const audio = new ViewerAudio(),
      release = audio.retain();
    assert.equal(created, 0);
    assert.equal(audio.context, null);
    assert.equal(await audio.unlock(), true);
    assert.equal(await audio.unlock(), true);
    assert.equal(created, 1);
    class Source extends EventTarget {
      stop() {
        stopped++;
        this.dispatchEvent(new Event('ended'));
      }
      disconnect() {}
    }
    const source = new Source();
    assert.ok(audio.track(source as any, () => {}));
    release();
    const replayedRelease = audio.retain();
    await Promise.resolve();
    assert.equal(stopped, 1);
    assert.equal(closed, 0);
    await audio.unlock();
    assert.equal(created, 1);
    replayedRelease();
    await Promise.resolve();
    assert.equal(closed, 1);
    assert.equal(audio.context, null);
  } finally {
    (globalThis as any).AudioContext = original;
  }
});

test(
  'actor-less recorded positions remain spatial in free camera while known own-POV actions stay centered',
  { timeout: 5000 },
  async () => {
    const originalFetch = globalThis.fetch,
      originalContext = (globalThis as any).AudioContext,
      wave = originalSoundWAV(),
      panners: {
        positionX: { value: number };
        positionY: { value: number };
        positionZ: { value: number };
      }[] = [];
    let started: (() => void) | undefined;
    class Source extends EventTarget {
      buffer: unknown;
      playbackRate = { value: 1 };
      connect() {}
      disconnect() {}
      start() {
        started?.();
      }
      stop() {
        this.dispatchEvent(new Event('ended'));
      }
    }
    class Context {
      state = 'suspended';
      destination = {};
      sampleRate = 48000;
      currentTime = 0;
      onstatechange: (() => void) | null = null;
      createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
      }
      createBufferSource() {
        return new Source();
      }
      createPanner() {
        const panner = {
          positionX: { value: 0 },
          positionY: { value: 0 },
          positionZ: { value: 0 },
          connect() {},
          disconnect() {},
        };
        panners.push(panner);
        return panner;
      }
      async decodeAudioData() {
        return { duration: 0.25, numberOfChannels: 1, sampleRate: 48000, length: 12000 };
      }
      async resume() {
        this.state = 'running';
        this.onstatechange?.();
      }
      async close() {
        this.state = 'closed';
      }
    }
    globalThis.fetch = async () => new Response(wave, { headers: { 'Content-Type': 'audio/wav' } });
    (globalThis as any).AudioContext = Context;
    const audio = new ViewerAudio(),
      sounds = [
        { category: 'weapon' as const, soundId: 'ak47-fire' },
        { category: 'footstep' as const, soundId: 'footstep' },
        { category: 'reload' as const, soundId: 'reload-a99402fc6679' },
      ],
      playback = new GameplayPlayback(
        audio,
        {
          schemaVersion: 1,
          items: Object.fromEntries(
            sounds.map(({ soundId }) => [soundId, originalSoundDescriptor(soundId, wave)]),
          ),
        },
        (message) => assert.fail(message),
      );
    try {
      await audio.unlock();
      for (const { category, soundId } of sounds) {
        for (const ownActor of [undefined, '76561198000000001']) {
          const ready = new Promise<void>((resolve) => {
              started = resolve;
            }),
            before = panners.length;
          playback.sync(
            [
              {
                ...cue(`${category}-${ownActor ?? 'free'}`, 4),
                category,
                soundId,
                ...(ownActor ? { actor: ownActor } : {}),
                position: { x: 100, y: 200, z: 64 },
              },
            ],
            0,
            64,
            1,
            1,
            [category],
            true,
            `${category}-${ownActor ?? 'free'}`,
            () => assert.fail('Explicit recorded position must be used'),
            ownActor,
          );
          await ready;
          assert.equal(panners.length - before, ownActor ? 0 : 1, category);
          if (!ownActor) {
            const panner = panners.at(-1)!;
            assert.deepEqual(
              [panner.positionX.value, panner.positionY.value, panner.positionZ.value],
              [100 * 0.0254, 64 * 0.0254, -200 * 0.0254],
            );
          }
        }
      }
    } finally {
      playback.close();
      audio.close();
      globalThis.fetch = originalFetch;
      (globalThis as any).AudioContext = originalContext;
    }
  },
);

test('native decoder never receives an invalid PCM payload and failed assets do not retry per event', async () => {
  const original = globalThis.fetch,
    bad = originalSoundWAV();
  bad.writeUInt16LE(85, 20);
  const item = originalSoundDescriptor('ak47-fire', bad);
  let fetched = 0,
    decoded = 0;
  globalThis.fetch = async () => {
    fetched++;
    return new Response(bad, { headers: { 'Content-Type': 'audio/wav' } });
  };
  const buffers = new GameplaySoundBuffers(
    { schemaVersion: 1, items: { 'ak47-fire': item } },
    () =>
      ({
        sampleRate: 48000,
        decodeAudioData: async () => {
          decoded++;
          throw new Error('Must not decode');
        },
      }) as any,
  );
  try {
    await assert.rejects(buffers.get('ak47-fire'));
    await assert.rejects(buffers.get('ak47-fire'));
    assert.equal(fetched, 1);
    assert.equal(decoded, 0);
  } finally {
    buffers.close();
    globalThis.fetch = original;
  }
});

test('sound loading admits at most two fetches and cancellation drains queued identities without decoding', async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      fetched++;
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Canceled', 'AbortError')),
        { once: true },
      );
    });
  const items = Object.fromEntries(
    ['ak47-fire', 'aug-fire', 'awp-fire'].map((id) => [id, originalSoundDescriptor(id)]),
  );
  const buffers = new GameplaySoundBuffers({ schemaVersion: 1, items }, () => null);
  try {
    const pending = Object.keys(items).map((id) => buffers.get(id));
    await Promise.resolve();
    assert.equal(fetched, 2);
    buffers.cancel();
    const results = await Promise.allSettled(pending);
    assert.ok(results.every((result) => result.status === 'rejected'));
    assert.equal(fetched, 2);
  } finally {
    buffers.close();
    globalThis.fetch = original;
  }
});

test(
  'a newly requested sound cannot overtake a waking waiter and exceed the two-operation budget',
  { timeout: 5000 },
  async (t) => {
    const original = globalThis.fetch,
      wave = originalSoundWAV(),
      ids = ['ak47-fire', 'aug-fire', 'awp-fire', 'bizon-fire'],
      decodes: (() => void)[] = [],
      watchers: (() => void)[] = [];
    let fetched = 0,
      active = 0,
      peak = 0,
      digestCalls = 0;
    // Native hash completion may put B's decoder before A's. This scheduler
    // regression releases the first decoder then awaits A, so keep its identity
    // controlled while still hashing every actual payload with SHA-256.
    t.mock.method(crypto.subtle, 'digest', async (algorithm: string, bytes: ArrayBuffer) => {
      assert.equal(algorithm, 'SHA-256');
      assert.ok(bytes instanceof ArrayBuffer);
      digestCalls++;
      const digest = createHash('sha256').update(new Uint8Array(bytes)).digest();
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
    });
    globalThis.fetch = async () => {
      fetched++;
      return new Response(wave, { headers: { 'Content-Type': 'audio/wav' } });
    };
    const context = {
        sampleRate: 48000,
        decodeAudioData: () =>
          new Promise((resolve) => {
            active++;
            peak = Math.max(peak, active);
            let finished = false;
            decodes.push(() => {
              if (finished) return;
              finished = true;
              active--;
              resolve({ duration: 0.25, numberOfChannels: 1, sampleRate: 48000, length: 12000 });
            });
            for (const notify of watchers.splice(0)) notify();
          }),
      },
      waitForDecodes = async (count: number) => {
        while (decodes.length < count) await new Promise<void>((resolve) => watchers.push(resolve));
      },
      buffers = new GameplaySoundBuffers(
        {
          schemaVersion: 1,
          items: Object.fromEntries(ids.map((id) => [id, originalSoundDescriptor(id, wave)])),
        },
        () => context as any,
      ),
      tasks = ids.slice(0, 3).map((id) => buffers.get(id));
    try {
      await waitForDecodes(2);
      assert.equal(fetched, 2);
      // Resolve A, then request D in the microtask before the released waiter C
      // resumes. A wake-up does not reserve a permit; C must recheck capacity.
      decodes[0]();
      queueMicrotask(() => tasks.push(buffers.get(ids[3])));
      await tasks[0];
      assert.equal(fetched, 3, 'Only one of C/D may acquire the released slot');
      await waitForDecodes(3);
      assert.equal(peak, 2);
      decodes[1]();
      decodes[2]();
      await waitForDecodes(4);
      decodes[3]();
      await Promise.all(tasks);
      assert.equal(peak, 2);
      assert.equal(fetched, 4, 'Both queued sounds must eventually finish');
      assert.equal(digestCalls, 4, 'Every admitted sound still verifies its actual SHA-256');
    } finally {
      buffers.close();
      for (const finish of decodes) finish();
      await Promise.allSettled(tasks);
      globalThis.fetch = original;
    }
  },
);

test('busy sound delivery has a finite retry budget and failed cues cannot create a request loop', async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched++;
    return new Response('', { status: 429, headers: { 'Retry-After': '0.001' } });
  };
  const buffers = new GameplaySoundBuffers(
    { schemaVersion: 1, items: { 'ak47-fire': originalSoundDescriptor() } },
    () => null,
  );
  try {
    await assert.rejects(buffers.get('ak47-fire'));
    assert.equal(fetched, 3);
    await assert.rejects(buffers.get('ak47-fire'));
    assert.equal(fetched, 3);
  } finally {
    buffers.close();
    globalThis.fetch = original;
  }
});
