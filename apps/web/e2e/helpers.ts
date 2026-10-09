import type { Page } from '@playwright/test';

/** Open a page and await hydration; development loads scripts on demand, so early clicks may precede event binding. */
export async function gotoReady(page: Page, url: string) {
  const response = await page.goto(url);
  await page.waitForLoadState('networkidle');
  return response;
}
