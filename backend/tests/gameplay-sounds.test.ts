import { fixtureCookie, insertFixtureSession } from './fixtures/member-session.js';
import { test } from 'node:test';
process.env.LOG_LEVEL = 'silent';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import {
  eventGameplaySounds,
  indexNativeSoundEvidence,
  observeGameplaySounds,
} from '../src/gameplay-sounds.js';
import type { GameplaySoundCue } from '../../shared/gameplay-sounds.js';
import { gameplaySoundAssetRoutes } from '../src/gameplay-sound-assets.js';
import { managedSoundDirectory } from '../../shared/gameplay-sound-bank.mjs';
import { inspectGameplayAudio } from '../../shared/gameplay-sound-files.mjs';
import { sample } from '../../frontend/src/sample.js';
import { writeReplay, validateReplayArtifacts } from '../src/replay.js';
function wav(samples = 800, rate = 8000) {
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  return data;
}
function prepared(folder: string, id = 'ak47-fire', data = wav()) {
  const path = join(folder, 'sounds', id);
  mkdirSync(path, { recursive: true });
  const audio = inspectGameplayAudio(data);
  writeFileSync(join(path, 'sound.wav'), data);
  writeFileSync(
    join(path, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      extension: 'wav',
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.length,
      durationMs: audio.durationMs,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
    }),
  );
  return path;
}
test('only a recorded winning side selects a classic announcement at the round_end tick', () => {
  const cues = eventGameplaySounds(
    [
      { type: 'round_end', tick: 8971, winner: 2, reason: 9 },
      { type: 'round_mvp', tick: 8971, musickitid: 68, nomusic: 0 },
      { type: 'round_start', tick: 9419 },
      { type: 'bomb_defused', tick: 15232 },
      { type: 'round_end', tick: 15232, winner: 3, reason: 7 },
      { type: 'round_end', tick: 31197, reason: 8 },
      { type: 'round_end', tick: 56705, winner: 2, reason: 18 },
    ],
    new Set(),
  );
  assert.deepEqual(
    cues.map(({ tick, soundId }) => [tick, soundId]),
    [
      [8971, 'round-t-win'],
      [15232, 'bomb-defuse'],
      [15232, 'round-ct-win'],
      [56705, 'round-t-win'],
    ],
  );
});

test('audio containers bound decoded duration/rate and reject truncated or changed MPEG frames before decoding', () => {
  assert.equal(inspectGameplayAudio(wav()).durationMs, 100);
  assert.throws(() => inspectGameplayAudio(wav(80001)), /duration/);
  const corrupt = wav();
  corrupt.writeUInt32LE(0xfffffff0, 40);
  assert.throws(() => inspectGameplayAudio(corrupt));
  const mp3 = Buffer.alloc(417);
  mp3.set([255, 251, 144, 0]);
  assert.throws(() => inspectGameplayAudio(mp3), /PCM/);
  assert.throws(() => inspectGameplayAudio(mp3.subarray(0, 416)), /PCM/);
  const xing = Buffer.from(mp3);
  xing.write('Xing', 36);
  xing.writeUInt32BE(2147483647, 44);
  assert.throws(() => inspectGameplayAudio(xing), /PCM/);
  const changed = Buffer.from(mp3);
  changed[2] = 148;
  assert.throws(() => inspectGameplayAudio(Buffer.concat([mp3, changed])));
});
test('event audio never invents steps/reloads or unknown guns and keeps actor/recorded coordinates explicit', () => {
  const cues = eventGameplaySounds(
    [
      {
        type: 'weapon_fire',
        tick: 10,
        weapon: 'ak47',
        user_steamid: '1',
        user_X: 10,
        user_Y: 20,
        user_Z: 30,
      },
      { type: 'weapon_fire', tick: 11, weapon: 'unknown' },
      { type: 'player_footstep', tick: 12 },
      { type: 'weapon_reload', tick: 13 },
    ],
    new Set(['1']),
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].selection, 'representative');
  assert.deepEqual(cues[0].position, { x: 10, y: 20, z: 30 });
  const missing = eventGameplaySounds(
    [{ type: 'weapon_fire', tick: 10, weapon: 'ak47', user_steamid: 'x' }],
    new Set(['1']),
  )[0];
  assert.equal(missing.position, undefined);
  assert.equal(missing.actor, undefined);
});
test('operator samples take precedence while missing samples appear when the managed generation publishes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-sound-generation-'));
  const app = Fastify();
  await gameplaySoundAssetRoutes(app, root, root);
  try {
    const operator = wav(401),
      automatic = wav(402),
      knife = 'knife-hit-slice';
    const path = prepared(root, 'ak47-fire', operator);
    prepared(join(root, 'sounds-' + '0'.repeat(64)), knife, automatic);
    const catalog = async () => (await app.inject('/api/sound-assets')).json().items;
    assert.deepEqual(Object.keys(await catalog()), ['ak47-fire']);
    const bank = join(root, managedSoundDirectory);
    prepared(bank, 'ak47-fire', automatic);
    prepared(bank, knife, automatic);
    const items = await catalog();
    assert.equal(items['ak47-fire'].sha256, createHash('sha256').update(operator).digest('hex'));
    assert.deepEqual((await app.inject(items['ak47-fire'].url)).rawPayload, operator);
    assert.deepEqual((await app.inject(items[knife].url)).rawPayload, automatic);
    rmSync(join(path, 'manifest.json'));
    assert.equal((await catalog())['ak47-fire'], undefined);
    assert.equal((await app.inject('/api/sound-assets/ak47-fire.wav')).statusCode, 404);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('sound HTTP delivery is registry/hash bound, rejects links and sees same-size in-place corruption', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-sound-route-'));
  const app = Fastify();
  await gameplaySoundAssetRoutes(app, root, root);
  try {
    const path = prepared(root);
    const get = () => app.inject('/api/sound-assets/ak47-fire.wav');
    assert.equal((await get()).statusCode, 200);
    const catalog = (await app.inject('/api/sound-assets')).json();
    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.items['ak47-fire'].mime, 'audio/wav');
    const body = wav();
    body[100] = 1;
    writeFileSync(join(path, 'sound.wav'), body);
    assert.equal((await get()).statusCode, 404);
    rmSync(join(path, 'sound.wav'));
    symlinkSync('/etc/passwd', join(path, 'sound.wav'));
    assert.equal((await get()).statusCode, 404);
    assert.equal((await app.inject('/api/sound-assets/not-in-registry.wav')).statusCode, 404);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('chunked sound cues retain shared-boundary identities without growing global metadata; forged actor/time fails publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-sound-replay-'));
  try {
    const cue = {
      id: 'sound0',
      tick: sample.frames[480].tick,
      soundId: 'ak47-fire',
      category: 'weapon' as const,
      evidence: 'game-event' as const,
      selection: 'representative' as const,
      actor: sample.players[0].id,
    };
    const gameplaySounds = {
      coverage: {
        weapon: 'partial' as const,
        footstep: 'unavailable' as const,
        reload: 'unavailable' as const,
        utility: 'unavailable' as const,
        objective: 'unavailable' as const,
        round: 'unavailable' as const,
      },
      truncated: false,
    };
    await writeReplay(root, { ...sample, sounds: [cue], gameplaySounds });
    const result = validateReplayArtifacts(root);
    assert.equal('sounds' in result.manifest, false);
    assert.equal(result.manifest.gameplaySounds?.coverage.weapon, 'partial');
    const path = join(root, 'chunks/0.json.gz'),
      chunk = JSON.parse(gunzipSync(readFileSync(path)).toString());
    assert.equal(chunk.sounds[0].id, 'sound0');
    chunk.sounds[0].actor = '999999999999';
    const encoded = JSON.stringify(chunk);
    writeFileSync(path, gzipSync(encoded));
    const mp = join(root, 'manifest.json.gz'),
      manifest = JSON.parse(gunzipSync(readFileSync(mp)).toString());
    manifest.chunks[0].bytes = Buffer.byteLength(encoded);
    writeFileSync(mp, gzipSync(JSON.stringify(manifest)));
    assert.throws(() => validateReplayArtifacts(root), /sound identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native sound tokens distinguish event/parameter seeds and reject malformed packed positions', async () => {
  const { soundTokenHash, packedSoundPosition } = await import('../src/sound-event-tokens.js');
  assert.equal(soundTokenHash('T_Concrete.StepLeft'), 4163677892);
  assert.equal(soundTokenHash('CT_Concrete.StepLeft'), 1194677450);
  assert.equal(soundTokenHash('public.position', 0x31415926), 1518128717);
  const bytes = Buffer.alloc(19);
  bytes.writeUInt32LE(1518128717);
  bytes[4] = 10;
  bytes.writeUInt16LE(12, 5);
  bytes.writeFloatLE(100, 7);
  bytes.writeFloatLE(-200, 11);
  bytes.writeFloatLE(50, 15);
  assert.deepEqual(packedSoundPosition(bytes), {
    valid: true,
    position: { x: 100, y: -200, z: 50 },
  });
  assert.equal(packedSoundPosition(Buffer.concat([bytes, bytes])).valid, false);
  assert.equal(packedSoundPosition(bytes.subarray(0, 18)).valid, false);
  const invalid = Buffer.from(bytes);
  invalid.writeFloatLE(Infinity, 7);
  assert.equal(packedSoundPosition(invalid).valid, false);
  assert.equal(packedSoundPosition(Buffer.alloc(257)).valid, false);
});
test('recorded native surface/reload cues retain exact names and stop evidence without inferring unknown events', () => {
  const handlers = new Map<string, (value: any) => void>();
  const reader = {
    currentTick: 100,
    on: (name: string, callback: (message: any) => void) => handlers.set(name, callback),
  };
  const finish = observeGameplaySounds(reader as any, 500, new Set(['1']));
  const position = Buffer.alloc(19);
  position.writeUInt32LE(1518128717);
  position[4] = 10;
  position.writeUInt16LE(12, 5);
  position.writeFloatLE(10, 7);
  position.writeFloatLE(20, 11);
  position.writeFloatLE(30, 15);
  handlers.get('GE_SosStartSoundEvent')!({
    soundevent_guid: 1,
    soundevent_hash: 4163677892,
    packed_params: position,
  });
  reader.currentTick = 102;
  handlers.get('GE_SosStopSoundEvent')!({ soundevent_guid: 1 });
  handlers.get('CS_UM_WeaponSound')!({
    sound: 'Weapon_AK47.Clipout',
    origin_x: 1,
    origin_y: 2,
    origin_z: 3,
  });
  handlers.get('CS_UM_WeaponSound')!({ sound: 'not-a-known-token' });
  const result = finish(true, []);
  assert.equal(result.sounds.length, 2);
  assert.equal(result.sounds[0].eventName, 'T_Concrete.StepLeft');
  assert.equal(result.sounds[0].endTick, 102);
  assert.deepEqual(result.sounds[0].position, { x: 10, y: 20, z: 30 });
  assert.equal(result.sounds[1].category, 'reload');
  assert.equal(result.sounds[1].eventName, 'Weapon_AK47.Clipout');
  assert.equal(result.gameplaySounds.coverage.footstep, 'partial');
});
test('recorded knife swings distinguish light, heavy, gear and impacts at the reported position', () => {
  const handlers = new Map<string, (value: any) => void>();
  const reader = {
    currentTick: 100,
    on: (name: string, fn: (value: any) => void) => handlers.set(name, fn),
  };
  const finish = observeGameplaySounds(reader as any, 500, new Set());
  const cases = [
    ['Weapon_Knife.Swish.Light', 'knife-swish-light', 0.03],
    ['Weapon_Knife.Swish.Heavy', 'knife-swish-heavy', 0.04],
    ['Weapon_Knife.Swish.Gear', 'knife-swish-gear', 0.04],
    ['Weapon_Knife.Swish.Gear.Quiet', 'knife-swish-gear', 0.01],
    ['Weapon_Knife.Hit.Light.Backstab', 'knife-hit-light-backstab', 0.55],
  ] as const;
  for (const [sound] of cases) {
    handlers.get('CS_UM_WeaponSound')!({ sound, origin_x: 8, origin_y: 1, origin_z: -12 });
    reader.currentTick++;
  }
  const cues = finish(true, []).sounds;
  assert.deepEqual(
    cues.map((c) => [c.eventName, c.soundId, c.volume]),
    cases,
  );
  assert.ok(cues.every((c) => c.evidence === 'network-sound'));
  assert.deepEqual(cues[1].position, { x: 8, y: 1, z: -12 });
});
test('oversized native sound text is rejected before case-folding while known bounded tokens remain usable', () => {
  const handlers = new Map<string, (value: any) => void>();
  const reader = {
    currentTick: 100,
    on: (name: string, callback: (message: any) => void) => handlers.set(name, callback),
  };
  const finish = observeGameplaySounds(reader as any, 500, new Set());
  const lowercase = String.prototype.toLowerCase;
  let oversizedCalls = 0;
  try {
    String.prototype.toLowerCase = function (this: string) {
      if (this.length > 128) oversizedCalls++;
      return lowercase.call(this);
    };
    handlers.get('CS_UM_WeaponSound')!({ sound: 'A'.repeat(129) });
    handlers.get('CS_UM_WeaponSound')!({ sound: 'Weapon_AK47.Clipout' });
  } finally {
    String.prototype.toLowerCase = lowercase;
  }
  assert.equal(oversizedCalls, 0);
  const result = finish(true, []);
  assert.equal(result.sounds.length, 1);
  assert.equal(result.sounds[0].eventName, 'Weapon_AK47.Clipout');
});
test('native sound dedup respects known actor and position identity without fabricating missing evidence', () => {
  const native: GameplaySoundCue = {
    id: 'native',
    tick: 100,
    soundId: 'fire-ignite',
    category: 'utility',
    evidence: 'network-sound',
    selection: 'representative',
    actor: '1',
    position: { x: 10, y: 20, z: 30 },
  };
  const matches = indexNativeSoundEvidence([native]);
  assert.equal(matches({ ...native, id: 'same' }, 100), true);
  assert.equal(matches({ ...native, id: 'other-actor', actor: '2' }, 100), false);
  assert.equal(
    matches({ ...native, id: 'other-position', position: { x: 11, y: 20, z: 30 } }, 100),
    false,
  );
  assert.equal(matches({ ...native, id: 'no-actor', actor: undefined }, 100), true);
  assert.equal(matches({ ...native, id: 'no-position', position: undefined }, 100), true);
  assert.equal(matches(native, 99), false);
  assert.deepEqual(native.position, { x: 10, y: 20, z: 30 });
});
test('native ignition suppresses its same-position fallback while preserving distinct simultaneous fire and primary events', async () => {
  const { soundTokenHash } = await import('../src/sound-event-tokens.js');
  const handlers = new Map<string, (value: any) => void>();
  const reader = {
    currentTick: 100,
    on: (name: string, callback: (message: any) => void) => handlers.set(name, callback),
  };
  const finish = observeGameplaySounds(reader as any, 500, new Set(['1', '2']));
  const position = Buffer.alloc(19);
  position.writeUInt32LE(1518128717);
  position[4] = 10;
  position.writeUInt16LE(12, 5);
  position.writeFloatLE(10, 7);
  position.writeFloatLE(20, 11);
  position.writeFloatLE(30, 15);
  handlers.get('GE_SosStartSoundEvent')!({
    soundevent_guid: 1,
    soundevent_hash: soundTokenHash('Inferno.Fire.Ignite'),
    packed_params: position,
  });
  const primary = [
    { type: 'inferno_startburn', tick: 100, user_steamid: '1', x: 10, y: 20, z: 30 },
    { type: 'inferno_startburn', tick: 100, user_steamid: '2', x: 400, y: 500, z: 30 },
    { type: 'inferno_startburn', tick: 101, user_steamid: '1', x: 10, y: 20, z: 30 },
    { type: 'inferno_startburn', tick: 103, user_steamid: '1', x: 10, y: 20, z: 30 },
    { type: 'hegrenade_detonate', tick: 100, x: 10, y: 20, z: 30 },
  ];
  const original = structuredClone(primary);
  const result = finish(true, primary);
  const fire = result.sounds.filter((cue) => cue.soundId === 'fire-ignite');
  assert.equal(fire.length, 3);
  assert.equal(fire.filter((cue) => cue.evidence === 'network-sound').length, 1);
  assert.deepEqual(
    fire.filter((cue) => cue.evidence === 'game-event').map((cue) => [cue.tick, cue.position]),
    [
      [100, { x: 400, y: 500, z: 30 }],
      [103, { x: 10, y: 20, z: 30 }],
    ],
  );
  assert.equal(result.sounds.filter((cue) => cue.soundId === 'he-explode').length, 1);
  assert.deepEqual(primary, original);
});
test('dense optional sound evidence caps and reports truncation independently of primary replay events', () => {
  const handlers = new Map<string, (value: any) => void>();
  const reader = {
    currentTick: 100,
    on: (name: string, callback: (message: any) => void) => handlers.set(name, callback),
  };
  const finish = observeGameplaySounds(reader as any, 500, new Set());
  for (let i = 0; i < 1000; i++)
    handlers.get('CS_UM_WeaponSound')!({ sound: 'Weapon_AK47.Clipout' });
  const result = finish(true, []);
  assert.equal(result.sounds.length, 256);
  assert.equal(result.gameplaySounds.truncated, true);
  assert.equal(result.gameplaySounds.coverage.reload, 'partial');
});

test('optional audio overflow after partial chunk writing retries primary replay intact and reports unavailable audio', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sound-optional-overflow-'));
  try {
    const sounds = Array.from({ length: 5000 }, (_, i) => ({
      id: `dense-${i}`,
      tick: sample.frames[10].tick,
      soundId: 'ak47-fire',
      category: 'weapon' as const,
      evidence: 'game-event' as const,
      selection: 'representative' as const,
    }));
    await writeReplay(folder, {
      ...sample,
      sounds,
      gameplaySounds: {
        coverage: {
          weapon: 'partial',
          footstep: 'unavailable',
          reload: 'unavailable',
          utility: 'unavailable',
          objective: 'unavailable',
          round: 'unavailable',
        },
        truncated: false,
      },
    });
    const result = validateReplayArtifacts(folder);
    assert.equal(result.manifest.gameplaySounds?.truncated, true);
    assert.equal(result.manifest.gameplaySounds?.coverage.weapon, 'unavailable');
    assert.deepEqual(result.manifest.events, sample.events);
    assert.equal(result.manifest.firstTick, sample.frames[0].tick);
    assert.equal(result.manifest.lastTick, sample.frames.at(-1)!.tick);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('gameplay sound discovery and bytes obey first-setup and private-instance access policies', async () => {
  const { createApp } = await import('../src/server.js');
  const { Store, now } = await import('../src/db.js');
  const { loadConfig } = await import('../src/config.js');
  const { initializeFixture } = await import('./fixtures/initialized.js');
  const root = mkdtempSync(join(tmpdir(), 'sound-access-'));
  try {
    for (const initialized of [false, true]) {
      const directory = join(root, String(initialized)),
        db = new Store(directory);
      if (initialized) initializeFixture(db);
      const config = loadConfig({
        DATA_DIR: directory,
        APP_URL: 'http://localhost:8000',
        COOKIE_SECURE: 'false',
        MFA_REQUIRED_ROLES: 'none',
        PUBLIC_ACCESS: 'false',
      });
      prepared(join(directory, 'maps'));
      const app = await createApp(config, db);
      try {
        for (const url of ['/api/sound-assets', '/api/sound-assets/ak47-fire.wav'])
          assert.equal(
            (await app.inject({ url, headers: { host: 'localhost:8000' } })).statusCode,
            initialized ? 401 : 503,
          );
        if (initialized) {
          insertFixtureSession(
            db,
            'sound-fixture-session',
            'fixture-instance-admin',
            'csrf',
            now() + 60,
          );
          const response = await app.inject({
            url: '/api/sound-assets/ak47-fire.wav',
            headers: { host: 'localhost:8000', cookie: fixtureCookie('sound-fixture-session') },
          });
          assert.equal(response.statusCode, 200);
        }
      } finally {
        await app.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('payload admission remains bounded until responses finish, then releases slots exactly once', async () => {
  const { createApp } = await import('../src/server.js');
  const { Store } = await import('../src/db.js');
  const { loadConfig } = await import('../src/config.js');
  const { initializeFixture } = await import('./fixtures/initialized.js');
  const root = mkdtempSync(join(tmpdir(), 'sound-response-budget-'));
  const db = new Store(join(root, 'data'));
  initializeFixture(db);
  const app = await createApp(
    loadConfig({
      DATA_DIR: db.root,
      MAP_ASSETS_DIR: root,
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      MFA_REQUIRED_ROLES: 'none',
      PUBLIC_ACCESS: 'true',
    }),
    db,
  );
  const request = () =>
    app.inject({ url: '/api/sound-assets/ak47-fire.wav', headers: { host: 'localhost:8000' } });
  prepared(root);
  let entered = 0,
    unblock!: () => void,
    ready!: () => void;
  const gate = new Promise<void>((resolve) => (unblock = resolve)),
    both = new Promise<void>((resolve) => (ready = resolve));
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.endsWith('/ak47-fire.wav') && reply.statusCode === 200) {
      if (++entered === 2) ready();
      await gate;
    }
    return payload;
  });
  try {
    const a = request(),
      b = request();
    const pending = Promise.all([a, b]);
    await both;
    const busy = await request();
    assert.equal(busy.statusCode, 429);
    assert.equal(busy.headers['retry-after'], '2');
    unblock();
    assert.deepEqual(
      (await pending).map((r) => r.statusCode),
      [200, 200],
    );
    assert.equal((await request()).statusCode, 200);
  } finally {
    unblock();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('native plant completion suppresses only its redundant representative fallback and preserves simultaneous distinct grenade actions', async () => {
  const { soundTokenHash } = await import('../src/sound-event-tokens.js');
  const handlers = new Map<string, (value: any) => void>(),
    reader = {
      currentTick: 100,
      on: (name: string, callback: (value: any) => void) => handlers.set(name, callback),
    };
  const finish = observeGameplaySounds(reader as any, 500, new Set(['1']));
  const position = (x: number, y: number, z: number) => {
    const bytes = Buffer.alloc(19);
    bytes.writeUInt32LE(1518128717);
    bytes[4] = 10;
    bytes.writeUInt16LE(12, 5);
    bytes.writeFloatLE(x, 7);
    bytes.writeFloatLE(y, 11);
    bytes.writeFloatLE(z, 15);
    return bytes;
  };
  const native = handlers.get('GE_SosStartSoundEvent')!;
  native({
    soundevent_guid: 1,
    soundevent_hash: soundTokenHash('c4.plantquiet'),
    packed_params: position(10, 20, 30),
  });
  native({
    soundevent_guid: 2,
    soundevent_hash: soundTokenHash('HEGrenade.Bounce'),
    packed_params: position(100, 200, 30),
  });
  const primary = [
    { type: 'bomb_planted', tick: 100, user_steamid: '1' },
    { type: 'hegrenade_detonate', tick: 100, x: 100, y: 200, z: 30 },
    { type: 'flashbang_detonate', tick: 100, x: -100, y: -200, z: 30 },
    { type: 'bomb_planted', tick: 101, x: 10, y: 20, z: 30 },
    { type: 'bomb_planted', tick: 102, x: 400, y: 500, z: 30 },
    { type: 'bomb_planted', tick: 103, x: 10, y: 20, z: 30 },
  ];
  const original = JSON.stringify(primary),
    result = finish(true, primary);
  assert.equal(result.sounds.filter((c) => c.soundId === 'bomb-plant').length, 2);
  assert.deepEqual(
    result.sounds.filter((c) => c.soundId === 'bomb-plant').map((c) => c.tick),
    [102, 103],
  );
  const nativePlant = result.sounds.find((c) => c.eventName === 'c4.plantquiet')!;
  assert.ok(nativePlant);
  assert.equal(nativePlant.evidence, 'network-sound');
  assert.equal(nativePlant.volume, 0.4);
  assert.deepEqual(nativePlant.position, { x: 10, y: 20, z: 30 });
  assert.equal(result.sounds.filter((c) => c.eventName === 'HEGrenade.Bounce').length, 1);
  assert.equal(result.sounds.filter((c) => c.soundId === 'he-explode').length, 1);
  assert.equal(result.sounds.filter((c) => c.soundId === 'flash-explode').length, 1);
  assert.equal(JSON.stringify(primary), original);
});
