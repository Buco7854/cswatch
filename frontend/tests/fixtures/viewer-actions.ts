import type { Page } from '@playwright/test';

/** Follow the same direct-or-More entry a reviewer uses at each viewport. */
export async function activateViewerAction(page: Page, label: string, moreLabel = 'More controls') {
  const direct = page.getByRole('button', { name: label, exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await page.getByRole('button', { name: moreLabel, exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  }
}
