export type ViewmodelAsset = {
  sha256: string;
  bytes: number;
  decodedGeometryBytes: number;
  decodedTextureBytes: number;
  model: string;
};
export type ViewmodelCatalog = {
  items: Record<string, ViewmodelAsset>;
  complete?: boolean;
};
