import { writeFileSync } from 'node:fs';

export function createBuildInfo(env = process.env, now = new Date()) {
  const revision = env.CSWATCH_REVISION || null;
  if (revision !== null && !/^[a-f0-9]{40}$/.test(revision))
    throw Error('CSWATCH_REVISION must be a full lowercase Git commit ID.');
  const timestamp = env.CSWATCH_BUILD_TIMESTAMP || now.toISOString();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString().replace('.000Z', 'Z') !== timestamp.replace('.000Z', 'Z')
  )
    throw Error('CSWATCH_BUILD_TIMESTAMP must be a UTC build timestamp.');
  return { revision, builtAt: new Date(timestamp).toISOString() };
}

export function writeBuildInfo(output, env = process.env) {
  const value = createBuildInfo(env);
  writeFileSync(output, JSON.stringify(value) + '\n');
  return value;
}
