import type { AssetStatus } from './map-assets';
export type MapUnavailableReason =
  | 'missing'
  | 'model-error'
  | 'renderer-error'
  | 'overview'
  | 'overview-error'
  | 'discovery-error'
  | 'loading';
/** Real replays require installed artwork. Position samples do not establish a map. */
export function mapSurface(input: {
  sample: boolean;
  requested2D: boolean;
  discovery: AssetStatus;
  model: string | null;
  modelStatus: AssetStatus;
  rendererFailed: boolean;
}): '3d' | 'plot' | 'loading' {
  if (input.requested2D) return 'plot';
  if (input.sample) return '3d';
  if (input.rendererFailed) return 'plot';
  if (input.discovery === 'pending') return 'loading';
  if (!input.model || input.modelStatus === 'error') return 'plot';
  return '3d';
}
