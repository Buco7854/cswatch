/** Locally installed map artwork. Coordinates stay in Source inches, X/Y horizontal. */
/** Runtime identities are restricted by the shared map-previews.json registry. */
export type MapPreview = { image: string; map: string } | { image: null; map: null };
export type MapOverview = {
  image: string;
  origin: { x: number; y: number };
  scale: number;
  referenceSize: 1024;
  assetVersion: string;
};
/** `model` is the demo-scoped native world manifest URL. */
export type MapAssets = {
  model: string | null;
  overview: MapOverview | null;
};
