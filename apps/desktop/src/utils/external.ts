import { isTauri } from '@tauri-apps/api/core';

/** Open external links in the system browser (opener permits only https: and x-apple.systempreferences:, 06 §14); browser mode opens a new tab. */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
