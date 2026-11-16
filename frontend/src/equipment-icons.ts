import { useSyncExternalStore } from 'react';
import catalog from '../../shared/equipment-icons.json';
import { equipmentKey } from './equipment-key';

type Icons = Readonly<Record<string, string>>;
const empty: Icons = Object.freeze({});
let icons = empty;
const listeners = new Set<() => void>();
let pending: AbortController | undefined;
let loaded = false;
const aliases: Record<string, string> = {
  m4a4: 'm4a1',
  m4a1s: 'm4a1silencer',
  p2000: 'hkp2000',
  usps: 'uspsilencer',
  glock18: 'glock',
  sg553: 'sg556',
  galil: 'galilar',
  ppbizon: 'bizon',
  cz75auto: 'cz75a',
  deserteagle: 'deagle',
  dualberettas: 'elite',
  zeus: 'taser',
  zeusx27: 'taser',
  incendiarygrenade: 'incgrenade',
  decoygrenade: 'decoy',
  defusekit: 'defuser',
  kevlar: 'armor',
};

export function equipmentIconKey(item: string) {
  const key = equipmentKey(item);
  const canonical = aliases[key] || key;
  return Object.hasOwn(catalog.items, canonical) ? canonical : undefined;
}

async function load() {
  if (pending || loaded) return;
  const controller = new AbortController();
  pending = controller;
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/assets/equipment', {
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const text = await response.text();
    if (text.length > 32768) return;
    const result: unknown = JSON.parse(text);
    if (!result || typeof result !== 'object' || !('icons' in result)) return;
    const values = result.icons;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return;
    const next: Record<string, string> = {};
    for (const [key, url] of Object.entries(values))
      if (Object.hasOwn(catalog.items, key) && url === `/api/assets/equipment/${key}.png`)
        next[key] = url;
    if (controller.signal.aborted || pending !== controller) return;
    icons = Object.freeze(next);
    loaded = true;
    for (const listener of listeners) listener();
  } catch {
    // Missing operator art or private-instance authentication keeps the recorded
    // text and original vector fallback. Retry on the next mounted viewer.
  } finally {
    window.clearTimeout(timeout);
    if (pending === controller) pending = undefined;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void load();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && pending) {
      pending.abort();
      pending = undefined;
    }
  };
}
const snapshot = () => icons;
const serverSnapshot = () => empty;

export function useEquipmentIcon(item: string) {
  const available = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const key = equipmentIconKey(item);
  return key ? available[key] : undefined;
}
