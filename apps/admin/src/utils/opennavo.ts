import dayjs from 'dayjs';
import type { Schemas } from '@/typings/api/opennavo';

/** Remove null/undefined/empty query parameters: axios serializes null as empty, which backend typed parsing rejects. */
export function compactParams<T extends object>(params: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== undefined && value !== '')
  ) as Partial<T>;
}

/** Display times consistently as YYYY-MM-DD HH:mm (07 §7). */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—';
}

/** Options for Yes / No / Any tristate filters. */
export function booleanOptions(yes: string, no: string) {
  return [
    { label: yes, value: 'true' },
    { label: no, value: 'false' }
  ];
}

/** Tristate selection string (for NSelect) → query parameter. */
export function toBoolean(value: string | null | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Publication-status colors for collections/features. */
export const PUBLISH_STATUS_TAG = {
  draft: 'default',
  scheduled: 'info',
  published: 'success',
  archived: 'warning'
} as const;

/**
 * Contracts include Hermes dryRun previews as possible write responses; admin pages never request previews.
 * Exclude the preview branch before reading result fields such as id/url; previews need not contain them.
 */
export function isDryRun(data: unknown): data is Schemas['AgentDryRun'] {
  return typeof data === 'object' && data !== null && (data as { dryRun?: unknown }).dryRun === true;
}
