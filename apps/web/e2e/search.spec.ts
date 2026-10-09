import { expect, test } from '@playwright/test';
import { gotoReady } from './helpers';

// 10 §4 M2-03: vscode search ranks Visual Studio Code first; assert token because seed-e2e has a Chinese display name.
test('vscode search ranks Visual Studio Code first', async ({ page }) => {
  await gotoReady(page, '/zh/search?q=vscode');
  const first = page.getByRole('listitem').first().getByRole('link').first();
  await expect(first).toHaveAttribute('href', '/zh/apps/visual-studio-code');
  await expect(page).toHaveTitle(/vscode/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');
});

test('Command-K vscode then Enter opens Visual Studio Code details', async ({ page }) => {
  await gotoReady(page, '/zh');
  await page.keyboard.press('ControlOrMeta+K');
  const input = page.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('vscode');
  await expect(page.getByRole('option').first()).toContainText(/VS Code|Visual Studio Code/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/apps\/visual-studio-code$/);
});

test('Zero results show empty state and listing suggestion', async ({ page }) => {
  await gotoReady(page, '/zh/search?q=zzqxjv-not-a-package');
  await expect(page.getByRole('heading', { name: /没有找到/ })).toBeVisible();
  await expect(page.getByRole('link', { name: '提交建议收录' })).toHaveAttribute(
    'href',
    /\/feedback\?type=suggest_package/
  );
});
