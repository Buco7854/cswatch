import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './db.js';

export const matchPageSize = 25;
export const matchFilter = z.enum(['all', 'downloaded', 'missing']).default('all');
export const matchOffset = z.coerce.number().int().min(0).max(100000).default(0);
export const faceitId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export function matchSources(db: Store, c: Config, member: string) {
  const steam = Boolean(
    c.steamApiKey &&
    db.flag(c, 'steam_enabled') &&
    db.one(
      `SELECT 1 FROM steam_history h JOIN identities i
         ON i.user_id=h.user_id AND i.provider='steam' AND i.subject=h.steam_id
         WHERE h.user_id=?`,
      member,
    ),
  );
  const faceitConfigured = Boolean(c.faceitApiKey && db.flag(c, 'faceit_enabled'));
  const faceit = Boolean(
    faceitConfigured &&
    db.one("SELECT 1 FROM identities WHERE user_id=? AND provider='faceit'", member),
  );
  const faceit_verification = !faceitConfigured
    ? 'unavailable'
    : db.one("SELECT 1 FROM identities WHERE user_id=? AND provider='steam'", member)
      ? 'ready'
      : 'steam_required';
  return {
    steam,
    faceit,
    faceit_download: faceit && Boolean(c.faceitDownloadToken),
    faceit_verification,
  };
}

export function linkedSteamId(db: Store, member: string): string | undefined {
  return db.one("SELECT subject FROM identities WHERE user_id=? AND provider='steam'", member)
    ?.subject;
}

export function matchEvidence(row: Record<string, any>, steamId?: string, faceitSubject?: string) {
  let metadata;
  if (row.status === 'ready') {
    try {
      metadata = JSON.parse(row.metadata || '{}');
    } catch {
      // Unreadable metadata supplies no match evidence.
    }
  }
  return {
    score: metadata?.recordedScore ?? null,
    ...(faceitSubject &&
    faceitSubject === metadata?.faceitSubject &&
    metadata?.faceitMatch?.faceit_level
      ? { faceit_level: metadata.faceitMatch.faceit_level }
      : {}),
    ...(steamId && metadata?.matchPerformance?.[steamId]
      ? { performance: metadata.matchPerformance[steamId] }
      : {}),
  };
}

export function matchDemo(row: Record<string, any>, steamId?: string) {
  return {
    id: String(row.id),
    status: String(row.status),
    map: row.status === 'ready' ? row.map : null,
    ...matchEvidence(row, steamId),
  };
}
