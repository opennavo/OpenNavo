import type { TokenVariable } from '@opennavo/tokens';

export interface OnSegmentedOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  /** Leading option dot color as a token variable name, e.g. chart-series1. */
  dots?: readonly TokenVariable[];
}

export interface OnTabItem<T extends string> {
  value: T;
  label: string;
  count?: number;
  disabled?: boolean;
  /** Web: tabs have separate SEO URLs; render link navigation when href is provided. */
  href?: string;
  /** Associated panel ID for same-page desktop tabs (aria-controls). */
  controls?: string;
}
