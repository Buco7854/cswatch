import type { Page } from '@playwright/test';
import type { Config, Demo } from '../../src/types';
import type { MapPreparationDiagnostics } from '../../../shared/map-acquisition';

export const memberConfig: Config = {
  build: { revision: 'a'.repeat(40), builtAt: '2026-11-19T12:00:00.000Z' },
  setup_required: false,
  public_access: true,
  registrations_enabled: true,
  guest_uploads_enabled: true,
  auto_official_maps_enabled: true,
  guest_retention_hours: 24,
  steam_enabled: true,
  faceit_enabled: true,
  max_upload_mb: 1024,
  retention_days: 30,
  faceit_configured: false,
  faceit_downloads: false,
  steam_discovery: false,
  transcription_enabled: false,
  transcription_configured: false,
};
export const memberDemos: Demo[] = [
  ['ready', 'de_mirage', 'Premier - Mirage, overtime review', 27],
  ['processing', 'de_ancient', 'Competitive - Ancient, second half', null],
  ['queued', null, 'Wingman - late-night practice session', null],
  ['failed', 'de_dust2', 'Dust2 - reviewing the opening round', null],
].map(([status, map, name, rounds], index) => ({
  id: `member-design-${index}`,
  status: status as string,
  map: map as string | null,
  name: name as string,
  rounds: rounds as number | null,
  source: index === 0 ? 'faceit' : 'upload',
  size: 1024 * (index + 1),
  public: index === 0,
  owned: true,
  duration: null,
  created_at: 1794930000 - index * 86400,
  error: null,
}));
export function memberAdminData() {
  return {
    mapReadiness: {
      enabled: true,
      worker: { available: false },
      inventory: { status: 'unavailable', mapCount: 0 },
      catalog: { status: 'empty', entries: 0 },
    } satisfies MapPreparationDiagnostics,
    flags: Object.fromEntries(
      Object.entries({
        public_access: true,
        registrations_enabled: false,
        guest_uploads_enabled: true,
        auto_official_maps_enabled: true,
        steam_enabled: true,
        faceit_enabled: true,
        transcription_enabled: false,
      }).map(([key, value]) => [key, { value, locked: key === 'public_access' }]),
    ),
    queue: [
      { status: 'ready', count: 12 },
      { status: 'processing', count: 1 },
      { status: 'queued', count: 1 },
      { status: 'failed', count: 2 },
    ],
    users: [
      { id: 'qa-operator', username: 'QA operator', is_admin: true, created_at: 1794930000 },
      {
        id: 'qa-long-name',
        username: 'QA reviewer with a longer account name',
        is_admin: false,
        created_at: 1794930000,
      },
    ],
    audit: [
      { action: 'admin.settings.updated', created_at: 1794930000 },
      { action: 'auth.login.success', created_at: 1794929000 },
    ],
  };
}
export const memberUser = {
  id: 'qa-operator',
  username: 'QA operator',
  is_admin: true,
  csrf: 'synthetic-member-csrf',
  identities: [{ provider: 'steam', subject: '76561190000000000' }],
};
export async function installMemberWorkspace(page: Page) {
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: memberUser,
      },
    }),
  );
  await page.route('**/api/demos?**', (route) => {
    const query = new URL(route.request().url()).searchParams.get('q')?.toLowerCase() || '';
    const demos = memberDemos.filter((demo) =>
      `${demo.map} ${demo.name}`.toLowerCase().includes(query),
    );
    return route.fulfill({ json: { demos, total: demos.length } });
  });
  await page.route('**/api/admin', (route) => route.fulfill({ json: memberAdminData() }));
}
