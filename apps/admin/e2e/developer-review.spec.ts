import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures';

// Developer submission review: the drawer exposes the receipt token and publishing
// sends the status the reviewer picked.
const TOKEN = 'example-receipt-token-0000000002';

function submission(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    publicToken: TOKEN,
    kind: 'new',
    status: 'submitted',
    sourceKind: 'github',
    sourceUrl: 'https://github.com/example/hyperfocus',
    packageId: null,
    payload: { name: 'Hyperfocus Timer', summary: 'A tiny focus timer for macOS.' },
    contactEmail: 'dev@example.com',
    proof: '',
    reviewerId: null,
    decisionNote: null,
    createdAt: '2026-11-11T10:00:00Z',
    updatedAt: '2026-11-11T10:00:00Z',
    decidedAt: null,
    ...overrides
  };
}

test('a reviewer publishes a submission and sees its receipt token', async ({ page }) => {
  await loginAs(page, 'R_SUPER');

  let patched: Record<string, unknown> | null = null;
  await page.route('**/proxy-default/developer/submissions**', async route => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      patched = JSON.parse(request.postData() ?? '{}');
      return route.fulfill({ json: { code: '0000', msg: 'ok', data: submission({ status: patched?.status, packageId: 42 }) } });
    }
    return route.fulfill({ json: { code: '0000', msg: 'ok', data: [submission()] } });
  });

  await page.goto('/developer/review');
  await expect(page.getByText('dev@example.com')).toBeVisible();

  await page.getByRole('button', { name: '审核' }).click();
  await expect(page.getByText('查询码:')).toBeVisible();
  await expect(page.getByText(TOKEN)).toBeVisible();
  await expect(page.getByText('类型:')).toBeVisible();

  await page.getByRole('button', { name: '发布' }).click();
  await expect.poll(() => patched?.status).toBe('published');
});
