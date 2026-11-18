import type { MapAssets } from './map-assets.js';
/** Unsigned recorded header evidence, never a Steam build/manifest identity. */
export type MapIdentity = {
  map: string;
  buildNum?: number;
  patchVersion?: number;
  demoVersionGuid?: string;
  addonPresence?: 'none' | 'present';
  conflicted?: true;
};
export type ApprovedMapIdentity = Required<Omit<MapIdentity, 'conflicted'>> & {
  addonPresence: 'none';
};
export type OfficialMapSource = {
  appId: 730;
  depotId: 2347770;
  manifest: string;
  mapSha256: string;
};
/** Worker-observed official depot membership, never inferred from a recording. */
export type OfficialMapInventory = {
  schemaVersion: 1;
  appId: 730;
  depotId: 2347770;
  manifest: string;
  updatedAt: number;
  maps: { map: string; sha1: string; bytes: number }[];
};
export type LatestOfficialSelection = {
  map: string;
  appId: 730;
  depotId: 2347770;
  manifest: string;
  sha1: string;
  bytes: number;
};
export type ApprovedMapEntry = {
  identity: ApprovedMapIdentity;
  source: OfficialMapSource;
  assetVersion?: string;
};
export type MapCatalog = { schemaVersion: 1; entries: ApprovedMapEntry[] };
type MapJobIdentity = {
  schemaVersion: 1;
  /** Queue identity. Latest jobs acquire a separate content pack ID after download. */
  packId: string;
  /** Server-issued retry generation, deliberately independent of pack identity. */
  generation?: string;
};
export type MapJobRequest = MapJobIdentity &
  (
    | { approval: ApprovedMapEntry; kind?: never; selection?: never }
    | { kind: 'latest-official'; selection: LatestOfficialSelection; approval?: never }
  );
export type MapJobFailureCode =
  | 'source_unavailable'
  | 'source_mismatch'
  | 'storage_limit'
  | 'preparation_failed'
  | 'approval_removed'
  | 'worker_interrupted';
export type MapJobResult = {
  schemaVersion: 1;
  packId: string;
  status: 'processing' | 'ready' | 'failed';
  updatedAt: number;
  code?: MapJobFailureCode;
  /** Worker-generated post-download source proof; never caller-selected. */
  assetPackId?: string;
  source?: OfficialMapSource;
  sourceCheckedAt?: number;
};
export type MapResolution =
  | { status: 'unknown' | 'unmapped' | 'addon' | 'ambiguous' | 'catalog_invalid' }
  | { status: 'approved'; packId: string; approval: ApprovedMapEntry }
  | {
      status: 'latest';
      selection: LatestOfficialSelection;
      inventoryUpdatedAt: number;
      source: OfficialMapSource | null;
    };
export type DemoMapAssets = {
  /** Operator approval is provenance, not cryptographic proof of recorded geometry. */
  resolution: MapResolution;
  canAcquire: boolean;
  acquisition: 'disabled' | 'unavailable' | 'queued' | 'processing' | 'ready' | 'failed';
  code?: MapJobFailureCode | 'queue_full';
  verification: 'operator-approved' | 'latest-official' | 'version-unverified' | 'unavailable';
  packId: string | null;
  assets: MapAssets;
};
