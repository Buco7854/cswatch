// The runtime image contains dist only, so shared modules are resolved from there.
export const { mapGradeBytes, mapGradeFile, validMapGrade } = (await import(
  new URL(
    import.meta.url.endsWith('.ts') ? '../../shared/map-grade.mjs' : './map-grade.mjs',
    import.meta.url,
  ).href
)) as typeof import('../../shared/map-grade.mjs');
