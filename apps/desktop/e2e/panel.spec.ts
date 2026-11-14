import { expect, test } from '@playwright/test';

test('connects a Hermes Panel and shows its profiles', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'ONV_DESKTOP_mock_settings',
      JSON.stringify({ onboardingCompleted: true, locale: 'zh-CN', localeMode: 'manual' })
    );
  });
  await page.goto('/?mock=hermes-ready&mock-system-locale=zh-CN#/assistant');
  await expect(page.getByPlaceholder(/问问 Hermes/)).toBeVisible();
  await page
    .getByRole('button', { name: /管理连接/ })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: /连接|Connections/ })).toBeVisible();
  await page.getByRole('button', { name: /连接 Hermes Panel/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const inputs = dialog.locator('input');
  await inputs.nth(0).fill('Tailscale Panel');
  await inputs.nth(1).fill('http://panel.tail1234.ts.net:9119');
  await inputs.nth(2).fill('admin');
  await inputs.nth(3).fill('test-password');
  await dialog.getByRole('button', { name: /登录并连接/ }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Research' }).first()).toBeVisible();
});
