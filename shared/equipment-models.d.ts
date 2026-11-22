/** Operator-prepared static equipment. No native arm, bone or recoil pose is implied. */
type EquipmentModelVector = [number, number, number];
export type EquipmentModelTransform = {
  position: EquipmentModelVector;
  /** XYZ Euler radians within the recorded aim frame. */
  rotation: EquipmentModelVector;
  scale: number;
};
type EquipmentModelBounds = {
  min: EquipmentModelVector;
  max: EquipmentModelVector;
};
export type EquipmentModel = {
  /** Fixed same-origin /api/assets/equipment-models/<registry-id>.glb. */
  model: string;
  assetVersion: string;
  sha256: string;
  bytes: number;
  /** Actual output RGBA residency estimate, with distinct sampler copies. */
  decodedTextureBytes: number;
  /** Losslessly decoded vertex/index buffer bytes. */
  geometryBytes: number;
  bounds: EquipmentModelBounds;
};
export type EquipmentModelCatalog = {
  schemaVersion: 2;
  complete?: boolean;
  items: Record<string, EquipmentModel>;
};
