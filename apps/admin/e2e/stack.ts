import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

/** E2E stack API URL (make e2e-up, 03 §5.5). */
export const API_BASE = process.env.E2E_API_BASE ?? 'http://127.0.0.1:18082';

// Seed passwords share ops/e2e.py's source: development values from apps/server/.env.example, overridable through environment variables.
function examplePassword(): string {
  const file = fileURLToPath(new URL('../../../apps/server/.env.example', import.meta.url));
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find(item => item.startsWith('E2E_ADMIN_PASSWORD='));
  return line?.slice('E2E_ADMIN_PASSWORD='.length).trim() ?? '';
}

export const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? examplePassword();

export async function stackReady(): Promise<boolean> {
  try {
    return (await fetch(`${API_BASE}/readyz`)).ok;
  } catch {
    return false;
  }
}

/** Log in to the real backend (seed users e2e-super / e2e-admin / e2e-editor / e2e-reviewer / e2e-ops). */
export async function login(page: Page, user = 'e2e-super', password = PASSWORD) {
  // These localized interaction fixtures explicitly select Chinese; the app default is English.
  await page.addInitScript(() => localStorage.setItem('ONV_ADMIN_lang', JSON.stringify('zh-CN')));
  await page.goto('/login');
  await page.getByPlaceholder('请输入用户名').fill(user);
  await page.getByPlaceholder('请输入密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL('**/dashboard');
}

/** Public API, using the same backend as web and desktop. */
export async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}/api/v1${path}`);
  const body = (await response.json()) as { data: T };
  return body.data;
}

interface Envelope<T> {
  code: string;
  msg: string;
  data: T;
}

/** Call admin API directly for test setup/cleanup; throw business errors. */
export async function adminApi<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/admin-api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const envelope = (await response.json()) as Envelope<T>;
  if (envelope.code !== '0000') throw new Error(`${method} ${path}: ${envelope.code} ${envelope.msg}`);
  return envelope.data;
}

export async function apiLogin(userName = 'e2e-super', password = PASSWORD): Promise<string> {
  const data = await adminApi<{ token: string }>(null, 'POST', '/auth/login', { userName, password });
  return data.token;
}
