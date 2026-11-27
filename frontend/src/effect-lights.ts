/** Transient point lights that particle effects cast on the native world, as Source 2's
 * C_OP_RenderStandardLight does: unshadowed, with a finite radius. */
export type EffectLight = {
  /** Scene metres (Y up). */
  position: readonly [number, number, number];
  /** Inches. */
  radius: number;
  /** Scene-linear colour times intensity. */
  color: readonly [number, number, number];
};

/** Each effect publishes its current lights under its own key. */
export type EffectLightSet = Map<string, readonly EffectLight[]>;

export const maxEffectLights = 4;

/** Pack the lights that matter most at `eye` (scene metres) into the world uniform layout:
 * Source position and radius in inches, then colour. */
export function packEffectLights(
  set: EffectLightSet | undefined,
  eye: readonly [number, number, number],
  data: Float32Array,
) {
  const ranked: { light: EffectLight; score: number }[] = [];
  for (const lights of set?.values() ?? [])
    for (const light of lights) {
      const [r, g, b] = light.color;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (!(luminance > 0) || !(light.radius > 0)) continue;
      const dx = light.position[0] - eye[0],
        dy = light.position[1] - eye[1],
        dz = light.position[2] - eye[2];
      const reach = (light.radius * 0.0254) ** 2;
      ranked.push({ light, score: luminance * Math.min(1, reach / (dx * dx + dy * dy + dz * dz)) });
    }
  ranked.sort((a, b) => b.score - a.score);
  const count = Math.min(maxEffectLights, ranked.length);
  for (let i = 0; i < count; i++) {
    const { position, radius, color } = ranked[i].light;
    data.set(
      [position[0] / 0.0254, -position[2] / 0.0254, position[1] / 0.0254, radius, ...color, 0],
      i * 8,
    );
  }
  return count;
}
