import { useSyncExternalStore } from 'react';
import catalog from '../../shared/equipment-icons.json' with { type: 'json' };
import { canonicalEquipmentKey } from './equipment-key';
import { observeAssets, readAssetJSON } from './asset-discovery';

type Icons = Readonly<Record<string, string>>;
const empty: Icons = Object.freeze({});
let icons = empty;
const listeners = new Set<() => void>();
let stopObservation: (() => void) | undefined;

export function equipmentIconKey(item: string) {
  const canonical = canonicalEquipmentKey(item);
  return Object.hasOwn(catalog.items, canonical) ? canonical : undefined;
}

export function validateEquipmentIcons(result: unknown): Icons {
  if (!result || typeof result !== 'object' || !('icons' in result))
    throw new Error('Invalid equipment artwork');
  if ('complete' in result && typeof result.complete !== 'boolean')
    throw new Error('Invalid equipment artwork readiness');
  const values = result.icons;
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('Invalid equipment artwork');
  const next: Record<string, string> = {};
  for (const [key, url] of Object.entries(values)) {
    if (!Object.hasOwn(catalog.items, key) || url !== `/api/assets/equipment/${key}.png`) continue;
    next[key] = url;
  }
  return Object.freeze(next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!stopObservation)
    stopObservation = observeAssets({
      read: async (signal) => {
        const value = await readAssetJSON('/api/assets/equipment', 32768, signal);
        return {
          icons: validateEquipmentIcons(value),
          complete: (value as { complete?: boolean }).complete === true,
        };
      },
      complete: (value) =>
        value.complete || Object.keys(value.icons).length === Object.keys(catalog.items).length,
      changed: ({ icons: next }) => {
        const keys = Object.keys(next);
        if (
          keys.length === Object.keys(icons).length &&
          keys.every((key) => icons[key] === next[key])
        )
          return;
        icons = next;
        for (const listener of listeners) listener();
      },
    });
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopObservation?.();
      stopObservation = undefined;
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
