import { expect, test, type Page } from '@playwright/test';

/** Sign in to the mock Hermes Panel so history comes from the host's session store. */
async function connectPanel(page: Page) {
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
  await page.getByRole('button', { name: /连接 Hermes Panel/ }).click();
  const dialog = page.getByRole('dialog');
  const inputs = dialog.locator('input');
  await inputs.nth(0).fill('Tailscale Panel');
  await inputs.nth(1).fill('http://panel.tail1234.ts.net:9119');
  await inputs.nth(2).fill('admin');
  await inputs.nth(3).fill('test-password');
  await dialog.getByRole('button', { name: /登录并连接/ }).click();
  await expect(dialog).not.toBeVisible();
}

test('lists panel conversations by the host’s own title and preview', async ({ page }) => {
  await connectPanel(page);
  await page.locator('[data-hermes-history-toggle]').click();
  const panel = page.locator('[data-hermes-history]');
  await expect(panel).toBeVisible();

  // The host title wins over the injected `[IMPORTANT: …]` preamble it also stores.
  await expect(panel.getByText('Panel ok confirmation')).toBeVisible();
  await expect(panel.getByText('Reply with exactly PANEL_OK')).toBeVisible();
  await expect(panel.getByText('每日检查 Hermes 更新')).toBeVisible();
  await expect(panel).not.toContainText('IMPORTANT');

  // The panel owns the store, so the footer must not claim local storage.
  await expect(panel.getByText('对话保存在面板主机上')).toBeVisible();
  // Clearing the host's sessions is not offered.
  await expect(panel.getByRole('button', { name: '清空历史' })).toHaveCount(0);
});

test('reads a panel transcript only after the conversation is opened', async ({ page }) => {
  await connectPanel(page);
  await page.locator('[data-hermes-history-toggle]').click();
  const panel = page.locator('[data-hermes-history]');
  await panel.getByRole('button', { name: /Panel ok confirmation/ }).click();

  await expect(page.getByText('Reply with exactly PANEL_OK')).toBeVisible();
  await expect(page.getByText('PANEL_OK', { exact: true })).toBeVisible();
});

test('folds a panel tool round into the turn that ran it', async ({ page }) => {
  await connectPanel(page);
  // The research profile owns the tool fixture.
  await page.locator('[data-hermes-history-toggle]').click();
  await page
    .locator('[data-hermes-history]')
    .getByRole('button', { name: /整理 ASO 关键词/ })
    .click();

  // The call sits inside the assistant turn's collapsed tool block.
  await page.getByText('调用了 1 个工具').click();
  await expect(page.getByText('app_store.search')).toBeVisible();
  await page.getByText('参数与结果').first().click();
  await expect(page.getByText('"term":"班级宠物"')).toBeVisible();
  await expect(page.getByText('"rank":3')).toBeVisible();
});

test('offers older messages for a long panel conversation', async ({ page }) => {
  await connectPanel(page);
  await page.locator('[data-hermes-history-toggle]').click();
  await page
    .locator('[data-hermes-history]')
    .getByRole('button', { name: /长会话分页/ })
    .click();

  // A full 120-row page means the session continues behind the tail.
  await expect(page.getByRole('button', { name: /显示更早的消息/ })).toBeVisible();
  await page.getByRole('button', { name: /显示更早的消息/ }).click();
  // The remaining 10 rows are shorter than a page, so the control retires.
  await expect(page.getByRole('button', { name: /显示更早的消息/ })).toHaveCount(0);
  await expect(page.getByText('第 1 条消息')).toBeVisible();
});
