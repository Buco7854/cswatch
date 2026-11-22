// The confined production worker can only read runtime files in dist.
export type { AimChunk, AimSample } from '../../shared/aim-track.mjs';
export const { encodeAimChunk, decodeAimChunk, quantizeAim, aimBoundary } = (await import(
  import.meta.url.endsWith('.ts') ? '../../shared/aim-track.mjs' : './aim-track.mjs'
)) as typeof import('../../shared/aim-track.mjs');
