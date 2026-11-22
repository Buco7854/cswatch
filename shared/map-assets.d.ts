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
/** Authored multiplicative cube fog; distances/heights are viewer meters.
 * rotation is a proper column-major viewer-ray to prepared-cube-ray rotation,
 * before Three's cube X flip. Reversed height ranges are supported. */
export type MapCubeFog = {
  blend: 'multiply';
  start: number;
  end: number;
  exponent: number;
  height: { start: number; end: number; exponent: number } | null;
  maxOpacity: number;
  lodBias: number;
  brightness: number;
  rotation: [number, number, number, number, number, number, number, number, number];
};
/** Sky faces are prepared offline in viewer Y-up order +X,-X,+Y,-Y,+Z,-Z.
 * Landscape geometry is already merged into the ordinary prepared map GLBs. */
export type MapEnvironment = {
  assetVersion: string;
  landscape: boolean;
  sky: {
    faces: [string, string, string, string, string, string];
    brightness: number;
  };
  fog?: MapCubeFog;
};
export type MapAssets = {
  model: string | null;
  mobile: string | null;
  compact?: string;
  overview: MapOverview | null;
  environment?: MapEnvironment | null;
};
