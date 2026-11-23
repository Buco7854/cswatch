export type { Role } from '../../shared/roles.mjs';

const shared = (await import(
  new URL(
    import.meta.url.endsWith('.ts') ? '../../shared/roles.mjs' : './roles.mjs',
    import.meta.url,
  ).href
)) as typeof import('../../shared/roles.mjs');

export const { roles, hasPermission } = shared;
