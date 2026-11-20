export const { smokeLimits, validSmokeTracks } = (await import(
  new URL(
    import.meta.url.endsWith('.ts') ? '../../shared/smoke-state.mjs' : './smoke-state.mjs',
    import.meta.url,
  ).href
)) as typeof import('../../shared/smoke-state.mjs');
