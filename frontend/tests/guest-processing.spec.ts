import { test, expect } from '@playwright/test';

test('temporary demo processing preserves the private link and translates actionable failure details', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  let failed = false;
  await page.addInitScript(() => localStorage.setItem('cswatch.language', 'fr'));
  await page.route('**/api/demos/guest-processing-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'guest-processing-fixture',
        name: 'Guest fixture',
        source: 'guest',
        status: failed ? 'failed' : 'processing',
        owned: false,
        guest_owned: true,
        public: false,
        size: 100,
        map: null,
        duration: null,
        rounds: null,
        created_at: 0,
        expires_at: 2000000000,
        error: failed
          ? '[timeout] Demo processing exceeded its time limit. Ask the administrator to check worker resources or the parser time limit.'
          : null,
      },
    }),
  );
  await page.goto('/watch/guest-processing-fixture');
  await expect(
    page.getByText(
      'Conservez ce lien pour retrouver votre démo privée dans ce navigateur avant son expiration.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Retour à l’accueil', exact: true })).toHaveAttribute(
    'href',
    '/',
  );
  await expect(page.getByText(/bibliothèque/)).toHaveCount(0);
  failed = true;
  await page.reload();
  await expect(page.getByText(/^\[timeout\]/)).toContainText('limite');
  await expect(page.getByText(/guest-processing-fixture/, { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gérer la démo en échec' })).toHaveCount(0);
});
