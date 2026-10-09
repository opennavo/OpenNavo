import { isTauri } from '@tauri-apps/api/core';
import { currentMonitor, primaryMonitor, getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';

let welcomeMode: boolean | undefined;

/** Welcome occupies the window itself; restore the main window size and minimum size when entering the app. */
export async function syncMainWindow(welcome: boolean) {
  if (!isTauri() || welcomeMode === welcome) return;
  const window = getCurrentWindow();
  if (window.label !== 'main') return;
  const monitor = (await currentMonitor()) ?? (await primaryMonitor());
  const scale = await window.scaleFactor();
  const inner = (await window.innerSize()).toLogical(scale);
  const outer = (await window.outerSize()).toLogical(scale);
  const area = monitor?.workArea.size.toLogical(monitor.scaleFactor);
  const origin = monitor?.workArea.position.toLogical(monitor.scaleFactor);
  const frameWidth = Math.max(0, outer.width - inner.width);
  const frameHeight = Math.max(0, outer.height - inner.height);
  const fit = (width: number, height: number) =>
    new LogicalSize(
      Math.min(width, area ? Math.max(1, Math.floor(area.width - frameWidth)) : width),
      Math.min(height, area ? Math.max(1, Math.floor(area.height - frameHeight)) : height)
    );
  const minimum = welcome ? fit(540, 600) : fit(1100, 700);
  await window.setMinSize(minimum);
  const target = welcome ? fit(604, 820) : welcomeMode === true ? fit(1400, 820) : fit(inner.width, inner.height);
  const resized = target.width !== inner.width || target.height !== inner.height;
  if (welcome) {
    await window.unmaximize();
  }
  if (welcome || welcomeMode === true || resized) {
    await window.setSize(target);
    if (area && origin) {
      await window.setPosition(
        new LogicalPosition(
          origin.x + Math.max(0, (area.width - target.width - frameWidth) / 2),
          origin.y + Math.max(0, (area.height - target.height - frameHeight) / 2)
        )
      );
    } else await window.center();
  }
  welcomeMode = welcome;
}
