import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

export type OptionsCategory = 'Visuals' | 'Crosshair' | 'Playback' | 'Camera' | 'Performance';
const french = JSON.parse(
  readFileSync(new URL('../../src/locales/fr.json', import.meta.url), 'utf8'),
) as Record<string, string>;

/** Uses the same saved language choice as a real viewer, including after reload. */
export async function selectOptionsCategory(page: Page, category: OptionsCategory) {
  const language = await page.evaluate(() => localStorage.getItem('cswatch.language'));
  const title = language === 'fr' ? french[category] || category : category;
  const tab = page.getByRole('tab', { name: title, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: title, exact: true })).toBeVisible();
}

const playbackControls = [
  'Utility replay shortcuts',
  'Kill and death replay shortcuts',
  'Skip dead time automatically',
  'Hide controls during playback',
  'Hide viewer controls',
];

/** Keep the older behavioral tests focused on their controls after regrouping. */
export async function selectOptionsForControl(page: Page, title: string) {
  const matches = (key: string) => key === title || french[key] === title;
  const category: OptionsCategory = playbackControls.some(matches)
    ? 'Playback'
    : matches('Rendering quality')
      ? 'Performance'
      : matches('Crosshair')
        ? 'Crosshair'
        : 'Visuals';
  await selectOptionsCategory(page, category);
}
