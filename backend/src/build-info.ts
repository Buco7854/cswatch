import { readFileSync, statSync } from 'node:fs';

export type BuildInfo = { revision: string | null; builtAt: string | null };
const unknownBuild: BuildInfo = { revision: null, builtAt: null };
function utcTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.valueOf()) &&
    date.toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z')
  );
}

/** Build identity comes from the immutable image, never a request or runtime secret. */
export function parseBuildInfo(value: unknown): BuildInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...unknownBuild };
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'builtAt,revision' ||
    (record.revision !== null &&
      (typeof record.revision !== 'string' || !/^[a-f0-9]{40}$/.test(record.revision))) ||
    (record.builtAt !== null && !utcTimestamp(record.builtAt))
  )
    return { ...unknownBuild };
  return { revision: record.revision as string | null, builtAt: record.builtAt as string | null };
}

function installedBuildInfo(): BuildInfo {
  const file = new URL(
    import.meta.url.endsWith('.ts') ? '../dist/build-info.json' : './build-info.json',
    import.meta.url,
  );
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > 1024) return { ...unknownBuild };
    return parseBuildInfo(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { ...unknownBuild };
  }
}
export const buildInfo = Object.freeze(installedBuildInfo());
