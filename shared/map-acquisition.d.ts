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
export type ApprovedMapEntry = {
  identity: ApprovedMapIdentity;
  source: OfficialMapSource;
  assetVersion?: string;
};
export type MapCatalog = { schemaVersion: 1; entries: ApprovedMapEntry[] };
export type MapJobRequest = {
  schemaVersion: 1;
  packId: string;
  /** Server-issued retry generation, deliberately independent of pack identity. */
  generation?: string;
  approval: ApprovedMapEntry;
};
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
};
export type MapResolution =
  | { status: 'unknown' | 'unmapped' | 'addon' | 'ambiguous' | 'catalog_invalid' }
  | { status: 'approved'; packId: string; approval: ApprovedMapEntry };
export type DemoMapAssets = {
  /** Operator approval is provenance, not cryptographic proof of recorded geometry. */
  resolution: MapResolution;
  canAcquire: boolean;
  acquisition: 'disabled' | 'unavailable' | 'queued' | 'processing' | 'ready' | 'failed';
  code?: MapJobFailureCode | 'queue_full';
  verification: 'operator-approved' | 'version-unverified' | 'unavailable';
  packId: string | null;
  assets: MapAssets;
};
