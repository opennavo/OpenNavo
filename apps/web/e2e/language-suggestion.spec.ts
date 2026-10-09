import { expect, test } from '@playwright/test';
import { gotoReady } from './helpers';

test('Suggest English preserving search path/query; manual selection suppresses further prompts', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-GB'] });
  });
  await gotoReady(page, '/zh/search?q=vscode');
  const suggestion = page.getByTestId('language-suggestion');
  await expect(suggestion).toHaveAttribute('lang', 'en-US');
  await suggestion.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === 'vscode');
  await gotoReady(page, '/zh/search?q=vscode');
  await expect(suggestion).toHaveCount(0);
});

test('Persist Do not ask again without automatic navigation', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US'] });
  });
  await gotoReady(page, '/zh/about');
  await page.getByTestId('language-suggestion').getByRole('button', { name: 'Don’t suggest again' }).click();
  await page.reload();
  await expect(page.getByTestId('language-suggestion')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/zh/about');
});
