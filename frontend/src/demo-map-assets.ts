import type { DemoMapAssets } from '../../shared/map-acquisition';
import { emptyMapAssets, validateMapAssets, type MapAssetState } from './map-assets';

type Resolution = DemoMapAssets['resolution']['status'];
export type DemoMapSummary = Pick<
  DemoMapAssets,
  'acquisition' | 'canAcquire' | 'verification' | 'packId' | 'code'
> & { resolution: Resolution };
export type DemoMapState = MapAssetState & {
  acquisition?: DemoMapSummary;
  pollingEnded?: boolean;
  requestUnconfirmed?: boolean;
  requesting?: boolean;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid map discovery');
  return value as Record<string, unknown>;
};
const statuses = new Set([
  'unknown',
  'unmapped',
  'addon',
  'ambiguous',
  'catalog_invalid',
  'approved',
]);
const acquisitionStatuses = new Set([
  'disabled',
  'unavailable',
  'queued',
  'processing',
  'ready',
  'failed',
]);
export const retryableMapFailures = new Set([
  'source_unavailable',
  'storage_limit',
  'preparation_failed',
  'worker_interrupted',
]);
const codes = new Set([
  'source_unavailable',
  'source_mismatch',
  'storage_limit',
  'preparation_failed',
  'approval_removed',
  'worker_interrupted',
  'queue_full',
]);
/** The browser consumes only readiness and fixed URLs, never an approval tuple. */
export function validateDemoMapAssets(value: unknown, map: string): DemoMapState {
  const input = object(value),
    resolution = object(input.resolution);
  if (
    !statuses.has(String(resolution.status)) ||
    !acquisitionStatuses.has(String(input.acquisition)) ||
    typeof input.canAcquire !== 'boolean' ||
    !['operator-approved', 'version-unverified', 'unavailable'].includes(
      String(input.verification),
    ) ||
    (input.code !== undefined && !codes.has(String(input.code)))
  )
    throw new Error('Invalid map discovery');
  const approved = resolution.status === 'approved';
  if (
    approved &&
    (typeof resolution.packId !== 'string' || !/^[a-f0-9]{64}$/.test(resolution.packId))
  )
    throw new Error('Invalid approved map identity');
  if (input.packId !== null && (!approved || input.packId !== resolution.packId))
    throw new Error('Invalid map pack identity');
  const assets = validateMapAssets(
    input.assets,
    map,
    typeof input.packId === 'string' ? input.packId : undefined,
  );
  const hasAssets = Boolean(assets.model || assets.mobile || assets.overview || assets.environment);
  if (input.verification === 'operator-approved') {
    if (
      input.acquisition !== 'ready' ||
      !approved ||
      !input.packId ||
      !assets.model ||
      !assets.mobile ||
      !assets.overview ||
      !assets.environment
    )
      throw new Error('Incomplete prepared map');
  } else if (input.verification === 'version-unverified') {
    if (input.packId !== null || input.acquisition !== 'disabled')
      throw new Error('Invalid manual map');
  } else if (hasAssets) throw new Error('Unverified prepared map');
  if (input.acquisition === 'ready' && input.verification !== 'operator-approved')
    throw new Error('Invalid ready map');
  if (
    input.canAcquire &&
    (!approved ||
      (input.acquisition !== 'unavailable' &&
        !(input.acquisition === 'failed' && retryableMapFailures.has(String(input.code)))) ||
      hasAssets ||
      input.packId !== resolution.packId)
  )
    throw new Error('Invalid acquisition eligibility');
  if (
    ['queued', 'processing', 'failed'].includes(String(input.acquisition)) &&
    (!approved || input.packId !== resolution.packId || hasAssets)
  )
    throw new Error('Invalid map job');
  return {
    status: hasAssets
      ? 'ready'
      : ['queued', 'processing'].includes(String(input.acquisition))
        ? 'pending'
        : 'missing',
    assets,
    overviewStatus: assets.overview ? 'pending' : 'missing',
    acquisition: {
      resolution: resolution.status as Resolution,
      acquisition: input.acquisition as DemoMapAssets['acquisition'],
      canAcquire: input.canAcquire,
      verification: input.verification as DemoMapAssets['verification'],
      packId: input.packId as string | null,
      ...(input.code ? { code: input.code as DemoMapAssets['code'] } : {}),
    },
  };
}
export const pendingDemoMap: DemoMapState = Object.freeze({
  status: 'pending',
  overviewStatus: 'missing',
  assets: emptyMapAssets,
});
export const failedDemoMap: DemoMapState = Object.freeze({
  status: 'error',
  overviewStatus: 'error',
  assets: emptyMapAssets,
});
/** Bound the response before JSON parsing, including chunked responses. */
export async function readMapJSON(response: Response, maxBytes = 65536): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > maxBytes)
    throw new Error('Map response exceeded its bound');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing map response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Map response exceeded its bound');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export function mapAcquisitionMessage(
  state: DemoMapState,
): { title: string; description: string } | undefined {
  const info = state.acquisition;
  if (!info || state.status === 'ready') return;
  if (state.requestUnconfirmed)
    return {
      title: 'Map preparation unavailable',
      description:
        'The preparation request could not be confirmed. Reopen the viewer to check its status.',
    };
  if (state.requesting || (info.canAcquire && info.acquisition === 'unavailable'))
    return {
      title: 'Requesting map preparation',
      description: 'Requesting the operator-approved map from the preparation worker.',
    };
  if (state.pollingEnded)
    return {
      title: 'Map preparation is still pending',
      description:
        'Reopen the viewer to check the preparation status. Leaving the viewer does not stop preparation.',
    };
  if (info.acquisition === 'queued')
    return {
      title: 'Map preparation queued',
      description:
        'The approved map is waiting for the preparation worker. You can leave this viewer and return later.',
    };
  if (info.acquisition === 'processing')
    return {
      title: 'Preparing map assets',
      description:
        'The worker is downloading and converting the approved map. You can leave this viewer and return later.',
    };
  if (info.code === 'queue_full')
    return {
      title: 'Map preparation queue is full',
      description: 'Reopen the viewer later to check availability.',
    };
  if (info.acquisition === 'failed')
    return {
      title: 'Map preparation failed',
      description:
        info.code === 'source_mismatch'
          ? 'The source files do not match the approved map version. No different version will be substituted.'
          : info.code === 'source_unavailable'
            ? 'The approved Steam source is unavailable. The administrator needs to check its source configuration.'
            : info.code === 'storage_limit'
              ? 'Map preparation stopped at the configured storage limit. The administrator needs to free space.'
              : info.code === 'approval_removed'
                ? 'The map approval was removed or changed. Assets from that approval will not be loaded.'
                : info.code === 'worker_interrupted'
                  ? 'The preparation worker stopped before completing this map. The administrator needs to check the job.'
                  : 'The instance administrator needs to check the preparation worker. No different map version will be substituted.',
    };
  if (info.acquisition === 'disabled')
    return {
      title: 'Map unavailable',
      description:
        'Automatic map preparation is disabled. The instance administrator can install an explicit map pack.',
    };
  if (info.resolution === 'approved')
    return {
      title: 'Map preparation unavailable',
      description: 'No preparation worker is currently available for this approved map.',
    };
  const descriptions: Record<Exclude<Resolution, 'approved'>, string> = {
    unknown:
      'This recording does not contain enough map identity evidence to choose an approved version.',
    unmapped: 'No operator-approved map version matches this recording.',
    addon:
      'This recording uses an add-on map. Automatic preparation supports approved official maps.',
    ambiguous:
      'More than one approved map version matches this recording. The administrator needs to resolve the ambiguity.',
    catalog_invalid:
      'The map approval catalog could not be validated. The administrator needs to check its configuration.',
  };
  return { title: 'Map unavailable', description: descriptions[info.resolution] };
}
