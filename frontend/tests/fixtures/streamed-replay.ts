import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Route } from '@playwright/test';
import { writeReplay } from '../../../backend/src/replay';
import type { Playback, PlaybackManifest } from '../../../shared/playback';

/** Replay fixtures exercise the same manifest/chunk contract as prepared recordings. */
export async function replayFixture(data: Playback) {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-fixture-'));
  try {
    await writeReplay(folder, data);
    const body = (file: string) => gunzipSync(readFileSync(join(folder, file))).toString();
    const manifest = JSON.parse(body('manifest.json.gz')) as PlaybackManifest;
    if (data.worldBounds) manifest.worldBounds = data.worldBounds;
    return {
      manifest,
      chunks: manifest.chunks.map(({ index }) => body(`chunks/${index}.json.gz`)),
    };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export async function fulfillReplayFixture(route: Route, data: Playback) {
  const { manifest, chunks } = await replayFixture(data);
  const request = route.request();
  const page = request.frame().page();
  await page.route(`${request.url()}/chunks/*`, (chunkRoute) => {
    const index = Number(new URL(chunkRoute.request().url()).pathname.split('/').at(-1));
    const chunk = chunks[index];
    return chunk === undefined
      ? chunkRoute.fulfill({ status: 404 })
      : chunkRoute.fulfill({ contentType: 'application/json', body: chunk });
  });
  return route.fulfill({ json: manifest });
}
