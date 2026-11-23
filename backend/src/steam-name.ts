import { z } from 'zod';
import type { ProviderRequests } from './provider-requests.js';
import { requestProvider, readUpstreamJson, readUpstreamText } from './upstream.js';

const maxLength = 32;
const entities: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** Steam names are free text. Keep one readable line without hidden or reordering characters. */
export function cleanSteamName(value: unknown) {
  if (typeof value !== 'string') return null;
  const visible = value
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, '');
  const name = [...visible.trim()].slice(0, maxLength).join('').trim();
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(name) ? name : null;
}

const summaries = z.object({
  response: z.object({
    players: z.array(z.object({ steamid: z.string(), personaname: z.string() })).max(1),
  }),
});
const profile =
  /^\s*(?:<\?xml[^>]{0,120}\?>\s*)?<profile>\s*<steamID64>(\d{17})<\/steamID64>\s*<steamID><!\[CDATA\[([\s\S]{0,256}?)\]\]><\/steamID>/;

/** A missing name never blocks sign-in. The public profile needs no operator key. */
export async function fetchSteamName(
  subject: string,
  apiKey: string,
  requests: ProviderRequests,
): Promise<string | null> {
  if (!/^\d{17}$/.test(subject)) return null;
  try {
    return await requestProvider(
      requests,
      'steamProfile',
      apiKey
        ? 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?' +
            new URLSearchParams({ key: apiKey, steamids: subject })
        : `https://steamcommunity.com/profiles/${subject}/?xml=1`,
      { signal: AbortSignal.timeout(4000) },
      'Steam could not verify this sign-in. Try again.',
      async (response) => {
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        if (apiKey) {
          const { players } = summaries.parse(await readUpstreamJson(response, 65536)).response;
          return cleanSteamName(players.find(({ steamid }) => steamid === subject)?.personaname);
        }
        const match = profile.exec(await readUpstreamText(response, 512 * 1024));
        return match?.[1] === subject
          ? cleanSteamName(
              match[2].replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity]),
            )
          : null;
      },
    );
  } catch {
    return null;
  }
}
