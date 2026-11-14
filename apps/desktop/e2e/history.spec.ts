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
  await expect(panel).not.toContainText('IMPORTANT');

  // The panel owns the store, so the footer must not claim local storage.
  await expect(panel.getByText('对话保存在面板主机上')).toBeVisible();
  // Clearing the host's sessions is not offered.
  await expect(panel.getByRole('button', { name: '清空历史' })).toHaveCount(0);
});

test('keeps gateway threads in their own per-platform section', async ({ page }) => {
  await connectPanel(page);
  await page.locator('[data-hermes-history-toggle]').click();
  const panel = page.locator('[data-hermes-history]');

  // Recents is local-only: a Telegram thread must not push local chats off the list.
  await expect(panel.getByText('Panel ok confirmation')).toBeVisible();
  await expect(panel.getByText('每日检查 Hermes 更新')).toHaveCount(0);

  await panel.locator('[data-hermes-view="messaging"]').click();

  // One section per platform, three rows up front, the rest behind "show more".
  const telegram = panel.locator('[data-hermes-history-group="platform-telegram"]');
  await expect(telegram.locator('[data-hermes-history-group-label]')).toHaveText('Telegram');
  await expect(telegram.getByText('Telegram 讨论 1')).toBeVisible();
  await expect(telegram.getByText('Telegram 讨论 4')).toHaveCount(0);
  await telegram.getByRole('button', { name: '显示更多', exact: true }).click();
  await expect(telegram.getByText('Telegram 讨论 4')).toBeVisible();

  // A second platform gets its own section rather than mixing rows.
  const discord = panel.locator('[data-hermes-history-group="platform-discord"]');
  await expect(discord.getByText('Discord 值班频道')).toBeVisible();

  // Search narrows the view on screen instead of jumping to another slice.
  await panel.locator('#hermes-history-search').fill('Discord');
  await expect(discord.getByText('Discord 值班频道')).toBeVisible();
  await expect(telegram.getByText('Telegram 讨论 1')).toHaveCount(0);
});

test('merges every profile on the host when asked', async ({ page }) => {
  await connectPanel(page);
  await page.locator('[data-hermes-history-toggle]').click();
  const panel = page.locator('[data-hermes-history]');
  await panel.locator('[data-hermes-view="messaging"]').click();

  // Another profile's gateway threads stay hidden until the aggregate is on.
  await expect(panel.getByText('ASO 关键词周报')).toHaveCount(0);
  await panel.locator('[data-hermes-history-all-profiles]').click();

  await expect(panel.getByText('ASO 关键词周报')).toBeVisible();
  await expect(panel.locator('[data-hermes-history-profile]').first()).toContainText('aso-u4e13-u5bb6');
});

test('shows scheduled jobs and restores an archived conversation', async ({ page }) => {
  await connectPanel(page);
  await page.locator('[data-hermes-history-toggle]').click();
  const panel = page.locator('[data-hermes-history]');

  // Scheduled runs are their own list, never mixed into recents — a chatty job would
  // otherwise put 40 routine runs above every real conversation.
  await expect(panel.getByText(/每小时检查更新 · /)).toHaveCount(0);
  await panel.locator('[data-hermes-view="cron"]').click();

  // Grouped per job, three runs up front, the rest behind "show more".
  const job = panel.locator('[data-hermes-history-group="job-每小时检查更新"]');
  await expect(job.locator('[data-hermes-history-group-label]')).toHaveText('每小时检查更新');
  await expect(job.getByText('每小时检查更新 · Nov 13 06:00')).toBeVisible();
  await expect(job.getByText('每小时检查更新 · Nov 13 03:00')).toHaveCount(0);
  await job.getByRole('button', { name: '显示更多', exact: true }).click();
  await expect(job.getByText('每小时检查更新 · Nov 13 03:00')).toBeVisible();

  await panel.locator('[data-hermes-view="archived"]').click();
  const archived = panel.getByText('上周的排查记录');
  await expect(archived).toBeVisible();

  // Restore writes to the host and drops the row from the archive list.
  await panel
    .locator('[data-hermes-history-group="archived"]')
    .getByRole('button', { name: '恢复', exact: true })
    .click();
  await expect(panel.getByText('上周的排查记录')).toHaveCount(0);

  await panel.locator('[data-hermes-view="recents"]').click();
  await expect(panel.getByText('上周的排查记录')).toBeVisible();
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

test('explains an older panel that cannot merge profiles', async ({ page }) => {
  // `panel-no-aggregate` makes the mock answer the aggregated request the way a pre-0.23 host
  // does: 404 → the client degrades to the current profile and says so.
  await page.addInitScript(() => {
    localStorage.setItem(
      'ONV_DESKTOP_mock_settings',
      JSON.stringify({ onboardingCompleted: true, locale: 'zh-CN', localeMode: 'manual' })
    );
  });
  await page.goto('/?mock=hermes-ready,panel-no-aggregate&mock-system-locale=zh-CN#/assistant');
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

  await page.locator('[data-hermes-history-toggle]').click();
  const panel = page.locator('[data-hermes-history]');
  await panel.locator('[data-hermes-history-all-profiles]').click();

  await expect(panel.locator('[data-hermes-history-degraded]')).toBeVisible();
  // The list still renders the current profile's rows instead of failing.
  await expect(panel.getByText('Panel ok confirmation')).toBeVisible();
});

test('surfaces a failed history read and retries instead of showing an empty list', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'ONV_DESKTOP_mock_settings',
      JSON.stringify({ onboardingCompleted: true, locale: 'zh-CN', localeMode: 'manual' })
    );
  });
  await page.goto('/?mock=hermes-ready,panel-history-fails&mock-system-locale=zh-CN#/assistant');
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

  await page.locator('[data-hermes-history-toggle]').click();
  const panel = page.locator('[data-hermes-history]');

  // A failed read must say so (and offer a retry), never look like "no conversations".
  await expect(panel.locator('[data-hermes-history-error]')).toBeVisible();
  await expect(panel.getByRole('button', { name: '重试' })).toBeVisible();
  await expect(panel.getByText('还没有对话')).toHaveCount(0);
});
