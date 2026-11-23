import { mapGradeFile, validMapGrade } from '../../shared/map-grade.mjs';
import type { MapAssets, MapEnvironment, MapOverview } from '../../shared/map-assets';
import { validateMapCubeFog, validateMapGradientFog } from './map-fog';

export type AssetStatus = 'pending' | 'ready' | 'missing' | 'error';
export type MapAssetState = { status: AssetStatus; assets: MapAssets; overviewStatus: AssetStatus };
export const emptyMapAssets: MapAssets = Object.freeze({
  model: null,
  mobile: null,
  overview: null,
  environment: null,
});
const coordinate = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;

/** Accept only the fixed local discovery contract, never arbitrary URLs from a response. */
export function validateMapAssets(value: unknown, map: string, packId?: string): MapAssets {
  if (packId !== undefined && !/^[a-f0-9]{64}$/.test(packId)) throw new Error('Invalid map pack');
  const imageRoot = packId ? `/api/map-packs/${packId}/maps/${map}` : `/api/maps/${map}`;
  const desktop = packId
    ? `/api/map-packs/${packId}/models/${map}/desktop/scene.glb`
    : `/map-assets/${map}/desktop/scene.glb`;
  const phone = packId
    ? `/api/map-packs/${packId}/models/${map}/mobile/scene.glb`
    : `/map-assets/${map}/mobile/scene.glb`;
  const compactUrl = packId
    ? `/api/map-packs/${packId}/models/${map}/compact/scene.glb`
    : `/map-assets/${map}/compact/scene.glb`;
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(map) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    throw new Error('Invalid map assets');
  const input = value as Record<string, unknown>;
  const model = input.model ?? null,
    mobile = input.mobile ?? null,
    compact = input.compact ?? null;
  if (model !== null && model !== desktop) throw new Error('Invalid map model');
  if (mobile !== null && mobile !== phone) throw new Error('Invalid mobile map model');
  if (compact !== null && compact !== compactUrl) throw new Error('Invalid compact map model');
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
  let environment: MapEnvironment | null = null;
  if (input.environment !== undefined && input.environment !== null) {
    const item = input.environment as Partial<MapEnvironment>;
    const expected = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
      (face) => `${imageRoot}/environment/${face}.png`,
    ) as NonNullable<MapEnvironment['sky']>['faces'];
    if (
      typeof item !== 'object' ||
      Array.isArray(item) ||
      typeof item.assetVersion !== 'string' ||
      !item.assetVersion.trim() ||
      item.assetVersion.length > 100 ||
      typeof item.landscape !== 'boolean' ||
      (item.gradientFog?.landscape && !item.landscape) ||
      (item.sky === null
        ? item.fog !== undefined
        : !item.sky ||
          !Array.isArray(item.sky.faces) ||
          item.sky.faces.length !== 6 ||
          item.sky.faces.some((face, index) => face !== expected[index]) ||
          typeof item.sky.brightness !== 'number' ||
          !Number.isFinite(item.sky.brightness) ||
          item.sky.brightness < 0 ||
          item.sky.brightness > 16)
    )
      throw new Error('Invalid map environment');
    environment = {
      assetVersion: item.assetVersion,
      landscape: item.landscape,
      sky: item.sky ? { faces: expected, brightness: item.sky.brightness } : null,
      ...(item.fog !== undefined ? { fog: validateMapCubeFog(item.fog) } : {}),
      ...(item.gradientFog !== undefined
        ? { gradientFog: validateMapGradientFog(item.gradientFog) }
        : {}),
      ...(validMapGrade(item.grade)
        ? { grade: item.grade, gradeUrl: `${imageRoot}/environment/${mapGradeFile}` }
        : {}),
    };
  }
  return {
    model: model as string | null,
    mobile: mobile as string | null,
    ...(compact ? { compact } : {}),
    overview,
    environment,
  };
}
