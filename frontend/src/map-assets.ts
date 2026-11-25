import type { MapAssets, MapOverview } from '../../shared/map-assets';

export type AssetStatus = 'pending' | 'ready' | 'missing' | 'error';
export type MapAssetState = { status: AssetStatus; assets: MapAssets; overviewStatus: AssetStatus };
export const emptyMapAssets: MapAssets = Object.freeze({
  model: null,
  overview: null,
});
const coordinate = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;

/** Accept only the fixed local discovery contract, never arbitrary URLs from a response. */
export function validateMapAssets(
  value: unknown,
  map: string,
  packId?: string,
  demoId?: string,
): MapAssets {
  if (packId !== undefined && !/^[a-f0-9]{64}$/.test(packId)) throw new Error('Invalid map pack');
  const imageRoot = packId ? `/api/map-packs/${packId}/maps/${map}` : `/api/maps/${map}`;
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(map) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    throw new Error('Invalid map assets');
  const input = value as Record<string, unknown>;
  const model = input.model ?? null;
  if (model !== null) {
    const prefix = `/api/demos/${demoId}/world/${packId ?? 'manual'}/`;
    if (
      !demoId ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(demoId) ||
      typeof model !== 'string' ||
      !model.startsWith(prefix) ||
      !/^[a-f0-9]{64}\/map\.json$/.test(model.slice(prefix.length))
    )
      throw Error('Invalid native world URL');
  }
  if (Object.keys(input).some((key) => key !== 'model' && key !== 'overview'))
    throw Error('Unknown map asset field');
  let overview: MapOverview | null = null;
  if (input.overview !== undefined && input.overview !== null) {
    const item = input.overview as Partial<MapOverview>;
    if (
      typeof item !== 'object' ||
      Array.isArray(item) ||
      item.image !== `${imageRoot}/overview.png` ||
      !item.origin ||
      !coordinate(item.origin.x) ||
      !coordinate(item.origin.y) ||
      typeof item.scale !== 'number' ||
      !Number.isFinite(item.scale) ||
      item.scale < 0.001 ||
      item.scale > 10000 ||
      item.referenceSize !== 1024 ||
      typeof item.assetVersion !== 'string' ||
      !item.assetVersion.trim() ||
      item.assetVersion.length > 100
    )
      throw new Error('Invalid map overview');
    overview = {
      image: item.image,
      origin: { x: item.origin.x, y: item.origin.y },
      scale: item.scale,
      referenceSize: 1024,
      assetVersion: item.assetVersion,
    };
  }
  return { model: model as string | null, overview };
}
