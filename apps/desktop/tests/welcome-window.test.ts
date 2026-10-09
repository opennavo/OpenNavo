import { beforeEach, expect, it, vi } from 'vitest';
import capability from '../src-tauri/capabilities/main.json';

const window = vi.hoisted(() => ({
  label: 'main',
  setMinSize: vi.fn().mockResolvedValue(undefined),
  setSize: vi.fn().mockResolvedValue(undefined),
  unmaximize: vi.fn().mockResolvedValue(undefined),
  center: vi.fn().mockResolvedValue(undefined),
  setPosition: vi.fn().mockResolvedValue(undefined),
  scaleFactor: vi.fn().mockResolvedValue(2),
  innerSize: vi.fn(),
  outerSize: vi.fn()
}));
const monitors = vi.hoisted(() => ({ current: vi.fn(), primary: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', async importOriginal => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/window')>()),
  getCurrentWindow: () => window,
  currentMonitor: monitors.current,
  primaryMonitor: monitors.primary
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const { PhysicalSize, PhysicalPosition } = await import('@tauri-apps/api/window');
  window.innerSize.mockResolvedValue(new PhysicalSize(2560, 1640));
  window.outerSize.mockResolvedValue(new PhysicalSize(2560, 1640));
  monitors.current.mockResolvedValue({
    scaleFactor: 2,
    workArea: {
      size: new PhysicalSize(3840, 2080),
      position: new PhysicalPosition(0, 48)
    }
  });
  monitors.primary.mockResolvedValue(null);
});

it('Welcome relaxes minimum width, then restores app dimensions; same-mode navigation preserves size', async () => {
  const { syncMainWindow } = await import('@/composables/syncMainWindow');
  await syncMainWindow(true);
  expect(window.setMinSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 540, height: 600 }));
  expect(window.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 604, height: 820 }));
  expect(window.unmaximize).toHaveBeenCalledOnce();
  await syncMainWindow(false);
  expect(window.setMinSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1100, height: 700 }));
  expect(window.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1400, height: 820 }));
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

it.each([false, true])('Fits a 1512-wide Retina work area at startup/after welcome (%s)', async welcome => {
  const { PhysicalSize, PhysicalPosition } = await import('@tauri-apps/api/window');
  const { syncMainWindow } = await import('@/composables/syncMainWindow');
  if (welcome) await syncMainWindow(true);
  monitors.current.mockResolvedValue({
    scaleFactor: 2,
    workArea: {
      size: new PhysicalSize(3024, 1500),
      position: new PhysicalPosition(-3024, 100)
    }
  });
  window.innerSize.mockResolvedValue(new PhysicalSize(3200, 1640));
  window.outerSize.mockResolvedValue(new PhysicalSize(3200, 1640));
  await syncMainWindow(false);
  expect(window.setSize).toHaveBeenLastCalledWith(
    expect.objectContaining({ width: welcome ? 1400 : 1512, height: 750 })
  );
  expect(window.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: welcome ? -1456 : -1512, y: 50 }));
});

it('Lowers minimum size on tiny screens and reserves native frame space', async () => {
  const { PhysicalSize, PhysicalPosition } = await import('@tauri-apps/api/window');
  monitors.current.mockResolvedValue(null);
  monitors.primary.mockResolvedValue({
    scaleFactor: 1,
    workArea: {
      size: new PhysicalSize(1000, 650),
      position: new PhysicalPosition(0, 30)
    }
  });
  window.outerSize.mockResolvedValue(new PhysicalSize(2560, 1680));
  const { syncMainWindow } = await import('@/composables/syncMainWindow');
  await syncMainWindow(false);
  expect(window.setMinSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1000, height: 630 }));
  expect(window.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1000, height: 630 }));
});
