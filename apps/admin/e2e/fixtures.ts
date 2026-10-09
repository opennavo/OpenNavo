import type { Page } from '@playwright/test';

export type Role = 'R_SUPER' | 'R_ADMIN' | 'R_EDITOR' | 'R_REVIEWER' | 'R_OPS';

/**
 * Intercept admin API calls in the browser (/proxy-default is Vite-proxied) and log in with a specified role.
 * Menu/route permissions depend only on getUserInfo roles, without a real backend.
 */
export async function loginAs(page: Page, role: Role, buttons: string[] = []) {
  await page.route('**/proxy-default/**', async route => {
    const url = route.request().url();
    if (url.includes('/auth/login')) {
      return route.fulfill({
        json: { code: '0000', msg: 'ok', data: { token: `token-${role}`, refreshToken: 'refresh' } }
      });
    }
    if (url.includes('/auth/getUserInfo')) {
      return route.fulfill({
        json: { code: '0000', msg: 'ok', data: { userId: '1', userName: role.toLowerCase(), roles: [role], buttons } }
      });
    }
    return route.fulfill({ json: { code: '0000', msg: 'ok', data: null } });
  });
  // These localized interaction fixtures explicitly select Chinese; the app default is English.
  await page.addInitScript(() => localStorage.setItem('ONV_ADMIN_lang', JSON.stringify('zh-CN')));
  await page.goto('/login');
  await page.getByPlaceholder('请输入用户名').fill(role.toLowerCase());
  await page.getByPlaceholder('请输入密码').fill('e2e-password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL('**/dashboard');
}

/** Read sidebar menus: top-level → children, expanding each group first. */
export async function readMenu(page: Page): Promise<Array<[string, string[]]>> {
  const menu = page.locator('.n-menu').first();
  await menu.locator('.n-menu-item').first().waitFor();
  const entries: Array<[string, string[]]> = [];
  const items = menu.locator(':scope > .n-menu-item, :scope > .n-submenu');
  const count = await items.count();
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const header = item.locator('.n-menu-item-content-header').first();
    const title = (await header.textContent())?.trim() ?? '';
    const isGroup = (await item.getAttribute('class'))?.includes('n-submenu') ?? false;
    if (!isGroup) {
      entries.push([title, []]);
      continue;
    }
    if ((await item.getAttribute('aria-expanded')) !== 'true') await header.click();
    const children = item.locator('.n-submenu-children .n-menu-item-content-header');
    await children.first().waitFor();
    entries.push([title, (await children.allTextContents()).map(text => text.trim())]);
  }
  return entries;
}
