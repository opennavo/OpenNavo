import { beforeEach, expect, it, vi } from 'vitest';
import capability from '../src-tauri/capabilities/main.json';

const window = vi.hoisted(() => ({
  label: 'main',
  setMinSize: vi.fn().mockResolvedValue(undefined),
  setSize: vi.fn().mockResolvedValue(undefined),
  unmaximize: vi.fn().mockResolvedValue(undefined),
  center: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', async importOriginal => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/window')>()),
  getCurrentWindow: () => window
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it('Welcome relaxes minimum width, then restores app dimensions; same-mode navigation preserves size', async () => {
  const { syncMainWindow } = await import('@/composables/syncMainWindow');
  await syncMainWindow(true);
  expect(window.setMinSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 540, height: 600 }));
  expect(window.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 604, height: 820 }));
  expect(window.unmaximize).toHaveBeenCalledOnce();
  await syncMainWindow(false);
  expect(window.setMinSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1100, height: 700 }));
  expect(window.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1280, height: 820 }));
  await syncMainWindow(false);
  expect(window.setSize).toHaveBeenCalledTimes(2);
  for (const command of ['set-size', 'set-min-size', 'unmaximize', 'center']) {
    expect(capability.permissions).toContain(`core:window:allow-${command}`);
  }
});

it('Normal onboarded startup preserves restored window size', async () => {
  const { syncMainWindow } = await import('@/composables/syncMainWindow');
  await syncMainWindow(false);
  expect(window.setSize).not.toHaveBeenCalled();
  expect(window.center).not.toHaveBeenCalled();
});
