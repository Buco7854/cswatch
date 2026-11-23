import type { Page } from '@playwright/test';

/** Project mock accounts through the same browser-visible fields as /api/auth/me. */
export function accountStatus<T extends { username?: string; csrf?: string }>(account: T | null) {
  const user = account && { has_password: true, display_name: account.username, ...account };
  return {
    user,
    session: {
      stage: user ? 'full' : 'anonymous',
      anonymous_id: user ? null : 'synthetic-anonymous-grant',
      csrf: user?.csrf ?? 'synthetic-bootstrap-csrf',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      proof_fresh: Boolean(user),
      proof_kind: user ? 'password' : null,
      proof_at: user ? Math.floor(Date.now() / 1000) : null,
      factors: user ? { passkey: false, totp: false, recovery: false } : null,
      username: null,
      display_name: null,
    },
    guest_session: null,
  };
}

/** Pair a mocked status with the instance's public configuration. */
export async function configForSyntheticAccount(page: Page) {
  await page.route('**/api/config', async (route) => {
    const config = await page.request.get('/api/config');
    await route.fulfill({ response: config });
  });
}
