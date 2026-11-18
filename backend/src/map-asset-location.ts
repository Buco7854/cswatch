/** Paths and URL prefixes are constructed by the server from configuration and
 * approved IDs. No native artifact or client supplies any of these fields. */
export type MapAssetLocation = {
  root: string;
  parts: string[];
  key: string;
  apiPrefix: string;
  modelPrefix: string;
};
export const legacyMapLocation = (root: string): MapAssetLocation => ({
  root,
  parts: ['maps'],
  key: 'manual',
  apiPrefix: '/api/maps',
  modelPrefix: '/map-assets',
});
