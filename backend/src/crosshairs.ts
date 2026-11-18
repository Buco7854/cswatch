import type { DemoReader } from 'cs2parser';
import type { CrosshairData, CrosshairSample } from '../../shared/crosshairs.js';

export const crosshairCodePattern =
  /^(?:CSGO-(?:[A-Za-z0-9]{5}-){4}[A-Za-z0-9]{5}|CS[A-Za-z0-9]{44})$/;
const LIMIT = 10000;

/** Shares the existing streaming entity world. Changes and explicit loss of
 * evidence are retained, never names or guessed settings. */
export function observeCrosshairs(
  reader: DemoReader,
  lastTick: number,
  actors: ReadonlySet<string>,
) {
  const controllers = new Set<number>();
  const previous = new Map<string, string | null>();
  const samples: CrosshairSample[] = [];
  let truncated = false;
  reader.on('entitycreated', ([id, _class, _type, name]) => {
    if (name === 'CCSPlayerController' && controllers.size < 128) controllers.add(id);
  });
  reader.on('entitydeleted', (id) => controllers.delete(id));
  reader.on('tickend', () => {
    const tick = reader.currentTick;
    if (!Number.isSafeInteger(tick) || tick < 0 || tick > lastTick || truncated) return;
    const present = new Set<string>();
    const append = (actor: string, code: string | null) => {
      if (samples.length >= LIMIT) {
        truncated = true;
        return;
      }
      previous.set(actor, code);
      samples.push({ tick, actor, code });
    };
    for (const id of controllers) {
      const props = reader.entities[id]?.properties as Record<string, unknown> | undefined;
      const identity = props?.['CCSPlayerController.m_steamID'];
      const rawId = typeof identity === 'bigint' ? identity.toString() : identity;
      if (
        typeof rawId !== 'string' ||
        !/^\d{1,20}$/.test(rawId) ||
        rawId === '0' ||
        !actors.has(rawId)
      )
        continue;
      present.add(rawId);
      const raw = props?.['CCSPlayerController.m_szCrosshairCodes'];
      const code =
        typeof raw === 'string' && raw.length <= 64 && crosshairCodePattern.test(raw) ? raw : null;
      if (previous.get(rawId) !== code) append(rawId, code);
    }
    for (const [actor, code] of previous)
      if (code !== null && !present.has(actor)) append(actor, null);
  });
  return (complete: boolean): CrosshairData => ({ samples, complete: complete && !truncated });
}
