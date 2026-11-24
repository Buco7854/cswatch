import type {
  DemoMapAssets,
  LatestOfficialSelection,
  MapPreparationPhase,
  OfficialMapSource,
} from '../../shared/map-acquisition';
import { emptyMapAssets, validateMapAssets, type MapAssetState } from './map-assets';

type Resolution = DemoMapAssets['resolution']['status'];
export type DemoMapSummary = Pick<
  DemoMapAssets,
  'acquisition' | 'canAcquire' | 'verification' | 'packId' | 'code' | 'readinessReason' | 'phase'
> & {
  resolution: Resolution;
  latest?: {
    selection: LatestOfficialSelection;
    inventoryUpdatedAt: number;
    source: OfficialMapSource | null;
  };
};
export type DemoMapState = MapAssetState & {
  acquisition?: DemoMapSummary;
  pollingEnded?: boolean;
  requestUnconfirmed?: boolean;
  requesting?: boolean;
};
/** Queue intent, deliberately distinct from a latest job's eventual content pack. */
export function mapAcquisitionKey(info: DemoMapSummary | undefined): string | undefined {
  if (info?.resolution === 'approved' && info.packId) return `approved:${info.packId}`;
  if (info?.resolution === 'latest' && info.latest) {
    const { map, manifest, sha1, bytes } = info.latest.selection;
    return `latest:${JSON.stringify([map, manifest, sha1, bytes])}`;
  }
}
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
  'latest',
]);
const acquisitionStatuses = new Set([
  'disabled',
  'unavailable',
  'queued',
  'processing',
  'ready',
  'failed',
]);
const preparationPhaseLabels = {
  tools: 'Preparing conversion tools',
  source: 'Retrieving map files',
  geometry: 'Converting map geometry',
  environment: 'Preparing the map environment',
  lighting: 'Preparing map lighting',
  desktop: 'Building the desktop map',
  mobile: 'Building the mobile map',
  compact: 'Building the compact map',
  publishing: 'Installing the prepared map',
} satisfies Record<MapPreparationPhase, string>;
export const retryableMapFailures = new Set([
  'source_unavailable',
  'storage_limit',
  'preparation_failed',
  'worker_interrupted',
  'removed_by_admin',
]);
const codes = new Set([
  'source_unavailable',
  'source_mismatch',
  'storage_limit',
  'preparation_failed',
  'approval_removed',
  'worker_interrupted',
  'removed_by_admin',
  'queue_full',
  'pack_invalid',
]);
const readinessReasons = new Set([
  'automatic_disabled',
  'worker_unavailable',
  'inventory_unavailable',
  'inventory_stale',
  'official_map_unknown',
  'owner_required',
  'identity_invalid',
]);
const digest = (value: unknown, length: 40 | 64) =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const manifest = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[1-9][0-9]{0,19}$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
function latestSelection(value: unknown, map: string): LatestOfficialSelection {
  const item = object(value);
  if (
    !exactKeys(item, ['map', 'appId', 'depotId', 'manifest', 'sha1', 'bytes']) ||
    item.map !== map ||
    !/^[a-z][a-z0-9_]{1,79}$/.test(map) ||
    item.appId !== 730 ||
    item.depotId !== 2347770 ||
    !manifest(item.manifest) ||
    !digest(item.sha1, 40) ||
    !Number.isSafeInteger(item.bytes) ||
    Number(item.bytes) < 1 ||
    Number(item.bytes) > 2 * 1024 ** 3
  )
    throw new Error('Invalid latest map selection');
  return {
    map,
    appId: 730,
    depotId: 2347770,
    manifest: item.manifest,
    sha1: item.sha1 as string,
    bytes: item.bytes as number,
  };
}
function officialSource(value: unknown, selected: LatestOfficialSelection): OfficialMapSource {
  const item = object(value);
  if (
    !exactKeys(item, ['appId', 'depotId', 'manifest', 'mapSha256']) ||
    item.appId !== 730 ||
    item.depotId !== 2347770 ||
    item.manifest !== selected.manifest ||
    !digest(item.mapSha256, 64)
  )
    throw new Error('Invalid latest map source');
  return {
    appId: 730,
    depotId: 2347770,
    manifest: selected.manifest,
    mapSha256: item.mapSha256 as string,
  };
}
/** The browser binds assets to fixed content-pack URLs. A latest selection is
 * official depot evidence, never proof of the recording's historical geometry. */
export function validateDemoMapAssets(value: unknown, map: string): DemoMapState {
  const input = object(value),
    resolution = object(input.resolution);
  if (
    !statuses.has(String(resolution.status)) ||
    !acquisitionStatuses.has(String(input.acquisition)) ||
    typeof input.canAcquire !== 'boolean' ||
    !['operator-approved', 'latest-official', 'version-unverified', 'unavailable'].includes(
      String(input.verification),
    ) ||
    (input.code !== undefined && !codes.has(String(input.code))) ||
    (input.readinessReason !== undefined &&
      (!readinessReasons.has(String(input.readinessReason)) || input.canAcquire))
  )
    throw new Error('Invalid map discovery');
  const approved = resolution.status === 'approved',
    latest = resolution.status === 'latest';
  if (
    approved &&
    (typeof resolution.packId !== 'string' || !/^[a-f0-9]{64}$/.test(resolution.packId))
  )
    throw new Error('Invalid approved map identity');
  let latestInfo: DemoMapSummary['latest'];
  if (latest) {
    const selection = latestSelection(resolution.selection, map);
    if (
      !Number.isSafeInteger(resolution.inventoryUpdatedAt) ||
      Number(resolution.inventoryUpdatedAt) < 0 ||
      Number(resolution.inventoryUpdatedAt) > 8640000000000
    )
      throw new Error('Invalid latest map inventory');
    latestInfo = {
      selection,
      inventoryUpdatedAt: resolution.inventoryUpdatedAt as number,
      source: resolution.source === null ? null : officialSource(resolution.source, selection),
    };
  }
  if (
    input.packId !== null &&
    (!digest(input.packId, 64) ||
      (!approved && !latest) ||
      (approved && input.packId !== resolution.packId) ||
      (latest && !latestInfo?.source))
  )
    throw new Error('Invalid map pack identity');
  const assets = validateMapAssets(
    input.assets,
    map,
    typeof input.packId === 'string' ? input.packId : undefined,
  );
  const hasModel = Boolean(assets.model || assets.mobile || assets.compact);
  const hasAssets = hasModel || Boolean(assets.overview || assets.environment);
  if (input.verification === 'operator-approved' || input.verification === 'latest-official') {
    if (
      input.acquisition !== 'ready' ||
      (input.verification === 'operator-approved' ? !approved : !latestInfo?.source) ||
      !input.packId ||
      !assets.model ||
      !assets.mobile ||
      !assets.overview ||
      !assets.environment
    )
      throw new Error('Incomplete prepared map');
  } else if (input.verification === 'version-unverified') {
    if (
      input.packId !== null ||
      input.acquisition !== 'disabled' ||
      (!hasModel && !assets.overview)
    )
      throw new Error('Invalid manual map');
  } else if (hasAssets) throw new Error('Unverified prepared map');
  if (
    input.acquisition === 'ready' &&
    !['operator-approved', 'latest-official'].includes(String(input.verification))
  )
    throw new Error('Invalid ready map');
  if (
    input.canAcquire &&
    ((!approved && !latest) ||
      (input.acquisition !== 'unavailable' &&
        !(input.acquisition === 'failed' && retryableMapFailures.has(String(input.code)))) ||
      hasAssets ||
      (approved ? input.packId !== resolution.packId : input.packId !== null))
  )
    throw new Error('Invalid acquisition eligibility');
  if (
    ['queued', 'processing', 'failed'].includes(String(input.acquisition)) &&
    ((!approved && !latest) ||
      (approved
        ? input.packId !== resolution.packId
        : input.acquisition !== 'failed' && input.packId !== null) ||
      hasAssets)
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
      ...(input.acquisition === 'processing' &&
        typeof input.phase === 'string' &&
        Object.hasOwn(preparationPhaseLabels, input.phase) && {
          phase: input.phase as MapPreparationPhase,
        }),
      canAcquire: input.canAcquire,
      verification: input.verification as DemoMapAssets['verification'],
      packId: input.packId as string | null,
      ...(latestInfo ? { latest: latestInfo } : {}),
      ...(input.code ? { code: input.code as DemoMapAssets['code'] } : {}),
      ...(input.readinessReason
        ? { readinessReason: input.readinessReason as DemoMapAssets['readinessReason'] }
        : {}),
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
): { title: string; description: string; preparing?: true } | undefined {
  const info = state.acquisition;
  if (!info || state.status === 'ready') return;
  if (state.requestUnconfirmed)
    return {
      title: 'Map preparation unavailable',
      description:
        'The preparation request could not be confirmed. Reopen the viewer to check its status.',
    };
  if (state.pollingEnded && !state.requesting)
    return {
      title: 'Map preparation is still pending',
      description:
        'Reopen the viewer to check the preparation status. Leaving the viewer does not stop preparation.',
    };
  if (state.requesting || (info.canAcquire && info.acquisition === 'unavailable'))
    return {
      preparing: true,
      title: 'Requesting map preparation',
      description:
        info.resolution === 'latest'
          ? 'Requesting the latest official map from the preparation worker.'
          : 'Requesting the operator-approved map from the preparation worker.',
    };
  if (info.acquisition === 'queued')
    return {
      preparing: true,
      title: 'Map preparation queued',
      description:
        info.resolution === 'latest'
          ? 'The latest official map is waiting for the preparation worker. Its layout may differ from this recording.'
          : 'The approved map is waiting for the preparation worker. You can leave this viewer and return later.',
    };
  if (info.acquisition === 'processing') {
    const repairing = info.code === 'pack_invalid';
    const latest = info.resolution === 'latest';
    return {
      preparing: true,
      title: info.phase
        ? preparationPhaseLabels[info.phase]
        : repairing
          ? 'Preparing map again'
          : 'Preparing map assets',
      description: repairing
        ? latest && info.phase
          ? 'The worker is rebuilding the incomplete or damaged map. The latest official layout may differ from this recording.'
          : 'The prepared map is incomplete or damaged. The worker will rebuild it.'
        : latest
          ? 'The worker is preparing the latest official map. Its layout may differ from this recording.'
          : 'The worker is downloading and converting the approved map. You can leave this viewer and return later.',
    };
  }
  if (info.code === 'queue_full')
    return {
      title: 'Map preparation queue is full',
      description: 'Reopen the viewer later to check availability.',
    };
  if (info.acquisition === 'failed')
    return {
      title: info.code === 'removed_by_admin' ? 'Map deleted' : 'Map preparation failed',
      description:
        info.code === 'removed_by_admin'
          ? 'The administrator deleted this map. Preparing it again requires an explicit retry after the cooldown.'
          : info.code === 'source_mismatch'
            ? info.resolution === 'latest'
              ? 'The downloaded files do not match the selected official map source. No substitute source will be used.'
              : 'The source files do not match the approved map version. No different version will be substituted.'
            : info.code === 'source_unavailable'
              ? info.resolution === 'latest'
                ? 'The selected official Steam source is unavailable. The administrator needs to check the preparation worker.'
                : 'The approved Steam source is unavailable. The administrator needs to check its source configuration.'
              : info.code === 'storage_limit'
                ? 'Map preparation stopped at the configured storage limit. The administrator needs to free space.'
                : info.code === 'approval_removed'
                  ? 'The map approval was removed or changed. Assets from that approval will not be loaded.'
                  : info.code === 'worker_interrupted'
                    ? 'The preparation worker stopped before completing this map. The administrator needs to check the job.'
                    : 'The instance administrator needs to check the preparation worker. No different map version will be substituted.',
    };
  if (info.readinessReason) {
    const explanations: Record<
      NonNullable<DemoMapAssets['readinessReason']>,
      { title: string; description: string }
    > = {
      automatic_disabled: {
        title: 'Map preparation is disabled',
        description:
          'The administrator can enable automatic official maps and start the assets service, or install a local map pack.',
      },
      worker_unavailable: {
        title: 'Map worker unavailable',
        description:
          'Automatic map preparation is enabled, but the assets service is not responding. The administrator needs to start or check that service.',
      },
      inventory_unavailable: {
        title: 'Official map list is not ready',
        description:
          'The map worker has not provided a valid official map list yet. This viewer will check again while the administrator checks the service and Steam access.',
      },
      inventory_stale: {
        title: 'Official map list needs refreshing',
        description:
          'New map preparation is waiting for the worker to refresh its official map list. No unverified source will be used.',
      },
      official_map_unknown: {
        title: 'Official map source unavailable',
        description:
          'The current official depot list does not include this map. The administrator can inspect its source or install a local map pack.',
      },
      owner_required: {
        title: 'Map preparation requires its owner',
        description: 'The demo owner needs to open this recording to request map preparation.',
      },
      identity_invalid: {
        title: 'Recorded map identity is invalid',
        description:
          'The recording has conflicting or invalid map evidence. Automatic preparation cannot safely select an official source.',
      },
    };
    return explanations[info.readinessReason];
  }
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
    latest:
      'The latest official map is known, but preparation is unavailable for this viewer. The demo owner or administrator can check its status.',
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
