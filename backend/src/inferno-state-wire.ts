export const { infernoLimits, infernoUpdateBytes, validInfernoBank } = (await import(
  new URL(
    import.meta.url.endsWith('.ts') ? '../../shared/inferno-state.mjs' : './inferno-state.mjs',
    import.meta.url,
  ).href
)) as typeof import('../../shared/inferno-state.mjs');
