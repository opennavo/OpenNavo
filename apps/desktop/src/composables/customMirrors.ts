import type { MirrorInput } from '@/ipc/bindings';

export const CUSTOM_MIRROR_LIMIT = 20;
export const MIRROR_FIELDS = ['apiDomain', 'bottleDomain', 'brewGitRemote', 'coreGitRemote'] as const;
export type MirrorField = (typeof MIRROR_FIELDS)[number];
export type CustomMirrorDraft = { name: string } & Record<MirrorField, string>;
export type MirrorErrors = Partial<
  Record<
    'name' | MirrorField | 'addresses',
    'nameRequired' | 'nameInvalid' | 'urlInvalid' | 'apiQueryInvalid' | 'addressRequired'
  >
>;

function hasControls(value: string): boolean {
  return [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function validateMirrorDraft(draft: CustomMirrorDraft): MirrorErrors {
  const errors: MirrorErrors = {};
  if (!draft.name.trim()) errors.name = 'nameRequired';
  else if (draft.name.trim().length > 120 || hasControls(draft.name)) errors.name = 'nameInvalid';
  for (const field of MIRROR_FIELDS) {
    const value = draft[field].trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (
        value.length > 4096 ||
        hasControls(draft[field]) ||
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.hash
      ) {
        errors[field] = 'urlInvalid';
      } else if (field === 'apiDomain' && url.href.includes('?')) {
        errors[field] = 'apiQueryInvalid';
      }
    } catch {
      errors[field] = 'urlInvalid';
    }
  }
  if (MIRROR_FIELDS.every(field => !draft[field].trim())) errors.addresses = 'addressRequired';
  return errors;
}

function normalizeApiDomain(value: string): string {
  const url = new URL(value);
  if (url.href.includes('?')) throw new Error('API base URLs cannot contain a query');
  return url.href.replace(/\/+$/, '');
}

export function apiProbeUrl(value: string): string {
  // Use the same string concatenation as Homebrew, starting with the saved base.
  return `${normalizeApiDomain(value)}/cask.jws.json`;
}

export function customMirrorInput(draft: CustomMirrorDraft, key: string): MirrorInput {
  const addresses = Object.fromEntries(MIRROR_FIELDS.map(field => [field, draft[field].trim() || null])) as Record<
    MirrorField,
    string | null
  >;
  if (addresses.apiDomain) addresses.apiDomain = normalizeApiDomain(addresses.apiDomain);
  return {
    key,
    name: draft.name.trim(),
    ...addresses,
    probeUrl: addresses.apiDomain
      ? apiProbeUrl(addresses.apiDomain)
      : (addresses.bottleDomain ?? addresses.brewGitRemote ?? addresses.coreGitRemote ?? '')
  };
}

/** Check every configured address, rather than marking a broken Bottle endpoint healthy after an API check. */
export function customMirrorProbes(input: MirrorInput): MirrorInput[] {
  const normalized = {
    ...input,
    apiDomain: input.apiDomain ? normalizeApiDomain(input.apiDomain) : null
  };
  return MIRROR_FIELDS.flatMap(field => {
    const value = normalized[field];
    return value
      ? [
          {
            ...normalized,
            // Rust validates probe keys with Homebrew's lowercase token rules.
            key: `${input.key}-${field.toLowerCase()}`,
            name: field,
            probeUrl: field === 'apiDomain' ? apiProbeUrl(value) : value
          }
        ]
      : [];
  });
}
