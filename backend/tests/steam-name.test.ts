import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { ProviderRequests } from '../src/provider-requests.js';
import { loadConfig } from '../src/config.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanSteamName, fetchSteamName } from '../src/steam-name.js';

const subject = '76561198000000001';
const xml = (name: string, id = subject) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><profile>\n\t<steamID64>${id}</steamID64>\n\t<steamID><![CDATA[${name}]]></steamID>\n\t<onlineState>offline</onlineState></profile>`;

test('Steam names keep any script on one bounded line without hidden or reordering characters', () => {
  assert.equal(cleanSteamName("  Подсосник\n blick'a "), "Подсосник blick'a");
  assert.equal(cleanSteamName('a‮b​c\u0000d'), 'abcd');
  assert.equal(cleanSteamName('🔥'.repeat(40)), '🔥'.repeat(32));
  assert.equal(cleanSteamName('<b>x</b>'), '<b>x</b>');
  for (const empty of ['', '   ', '​⁠', '́', undefined, 5, null])
    assert.equal(cleanSteamName(empty), null);
});

test('the Steam name comes from one fixed official source and never throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steam-profile-'));
  const db = new Store(dir);
  const requests = new ProviderRequests(db, loadConfig({ COOKIE_SECURE: 'false' }).providerLimits);
  const original = globalThis.fetch;
  const urls: string[] = [];
  let response: () => Response = () => new Response('');
  globalThis.fetch = async (input, options) => {
    urls.push(String(input));
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    return response();
  };
  try {
    response = () => new Response(xml('Tom &amp; J&lt;3'));
    assert.equal(await fetchSteamName(subject, '', requests), 'Tom & J<3');
    assert.equal(urls.at(-1), `https://steamcommunity.com/profiles/${subject}/?xml=1`);
    for (const body of [
      xml('Other', '76561198000000002'),
      xml('x'.repeat(300)),
      '<html><steamID><![CDATA[Page]]></steamID></html>',
      'x'.repeat(600 * 1024),
    ]) {
      response = () => new Response(body);
      assert.equal(await fetchSteamName(subject, '', requests), null);
    }
    response = () =>
      Response.json({ response: { players: [{ steamid: subject, personaname: ' Rifler ' }] } });
    assert.equal(await fetchSteamName(subject, 'operator-key', requests), 'Rifler');
    assert.equal(
      urls.at(-1),
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=operator-key&steamids=${subject}`,
    );
    response = () =>
      Response.json({ response: { players: [{ steamid: '1', personaname: 'Other' }] } });
    assert.equal(await fetchSteamName(subject, 'operator-key', requests), null);
    response = () => new Response('', { status: 429 });
    assert.equal(await fetchSteamName(subject, '', requests), null);

    db.run("DELETE FROM settings WHERE key='provider_retry_steamProfile'");
    response = () => {
      throw new Error('offline');
    };
    assert.equal(await fetchSteamName(subject, '', requests), null);
    const before = urls.length;
    assert.equal(await fetchSteamName('../evil', '', requests), null);
    assert.equal(urls.length, before);
  } finally {
    globalThis.fetch = original;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
