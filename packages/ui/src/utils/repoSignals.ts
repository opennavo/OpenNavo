/**
 * Optional repository metadata used by the package detail spec card.
 *
 * The public API will add these fields independently of the UI rollout, so the
 * adapter deliberately accepts unknown input and reads only the `repository`
 * object from the package payload. Keeping this view model in the UI package means web and
 * desktop can render the same data without coupling to an API response shape.
 */
import type { SiteLocale } from '@opennavo/shared';

export interface PackageRepoSignals {
  stars?: number;
  pushedAt?: string;
  checkedAt?: string;
  archived?: boolean;
  repoUrl?: string;
}

/** Hand-written shape for the optional `data.repository` API object. */
export interface PackageRepositoryInput {
  url?: string | null;
  stars?: number | null;
  pushedAt?: string | null;
  archived?: boolean;
  signalsCheckedAt?: string | null;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0)
    return Number(value);
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function dateValue(value: unknown): string | undefined {
  const date = stringValue(value);
  return date && Number.isFinite(Date.parse(date)) ? date : undefined;
}

/**
 * Adapt a package/API payload to the independent display view model.
 * Missing or malformed optional fields are ignored; a null result means the
 * page has no repository signal to show yet.
 */
export function toPackageRepoSignals(input: unknown): PackageRepoSignals | null {
  const source = record(input);
  const value = source ? record(source.repository) : null;
  const osi = source ? record(source.openSource) : null;
  const signals: PackageRepoSignals = {
    stars: numberValue(value?.stars),
    pushedAt: dateValue(value?.pushedAt),
    checkedAt: dateValue(value?.signalsCheckedAt),
    archived:
      typeof value?.archived === 'boolean'
        ? value.archived
        : typeof osi?.archived === 'boolean'
          ? osi.archived
          : undefined,
    repoUrl: stringValue(value?.url)
  };
  const hasSignal =
    signals.stars !== undefined ||
    signals.pushedAt !== undefined ||
    signals.checkedAt !== undefined ||
    signals.archived !== undefined;
  return hasSignal || signals.repoUrl ? signals : null;
}

/** Locale compact units and half-expand rounding, including carry into the next unit. */
export function formatRepoStars(stars: number, locale: SiteLocale = 'en-US'): string {
  const value = Math.max(0, Math.round(stars));
  if (value < 1000) return new Intl.NumberFormat(locale).format(value);
  const options: Intl.NumberFormatOptions = {
    notation: 'compact',
    maximumFractionDigits: 1,
    roundingMode: 'halfExpand'
  };
  const parts = new Intl.NumberFormat(locale, options).formatToParts(value);
  const compact = parts.some(part => part.type === 'compact');
  const integer = Number(
    parts
      .filter(part => part.type === 'integer')
      .map(part => part.value)
      .join('')
  );
  if (compact && integer < 1000) return parts.map(part => part.value).join('');
  // Some short locale forms stop at millions (Spanish: 1000 M). The long form
  // supplies the localized next unit, e.g. "1 mil millones", without inventing a suffix.
  if (compact && integer >= 1000)
    return new Intl.NumberFormat(locale, { ...options, compactDisplay: 'long' }).format(value);
  // German short form keeps four-digit numbers grouped until one million, so 999,950
  // would read 999.950. Add the half-expand carry so it rolls over to 1 Mio.
  if (value >= 999_950) return new Intl.NumberFormat(locale, options).format(value + 50);
  return new Intl.NumberFormat(locale).format(value);
}

/** Whole elapsed days for a pushed-at timestamp, or null for an invalid/future date. */
export function repoAgeDays(pushedAt: string, now: number): number | null {
  const timestamp = Date.parse(pushedAt);
  if (!Number.isFinite(timestamp) || timestamp > now) return null;
  return Math.floor((now - timestamp) / 86_400_000);
}

/** Archived takes precedence over the unmaintained warning. */
export function repoMaintenanceStatus(
  signals: Pick<PackageRepoSignals, 'archived' | 'pushedAt'>,
  now: number
): 'archived' | 'unmaintained' | 'current' | null {
  if (signals.archived === true) return 'archived';
  if (!signals.pushedAt) return null;
  const days = repoAgeDays(signals.pushedAt, now);
  return days !== null && days > 365 ? 'unmaintained' : 'current';
}

export function repoSignalDays(signals: Pick<PackageRepoSignals, 'pushedAt'>, now: number): number | null {
  return signals.pushedAt ? repoAgeDays(signals.pushedAt, now) : null;
}

export interface PackageStarBadge {
  /** Raw star count, for the full-number accessible label. */
  stars: number;
  /** Compact count from formatRepoStars, e.g. 1.2K or 1M. */
  label: string;
  /** https://github.com/<owner>/<repo> */
  href: string;
}

function githubRepoUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return undefined;
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    return owner && repo ? `https://github.com/${owner}/${repo.replace(/\.git$/i, '')}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Header star chip (detail page tag row): only when the package has a GitHub repository and a star count.
 * The repository URL comes from `repository.url`, then `openSource.url`, then a link app's `link.github.repo`.
 */
export function toPackageStarBadge(input: unknown, locale: SiteLocale = 'en-US'): PackageStarBadge | null {
  const source = record(input);
  if (!source) return null;
  const stars = numberValue(record(source.repository)?.stars);
  if (stars === undefined) return null;
  const linkRepo = stringValue(record(record(source.link)?.github)?.repo);
  const href =
    githubRepoUrl(record(source.repository)?.url) ??
    githubRepoUrl(record(source.openSource)?.url) ??
    (linkRepo ? githubRepoUrl(`https://github.com/${linkRepo}`) : undefined);
  if (!href) return null;
  return { stars, label: formatRepoStars(stars, locale), href };
}
