import type { ViewmodelCatalog, ViewmodelAsset } from '../../shared/viewmodel-assets';
import { useEffect, useMemo, useState } from 'react';
import type { EquipmentModelCatalog, EquipmentModel } from '../../shared/equipment-models';
import equipment from '../../shared/equipment-models.json' with { type: 'json' };
import type { AssetStatus } from './map-assets';
import { observeAssets, readAssetJSON } from './asset-discovery';

const empty: EquipmentModelCatalog = Object.freeze({
  schemaVersion: 2 as const,
  items: Object.freeze({}),
});
export type EquipmentRenderState = {
  status: AssetStatus;
  active: boolean;
  expected: number;
  ready: number;
  pending: number;
  unavailable: number;
  failed: number;
};
export type EquipmentCatalog = EquipmentModelCatalog & { viewmodels?: ViewmodelCatalog['items'] };
type EquipmentAssets = { status: AssetStatus; catalog: EquipmentCatalog };
const emptyRigs: ViewmodelCatalog['items'] = Object.freeze({});

function validateViewmodels(value: unknown): ViewmodelCatalog {
  if (!value || typeof value !== 'object') throw Error('Invalid viewmodel catalog');
  const { items: raw, complete } = value as Partial<ViewmodelCatalog>;
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length > 96 ||
    (complete !== undefined && typeof complete !== 'boolean')
  )
    throw Error('Invalid viewmodel catalog');
  const items: Record<string, ViewmodelAsset> = {};
  for (const [id, item] of Object.entries(raw)) {
    if (
      !Object.hasOwn(equipment.items, id) ||
      !item ||
      typeof item !== 'object' ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      item.model !== `/api/assets/viewmodels/${id}/${item.sha256}.glb` ||
      !integer(item.bytes, 8 * MiB) ||
      item.bytes < 24 ||
      !integer(item.decodedTextureBytes, 16 * MiB) ||
      !integer(item.decodedGeometryBytes, 8 * MiB)
    )
      throw Error('Invalid viewmodel descriptor');
    items[id] = item;
  }
  return { items, complete };
}

function useViewmodelAssets(identity: string, enabled: boolean) {
  const [state, setState] = useState<{ identity: string; items: ViewmodelCatalog['items'] }>();
  useEffect(() => {
    if (!enabled) return;
    return observeAssets({
      read: async (signal) =>
        validateViewmodels(await readAssetJSON('/api/assets/viewmodels', 32768, signal)),
      complete: (catalog) => catalog.complete === true,
      changed: ({ items }) =>
        setState((previous) => {
          const ids = Object.keys(items);
          const installed = previous?.identity === identity ? previous.items : emptyRigs;
          return Object.keys(installed).length === ids.length &&
            ids.every((id) => JSON.stringify(installed[id]) === JSON.stringify(items[id]))
            ? previous
            : { identity, items };
        }),
    });
  }, [identity, enabled]);
  return enabled && state?.identity === identity ? state.items : emptyRigs;
}
const pending: EquipmentAssets = { status: 'pending', catalog: empty };
const MiB = 1024 * 1024;
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const tuple = (value: unknown, maximum: number): value is [number, number, number] =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every(
    (part) => typeof part === 'number' && Number.isFinite(part) && Math.abs(part) <= maximum,
  );

/** Fixed operator models only. A response cannot authorize arbitrary same-origin requests. */
export function validateEquipmentAssets(value: unknown): EquipmentModelCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid equipment models');
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 2 ||
    (input.complete !== undefined && typeof input.complete !== 'boolean') ||
    !input.items ||
    typeof input.items !== 'object' ||
    Array.isArray(input.items) ||
    Object.keys(input.items).length > 96
  )
    throw new Error('Invalid equipment models');
  const items: Record<string, EquipmentModel> = {};
  for (const [id, raw] of Object.entries(input.items)) {
    if (
      !Object.hasOwn(equipment.items, id) ||
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw)
    )
      throw new Error('Invalid equipment model');
    const item = raw as EquipmentModel;
    if (
      item.model !== `/api/assets/equipment-models/${id}.glb` ||
      typeof item.assetVersion !== 'string' ||
      !item.assetVersion.trim() ||
      item.assetVersion.length > 100 ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !integer(item.bytes, 16 * MiB) ||
      item.bytes < 20 ||
      !integer(item.decodedTextureBytes, 16 * MiB) ||
      !integer(item.geometryBytes, 8 * MiB) ||
      !item.bounds ||
      !tuple(item.bounds.min, 8) ||
      !tuple(item.bounds.max, 8) ||
      item.bounds.min.some(
        (part, index) => part > item.bounds.max[index] || item.bounds.max[index] - part > 8,
      )
    )
      throw new Error('Invalid equipment model');
    items[id] = {
      model: item.model,
      assetVersion: item.assetVersion,
      sha256: item.sha256,
      bytes: item.bytes,
      decodedTextureBytes: item.decodedTextureBytes,
      geometryBytes: item.geometryBytes,
      bounds: { min: [...item.bounds.min], max: [...item.bounds.max] },
    };
  }
  return {
    schemaVersion: 2,
    items,
    ...(input.complete === undefined ? {} : { complete: input.complete as boolean }),
  };
}

/** The descriptor is scoped to the current viewer identity and never survives logout or remount. */
export function useEquipmentAssets(identity: string, enabled: boolean) {
  const [state, setState] = useState<{ identity: string; value: EquipmentAssets }>({
    identity,
    value: pending,
  });
  useEffect(() => {
    if (!enabled) return;
    setState({ identity, value: pending });
    return observeAssets({
      read: async (signal) =>
        validateEquipmentAssets(
          await readAssetJSON('/api/assets/equipment-models', 128 * 1024, signal),
        ),
      complete: (catalog) =>
        catalog.complete === true ||
        Object.keys(equipment.items).every((id) => Boolean(catalog.items[id])),
      changed: (catalog) =>
        setState((previous) => {
          const entries = Object.entries(catalog.items);
          const status = entries.length ? 'ready' : 'missing';
          const installed = previous.value.catalog;
          if (
            previous.identity === identity &&
            previous.value.status === status &&
            installed.complete === catalog.complete &&
            Object.keys(installed.items).length === entries.length &&
            entries.every(
              ([id, model]) => JSON.stringify(installed.items[id]) === JSON.stringify(model),
            )
          )
            return previous;
          return { identity, value: { status, catalog } };
        }),
      failed: () =>
        setState((previous) =>
          previous.identity === identity &&
          (previous.value.status === 'error' || Object.keys(previous.value.catalog.items).length)
            ? previous
            : { identity, value: { status: 'error', catalog: empty } },
        ),
    });
  }, [identity, enabled]);
  const rigs = useViewmodelAssets(identity, enabled);
  const result = !enabled
    ? { status: 'missing' as const, catalog: empty }
    : state.identity === identity
      ? state.value
      : pending;
  const catalog = useMemo(() => ({ ...result.catalog, viewmodels: rigs }), [result.catalog, rigs]);
  return { status: result.status, catalog };
}
