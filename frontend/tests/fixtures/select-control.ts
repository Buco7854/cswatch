import type { Locator, Page } from '@playwright/test';

/** Choose an option in the shared SelectControl dropdown, by its accessible names. */
export async function chooseSelectOption(scope: Page | Locator, label: string, option: string) {
  const page = 'page' in scope ? scope.page() : scope;
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
