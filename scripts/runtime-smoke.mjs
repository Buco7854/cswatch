/** Run locally after build, or feed to `docker run -i ... node --input-type=module`. */
import assert from 'node:assert/strict';
import {
  existsSync,
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
  FRONTEND_DIR: resolve(existsSync('frontend/dist') ? 'frontend/dist' : 'frontend'),
  MAX_UPLOAD_MB: '64',
  PARSER_TIMEOUT_SECONDS: '120',
  PARSER_SANDBOX: 'required',
});
const db = new Store(root);
const app = await createApp(config, db);
try {
  const headers = { host: 'localhost:8000', origin };
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { username: 'runtime_fixture', password: 'Disposable-runtime-password-392!' },
  });
  assert.equal(registration.statusCode, 201, registration.body);
  const cookie = registration.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const authenticated = { ...headers, cookie, 'x-csrf-token': registration.json().user.csrf };
  const boundary = 'cswatch-runtime-boundary';
  const upload = await app.inject({
    method: 'POST',
    url: '/api/demos',
    headers: { ...authenticated, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="runtime.dem"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      readFileSync(fixture),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
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
  const manifest = JSON.parse(gunzipSync(playback.rawPayload).toString());
  assert.equal(manifest.version, 2);
  assert.equal(manifest.map, 'de_mirage');
  const path = `/api/demos/${id}/playback/chunks/0`;
  assert.equal((await app.inject({ method: 'GET', url: path, headers })).statusCode, 404);
  const slice = await app.inject({ method: 'GET', url: path, headers: authenticated });
  assert.equal(slice.statusCode, 200);
  assert.ok(JSON.parse(gunzipSync(slice.rawPayload).toString()).frames.length <= 561);
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
      JSON.stringify({ communications: { voice: 'available' } }),
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
