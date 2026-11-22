import { expect, type Page } from '@playwright/test';

export async function chooseCameraControl(page: Page, name: string, label = 'Camera mode') {
  const direct = page.getByRole('group', { name: label, exact: true });
  const dropdown = page.getByRole('combobox', { name: label, exact: true });
  await expect(direct.or(dropdown)).toBeVisible();
  if (await direct.isVisible()) {
    await direct.getByRole('button', { name, exact: true }).click();
  } else {
    await dropdown.click();
    await page.getByRole('option', { name, exact: true }).click();
  }
}

export async function expectCameraControl(page: Page, name: string) {
  const direct = page.getByRole('group', { name: 'Camera mode', exact: true });
  if (await direct.isVisible()) {
    const button = direct.getByRole('button', {
      name: name === '2D map fallback' ? '2D tactical · low power' : name,
      exact: true,
    });
    if (name === '2D map fallback') await expect(button).toHaveAttribute('data-fallback', 'true');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  } else {
    await expect(page.getByRole('combobox', { name: 'Camera mode' })).toContainText(name);
  }
}

export async function choosePlaybackSpeed(page: Page, name: string) {
  const direct = page.getByRole('group', { name: 'Playback speed', exact: true });
  if (await direct.isVisible()) {
    await direct.getByRole('button', { name, exact: true }).click();
  } else {
    await page.getByRole('combobox', { name: 'Playback speed', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
  }
}
