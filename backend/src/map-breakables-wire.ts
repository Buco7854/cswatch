export const {
  breakableKey,
  breakableLimits,
  breakablePoseCodec,
  validMapBreakables,
  doorKey,
  doorLimits,
  validMapDoors,
} = (await import(
  new URL(
    import.meta.url.endsWith('.ts') ? '../../shared/map-breakables.mjs' : './map-breakables.mjs',
    import.meta.url,
  ).href
)) as typeof import('../../shared/map-breakables.mjs');
