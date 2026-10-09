import type { Kind } from '@/ipc/bindings';
import { useNamesStore } from '@/stores/names';
import { useAppLocale } from './useAppLocale';

/** kind/token → localized display name and icon (task cards, history, menu bar). */
export function usePackageIdentity() {
  const names = useNamesStore();
  const { pick } = useAppLocale();

  function displayName(kind: Kind, token: string): string {
    const entry = names.lookup(kind, token);
    return entry ? pick(entry.displayName, entry.name, entry.sourceLocale) : token;
  }

  function icon(kind: Kind, token: string) {
    const entry = names.lookup(kind, token);
    return {
      kind,
      token,
      name: displayName(kind, token),
      src: entry?.iconUrl ?? null,
      accent: entry?.accentColor ?? null
    };
  }

  return { displayName, icon };
}
