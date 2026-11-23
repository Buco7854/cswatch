/** Run locally after build, or feed to `docker run -i ... node --input-type=module`. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

process.env.LOG_LEVEL = 'warn';
const runtime = existsSync('backend/dist/server.js') ? resolve('backend/dist') : resolve('dist');
const moduleAt = (name) => import(pathToFileURL(join(runtime, name)).href);
const { createApp } = await moduleAt('server.js');
const { loadConfig } = await moduleAt('config.js');
const { processOne } = await moduleAt('worker.js');
const { Store } = await moduleAt('db.js');
const fixture =
  process.env.DEMO_FIXTURE ||
  (existsSync('/fixture/input.dem') ? '/fixture/input.dem' : resolve('var/fixture/input.dem'));
const root = mkdtempSync(join(tmpdir(), 'cswatch-runtime-'));
const origin = 'http://localhost:8000';
const config = loadConfig({
  APP_URL: origin,
  COOKIE_SECURE: 'false',
  DATA_DIR: root,
  ADMIN_USERNAME: 'runtime_instance_admin',
  ADMIN_PASSWORD: 'Disposable-instance-password-392!',
  FRONTEND_DIR: resolve(existsSync('frontend/dist') ? 'frontend/dist' : 'frontend'),
  MAX_UPLOAD_MB: '64',
  PARSER_TIMEOUT_SECONDS: '120',
  PARSER_SANDBOX: 'required',
});
const db = new Store(root);
const app = await createApp(config, db);
try {
  const headers = { host: 'localhost:8000', origin };
  const equipment = await app.inject({ method: 'GET', url: '/api/assets/equipment', headers });
  assert.equal(equipment.statusCode, 200, equipment.body);
  assert.deepEqual(
    equipment.json(),
    { icons: {} },
    'Proprietary equipment artwork is never bundled.',
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/assets/equipment/unknown.png', headers }))
      .statusCode,
    404,
  );
  const emptySounds = await app.inject({ method: 'GET', url: '/api/sound-assets', headers });
  assert.deepEqual(
    emptySounds.json(),
    { schemaVersion: 1, items: {} },
    'No proprietary audio is bundled.',
  );
  const sound = Buffer.alloc(1644);
  sound.write('RIFF');
  sound.writeUInt32LE(sound.length - 8, 4);
  sound.write('WAVEfmt ', 8);
  sound.writeUInt32LE(16, 16);
  sound.writeUInt16LE(1, 20);
  sound.writeUInt16LE(1, 22);
  sound.writeUInt32LE(8000, 24);
  sound.writeUInt32LE(16000, 28);
  sound.writeUInt16LE(2, 32);
  sound.writeUInt16LE(16, 34);
  sound.write('data', 36);
  sound.writeUInt32LE(1600, 40);
  const soundPath = join(root, 'maps', 'sounds', 'ak47-fire');
  mkdirSync(soundPath, { recursive: true });
  writeFileSync(join(soundPath, 'sound.wav'), sound);
  writeFileSync(
    join(soundPath, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'ak47-fire',
      extension: 'wav',
      sha256: createHash('sha256').update(sound).digest('hex'),
      bytes: sound.length,
      durationMs: 100,
      sampleRate: 8000,
      channels: 1,
    }),
  );
  const originalSound = await app.inject({
    method: 'GET',
    url: '/api/sound-assets/ak47-fire.wav',
    headers,
  });
  assert.equal(originalSound.statusCode, 200);
  assert.deepEqual(originalSound.rawPayload, sound);
  sound[100] = 1;
  writeFileSync(join(soundPath, 'sound.wav'), sound);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/sound-assets/ak47-fire.wav', headers }))
      .statusCode,
    404,
    'Same-size unverified sound replacement is not served.',
  );
  async function anonymousHeaders() {
    const status = await app.inject({ url: '/api/auth/me', headers });
    assert.equal(status.statusCode, 200);
    return {
      ...headers,
      cookie: status.cookies.map(({ name, value }) => name + '=' + value).join('; '),
      'x-csrf-token': status.json().session.csrf,
    };
  }
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: await anonymousHeaders(),
    payload: {
      display_name: 'runtime_fixture',
      email: 'runtime-fixture@example.invalid',
      password: 'Disposable-runtime-password-392!',
    },
  });
  assert.equal(registration.statusCode, 201, registration.body);
  const cookie = registration.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const authenticated = { ...headers, cookie, 'x-csrf-token': registration.json().user.csrf };
  const boundary = 'cswatch-runtime-boundary';
  const uploadFixture = (uploadHeaders) =>
    app.inject({
      method: 'POST',
      url: '/api/demos',
      headers: { ...uploadHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="runtime.dem"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        readFileSync(fixture),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  const upload = await uploadFixture(authenticated);
  assert.equal(upload.statusCode, 202, upload.body);
  const id = upload.json().id;
  assert.equal(await processOne(db, config), true);
  const detail = await app.inject({
    method: 'GET',
    url: `/api/demos/${id}`,
    headers: authenticated,
  });
  assert.equal(detail.json().status, 'ready', detail.body);
  const playback = await app.inject({
    method: 'GET',
    url: `/api/demos/${id}/playback`,
    headers: authenticated,
  });
  assert.equal(playback.statusCode, 200, playback.body);
  const manifest = JSON.parse(gunzipSync(playback.rawPayload).toString());
  assert.equal(manifest.version, 3);
  assert.equal(manifest.map, 'de_mirage');
  const recordedPerformance = JSON.parse(
    db.one('SELECT metadata FROM demos WHERE id=?', id).metadata,
  ).matchPerformance;
  const personal = Object.entries(recordedPerformance).find(
    ([, row]) =>
      Number.isSafeInteger(row.kills) &&
      Number.isSafeInteger(row.deaths) &&
      Number.isSafeInteger(row.assists),
  );
  assert.ok(personal, 'The confined parser publishes recorded match counters for the library.');
  const [steamId, stats] = personal;
  db.run("INSERT INTO identities VALUES('steam',?,?)", steamId, registration.json().user.id);
  const library = await app.inject({ method: 'GET', url: '/api/demos', headers: authenticated });
  assert.equal(library.statusCode, 200);
  assert.deepEqual(library.json().demos.find((demo) => demo.id === id).performance, stats);
  db.run("DELETE FROM identities WHERE provider='steam' AND subject=?", steamId);
  assert.equal(
    manifest.gameplaySounds?.coverage.footstep,
    'partial',
    'Recorded native footstep tokens survive confined parsing.',
  );
  assert.equal(
    manifest.gameplaySounds?.coverage.reload,
    'partial',
    'Recorded native reload sound tokens survive confined parsing.',
  );
  assert.equal(
    manifest.matchState?.complete,
    true,
    'Recorded match metadata survives worker publication.',
  );
  assert.ok(manifest.matchState.samples.length > 0 && manifest.matchState.samples.length <= 10000);
  assert.ok(
    manifest.matchState.samples.some(
      (state) =>
        Number.isSafeInteger(state.ctScore) &&
        state.ctScore >= 0 &&
        Number.isSafeInteger(state.tScore) &&
        state.tScore >= 0 &&
        (state.ctScore > 0 || state.tScore > 0),
    ),
    'The prepared replay carries actual recorded side scores, not default zeroes.',
  );
  assert.ok(
    manifest.matchState.samples.some(
      (state) =>
        state.phase === 'live' &&
        state.clock?.kind === 'round' &&
        Number.isFinite(state.clock.endTick),
    ),
    'Recorded round clocks survive manifest delivery.',
  );
  assert.deepEqual(manifest.eventAvailability, { player_death: true, player_hurt: true });
  assert.ok(manifest.throwInputs?.length > 0 && manifest.throwInputs.length <= 10000);
  const actors = new Set(manifest.players.map((player) => player.id));
  assert.ok(
    manifest.throwInputs.some(
      (snapshot) =>
        snapshot.provenance !== 'unavailable' &&
        typeof snapshot.input?.buttons === 'string' &&
        /^\d{1,20}$/.test(snapshot.input.buttons),
    ),
    'Actual recorded throw input snapshots survive publication.',
  );
  for (const snapshot of manifest.throwInputs) {
    const event = manifest.events[snapshot.eventIndex];
    assert.ok(actors.has(snapshot.actorId), 'Throw input belongs to a declared immutable player.');
    assert.equal(event?.tick, snapshot.tick, 'Throw input retains its exact global event index.');
    assert.equal(event?.user_steamid, snapshot.actorId);
  }
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/demos/${id}/playback`, headers })).statusCode,
    404,
    'Scores and input metadata remain private with the demo.',
  );
  const path = `/api/demos/${id}/playback/chunks/0`;
  assert.equal((await app.inject({ method: 'GET', url: path, headers })).statusCode, 404);
  const slice = await app.inject({ method: 'GET', url: path, headers: authenticated });
  assert.equal(slice.statusCode, 200);
  const chunk = JSON.parse(gunzipSync(slice.rawPayload).toString());
  assert.ok(chunk.frames.length <= 561);
  assert.equal(typeof manifest.itemState?.complete, 'boolean');
  assert.ok(Array.isArray(chunk.itemSamples));
  assert.ok(chunk.itemSamples.some((sample) => sample.present && sample.kind === 'dropped'));
  assert.ok(chunk.itemSamples.every((sample) => /^item:\d{1,5}:\d{1,6}:\d{1,7}$/.test(sample.id)));
  assert.equal(manifest.crosshairs?.complete, true);
  assert.ok(manifest.crosshairs.samples.length > 0 && manifest.crosshairs.samples.length <= 10000);
  assert.ok(
    manifest.crosshairs.samples.some(
      (sample) => typeof sample.code === 'string' && sample.code.startsWith('CSGO-'),
    ),
    'Recorded player crosshair changes survive the required parser sandbox and manifest validation.',
  );
  for (const [index, sample] of manifest.crosshairs.samples.entries()) {
    assert.ok(
      actors.has(sample.actor),
      'Crosshair evidence belongs to a declared immutable player.',
    );
    assert.ok(sample.tick >= 0 && sample.tick <= manifest.lastTick);
    if (index > 0) assert.ok(sample.tick >= manifest.crosshairs.samples[index - 1].tick);
  }
  assert.ok(
    chunk.frames.every((frame) =>
      frame.players.every((player) => !Object.hasOwn(player, 'crosshairCode')),
    ),
  );
  assert.ok(
    chunk.frames.some((frame) =>
      frame.players.some(
        (player) =>
          actors.has(player.id) &&
          player.stats &&
          ['kills', 'deaths', 'assists', 'headshotKills', 'damage'].some(
            (field) => Number.isSafeInteger(player.stats[field]) && player.stats[field] >= 0,
          ),
      ),
    ),
    'Actual native controller counters survive validation, publication and chunk delivery; absent fields remain optional.',
  );
  const note = await app.inject({
    method: 'POST',
    url: `/api/demos/${id}/bookmarks`,
    headers: authenticated,
    payload: { tick: manifest.firstTick, label: 'Disposable integration note' },
  });
  assert.equal(note.statusCode, 201, note.body);
  const share = await app.inject({
    method: 'PATCH',
    url: `/api/demos/${id}`,
    headers: authenticated,
    payload: { public: true },
  });
  assert.equal(share.statusCode, 200, share.body);
  assert.equal((await app.inject({ method: 'GET', url: path, headers })).statusCode, 200);
  const sharedPlayback = await app.inject({
    method: 'GET',
    url: `/api/demos/${id}/playback`,
    headers,
  });
  assert.equal(sharedPlayback.statusCode, 200, sharedPlayback.body);
  const sharedManifest = JSON.parse(gunzipSync(sharedPlayback.rawPayload).toString());
  assert.deepEqual(sharedManifest.matchState, manifest.matchState);
  assert.deepEqual(sharedManifest.throwInputs, manifest.throwInputs);
  const guest = await app.inject({
    method: 'POST',
    url: '/api/guest/session',
    headers: await anonymousHeaders(),
    payload: {},
  });
  assert.equal(guest.statusCode, 201, guest.body);
  const guestHeaders = {
    ...headers,
    cookie: guest.cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
    'x-csrf-token': guest.json().csrf,
  };
  const guestUpload = await uploadFixture(guestHeaders);
  assert.equal(guestUpload.statusCode, 202, guestUpload.body);
  const guestId = guestUpload.json().id;
  assert.equal(await processOne(db, config), true);
  const guestPlaybackPath = `/api/demos/${guestId}/playback`;
  const guestReplay = await app.inject({
    method: 'GET',
    url: guestPlaybackPath,
    headers: guestHeaders,
  });
  assert.equal(guestReplay.statusCode, 200, guestReplay.body);
  assert.equal(
    (await app.inject({ method: 'GET', url: guestPlaybackPath, headers })).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: guestPlaybackPath, headers: authenticated }))
      .statusCode,
    404,
    'A member account cannot read a different anonymous upload.',
  );
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: `/api/demos/${guestId}/playback/chunks/0`,
        headers: guestHeaders,
      })
    ).statusCode,
    200,
  );
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/demos/${guestId}`,
    headers: guestHeaders,
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(
    (await app.inject({ method: 'GET', url: guestPlaybackPath, headers: guestHeaders })).statusCode,
    404,
  );
  let transcription = 'not_requested';
  const model = process.env.CSWATCH_SMOKE_ASR_MODEL || '/models';
  const voiceSource = process.env.CSWATCH_SMOKE_VOICE_FIXTURE || '/voice-fixture';
  if (
    process.env.CSWATCH_REQUIRE_ASR_SMOKE === 'true' ||
    existsSync(join(model, 'config.json')) ||
    existsSync(join(voiceSource, 'manifest.json.gz'))
  ) {
    assert.ok(
      existsSync(join(model, 'config.json')),
      'Offline speech model is required for this smoke test.',
    );
    assert.ok(
      existsSync(join(voiceSource, 'manifest.json.gz')),
      'Public speech replay fixture is required for this smoke test.',
    );
    const { validateReplayArtifacts } = await moduleAt('replay.js');
    const { reserve } = await moduleAt('ingestion.js');
    const { processTranscriptionOne } = await moduleAt('transcription-worker.js');
    const prepared = validateReplayArtifacts(voiceSource);
    const speech = reserve(
      db,
      config,
      registration.json().user.id,
      'Public-domain speech integration fixture',
      'synthetic-qa',
    );
    mkdirSync(join(speech.folder, 'chunks'), { mode: 0o700 });
    for (const file of prepared.files)
      copyFileSync(join(voiceSource, file), join(speech.folder, file), constants.COPYFILE_EXCL);
    db.run(
      "UPDATE demos SET status='ready',transcription_status='queued',size=?,metadata=? WHERE id=?",
      prepared.bytes,
      JSON.stringify({
        replayVersion: prepared.manifest.version,
        communications: prepared.manifest.communications,
      }),
      speech.id,
    );
    const asrConfig = {
      ...config,
      flags: { ...config.flags, transcription_enabled: true },
      transcriptionModelDir: resolve(model),
      transcriptionTimeoutSeconds: 120,
      transcriptionLanguage: 'auto',
    };
    assert.equal(await processTranscriptionOne(db, asrConfig), true);
    assert.equal(
      db.one('SELECT status,transcription_status FROM demos WHERE id=?', speech.id).status,
      'ready',
    );
    const captionPath = `/api/demos/${speech.id}/captions`;
    assert.equal((await app.inject({ method: 'GET', url: captionPath, headers })).statusCode, 404);
    const captions = await app.inject({ method: 'GET', url: captionPath, headers: authenticated });
    assert.equal(captions.statusCode, 200, captions.body);
    assert.equal(captions.headers['content-encoding'], 'gzip');
    const result = JSON.parse(gunzipSync(captions.rawPayload).toString());
    assert.equal(result.status, 'ready');
    assert.match(result.cues.map((cue) => cue.text).join(' '), /fellow Americans/i);
    assert.ok(
      result.cues.every((cue) => cue.language === 'en' && cue.source === 'local-transcription'),
    );
    transcription = 'passed';
  }
  console.log(
    JSON.stringify({
      runtime: 'passed',
      map: manifest.map,
      chunks: manifest.chunks.length,
      players: manifest.players.length,
      matchStateSamples: manifest.matchState.samples.length,
      throwInputs: manifest.throwInputs.length,
      recordedPlayerCounters: true,
      libraryPlayers: Object.keys(recordedPerformance).length,
      libraryRanks: Object.values(recordedPerformance).filter((row) => row.rank).length,
      recordedCrosshairs: true,
      privateGuestUpload: true,
      sandbox: 'required',
      upload: true,
      ownership: true,
      notes: true,
      explicitSharing: true,
      transcription,
    }),
  );
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
