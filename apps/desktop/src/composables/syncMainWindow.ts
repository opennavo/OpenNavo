import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';

let welcomeMode: boolean | undefined;

/** Welcome occupies the window itself; restore the main window size and minimum size when entering the app. */
export async function syncMainWindow(welcome: boolean) {
  if (!isTauri() || welcomeMode === welcome) return;
  const window = getCurrentWindow();
  if (window.label !== 'main') return;
  if (welcome) {
    await window.setMinSize(new LogicalSize(540, 600));
    await window.unmaximize();
    await window.setSize(new LogicalSize(604, 820));
    await window.center();
  } else {
    await window.setMinSize(new LogicalSize(1100, 700));
    if (welcomeMode === true) {
      await window.setSize(new LogicalSize(1280, 820));
      await window.center();
    }
  }
  welcomeMode = welcome;
}
