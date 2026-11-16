/** Stable engine/display-key normalization, independent of locale and rendering. */
export const equipmentKey = (value: string) =>
  value
    .replace(/^weapon_/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
