/** Operator-prepared static equipment. No native arm, bone or recoil pose is implied. */
type EquipmentModelVector = [number, number, number];
export type EquipmentModelTransform = {
  position: EquipmentModelVector;
  /** XYZ Euler radians within the recorded aim frame. */
  rotation: EquipmentModelVector;
  scale: number;
};
/** Canonical model axes are +X forward, +Y up, +Z right, in meters.
 * Hold translation is relative to player feet after yaw, followed by pitch at
 * that attachment point. POV translation is relative to the recorded eye in
 * the full yaw/pitch aim frame. Both are approximate static presets. */
type EquipmentModelAttachments = {
  approximate: true;
  hold: EquipmentModelTransform;
  pov: EquipmentModelTransform;
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
  attachments: EquipmentModelAttachments;
};
export type EquipmentModelCatalog = {
  schemaVersion: 1;
  complete?: boolean;
  items: Record<string, EquipmentModel>;
};
