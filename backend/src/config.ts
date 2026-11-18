import { resolve } from 'node:path';
import { z } from 'zod';
const boolean = (v: string | undefined): boolean | undefined => {
  if (v === undefined || v === '') return undefined;
  if (!['true', 'false'].includes(v))
    throw new Error('Boolean environment settings must be true or false');
  return v === 'true';
};
const integer = (v: string | undefined, fallback: number, min = 1) =>
  z.coerce
    .number()
    .int()
    .min(min)
    .parse(v || fallback);
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const appUrl = new URL(env.APP_URL || 'http://localhost:8000');
  if (
    !['http:', 'https:'].includes(appUrl.protocol) ||
    appUrl.pathname !== '/' ||
    appUrl.username ||
    appUrl.password ||
    appUrl.search ||
    appUrl.hash
  )
    throw new Error('APP_URL must be an HTTP(S) origin');
  const cookieSecure = boolean(env.COOKIE_SECURE) ?? true;
  if (cookieSecure && appUrl.protocol !== 'https:')
    throw new Error('HTTPS APP_URL required. Set COOKIE_SECURE=false only for local development.');
  return {
    appUrl: appUrl.origin,
    host: appUrl.host,
    cookieSecure,
    dataDir: resolve(env.DATA_DIR || '../var'),
    mapAssetsDir: resolve(env.MAP_ASSETS_DIR || `${env.DATA_DIR || '../var'}/maps`),
    mapCatalogFile: resolve(env.MAP_CATALOG_FILE || `${env.DATA_DIR || '../var'}/map-catalog.json`),
    mapJobsDir: resolve(env.MAP_JOBS_DIR || `${env.DATA_DIR || '../var'}/map-jobs`),
    frontendDir: resolve(env.FRONTEND_DIR || '../frontend/dist'),
    port: integer(env.PORT, 8000),
    trustProxy:
      env.TRUSTED_PROXY_IPS?.split(',')
        .map((x) => x.trim())
        .filter(Boolean) ?? false,
    flags: {
      public_access: boolean(env.PUBLIC_ACCESS),
      auto_official_maps_enabled: boolean(env.AUTO_OFFICIAL_MAPS_ENABLED),
      guest_uploads_enabled: boolean(env.GUEST_UPLOADS_ENABLED),
      registrations_enabled: boolean(env.REGISTRATIONS_ENABLED),
      steam_enabled: boolean(env.STEAM_ENABLED),
      faceit_enabled: boolean(env.FACEIT_ENABLED),
      transcription_enabled: boolean(env.TRANSCRIPTION_ENABLED),
    },
    steamApiKey: env.STEAM_API_KEY || '',
    adminUsername:
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{3,32}$/)
        .optional()
        .parse(env.ADMIN_USERNAME || undefined) || '',
    adminPassword:
      z
        .string()
        .min(12)
        .max(128)
        .optional()
        .parse(env.ADMIN_PASSWORD || undefined) || '',
    guestRetentionHours: z.coerce
      .number()
      .int()
      .min(1)
      .max(168)
      .parse(env.GUEST_RETENTION_HOURS || 24),
    guestDemoLimit: integer(env.GUEST_DEMO_LIMIT, 3),
    guestStorageMb: integer(env.GUEST_STORAGE_MB, 512),
    faceitApiKey: env.FACEIT_API_KEY || '',
    faceitDownloadToken: env.FACEIT_DOWNLOAD_TOKEN || '',
    maxUploadMb: integer(env.MAX_UPLOAD_MB, 512),
    maxExpandedMb: integer(env.MAX_EXPANDED_MB, 2048),
    userStorageMb: integer(env.USER_STORAGE_MB, 2048),
    globalStorageMb: integer(env.GLOBAL_STORAGE_MB, 20480),
    userDemoLimit: integer(env.USER_DEMO_LIMIT, 50),
    parserTimeoutSeconds: integer(env.PARSER_TIMEOUT_SECONDS, 300),
    parserMemoryMb: integer(env.PARSER_MEMORY_MB, 4096),
    parserSandbox: z.enum(['required', 'off']).parse(env.PARSER_SANDBOX || 'required'),
    parserSandboxBinary: env.PARSER_SANDBOX_BINARY ? resolve(env.PARSER_SANDBOX_BINARY) : '',
    workerRole: z.enum(['parse', 'transcription', 'all']).parse(env.WORKER_ROLE || 'all'),
    transcriptionModelDir: env.TRANSCRIPTION_MODEL_DIR ? resolve(env.TRANSCRIPTION_MODEL_DIR) : '',
    transcriptionTimeoutSeconds: z.coerce
      .number()
      .int()
      .min(1)
      .max(3600)
      .parse(env.TRANSCRIPTION_TIMEOUT_SECONDS || 600),
    transcriptionMaxAudioSeconds: z.coerce
      .number()
      .int()
      .min(1)
      .max(10800)
      .parse(env.TRANSCRIPTION_MAX_AUDIO_SECONDS || 600),
    transcriptionLanguage: z
      .union([z.literal('auto'), z.string().regex(/^[a-z]{2,3}$/)])
      .parse(env.TRANSCRIPTION_LANGUAGE || 'auto'),
    sessionDays: integer(env.SESSION_DAYS, 7),
    retentionDays: integer(env.RETENTION_DAYS, 30, 0),
  };
}
export type Config = ReturnType<typeof loadConfig>;
export const flagDefaults = {
  public_access: true,
  auto_official_maps_enabled: false,
  guest_uploads_enabled: true,
  registrations_enabled: true,
  steam_enabled: false,
  faceit_enabled: false,
  transcription_enabled: false,
};
export type Flag = keyof typeof flagDefaults;
