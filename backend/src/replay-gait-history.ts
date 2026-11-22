export const { encodeGaitHistory, validGaitHistory } = (await import(
  import.meta.url.endsWith('.ts')
    ? '../../shared/agent-gait-history.mjs'
    : './agent-gait-history.mjs'
)) as typeof import('../../shared/agent-gait-history.mjs');
