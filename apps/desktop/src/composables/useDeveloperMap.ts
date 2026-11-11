import type { PackageSummary } from '@opennavo/api';
import { api } from '@/api';

export interface DeveloperTop {
  name: string;
  apps: number;
  installs30d: number;
}

export interface DeveloperMapPlace {
  key: string;
  kind: 'city' | 'country';
  name: string;
  countryCode: string;
  region: 'americas' | 'europe' | 'apac' | 'other';
  lat: number;
  lng: number;
  developers: number;
  apps: number;
  installs30d: number;
  topDevelopers: DeveloperTop[];
}

export interface DeveloperMapCountry {
  code: string;
  developers: number;
  apps: number;
  installs30d: number;
}

export interface DeveloperMapRecent {
  name: string;
  cityKey?: string;
  city: string;
  countryCode: string;
  apps: number;
  updatedAt: string;
}

export interface DeveloperMapTotals {
  developers: number;
  located: number;
  apps: number;
  locatedApps: number;
  places: number;
  countries: number;
}

export interface DeveloperMapData {
  generatedAt: string;
  totals: DeveloperMapTotals;
  places: DeveloperMapPlace[];
  countries: DeveloperMapCountry[];
  recentDevelopers: DeveloperMapRecent[];
}

export interface DeveloperPickView {
  package: PackageSummary;
  quote: string;
  publishedAt: string;
}

export interface DeveloperFetchMetadata {
  source: string;
  name: string;
  summary: string;
  description: string;
  developer: string;
  homepage: string;
  repoUrl: string;
  downloadUrl: string;
  iconUrl: string;
  version: string;
  minMacos: string;
  category: string;
  license: string;
  warnings: string[];
}

export interface DeveloperSubmitResult {
  id: number;
  reference: string;
  token: string;
  statusUrl: string;
}

export interface DeveloperSubmissionEvent {
  status: string;
  note?: string | null;
  actor: 'developer' | 'admin' | 'system';
  createdAt: string;
}

export interface DeveloperSubmissionStatus {
  reference: string;
  kind: 'new' | 'claim' | 'location';
  status: 'submitted' | 'in_review' | 'changes_requested' | 'approved' | 'rejected' | 'published';
  createdAt: string;
  updatedAt: string;
  decidedAt?: string | null;
  decisionNote?: string | null;
  package?: { kind: string; token: string; name: string } | null;
  events: DeveloperSubmissionEvent[];
}

interface Envelope<T> {
  code: string;
  msg: string;
  data: T;
}

async function getDeveloper<T>(path: string, locale: string, query: Record<string, string | number> = {}): Promise<T> {
  const response = await (api as unknown as {
    GET: (path: string, options: { params: { query: Record<string, string | number> }; headers: Record<string, string> }) => Promise<{ data?: Envelope<T> }>;
  }).GET(path, {
    params: { query: { locale, ...query } },
    headers: { 'Accept-Language': locale }
  });
  const envelope = response.data;
  if (!envelope || envelope.code !== '0000') throw new Error(envelope?.msg || `developer API ${path} failed`);
  return envelope.data;
}

export function fetchDeveloperMap(locale: string): Promise<DeveloperMapData> {
  return getDeveloper<DeveloperMapData>('/developer-map', locale);
}

export function fetchDeveloperPicks(locale: string, limit = 3): Promise<DeveloperPickView[]> {
  return getDeveloper<DeveloperPickView[]>('/developer-picks', locale, { limit });
}

type PostClient = {
  POST: (path: string, options: { body: Record<string, unknown> }) => Promise<{ data?: Envelope<unknown> }>;
};

async function postDeveloper<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await (api as unknown as PostClient).POST(path, { body });
  const envelope = response.data as Envelope<T> | undefined;
  if (!envelope || envelope.code !== '0000') throw new Error(envelope?.msg || `developer API ${path} failed`);
  return envelope.data;
}

export function fetchDeveloperMetadata(url: string): Promise<DeveloperFetchMetadata> {
  return postDeveloper<DeveloperFetchMetadata>('/developer/fetch', { url });
}

export function submitDeveloperSubmission(body: Record<string, unknown>): Promise<DeveloperSubmitResult> {
  return postDeveloper<DeveloperSubmitResult>('/developer/submissions', body);
}

/** Anonymous receipt lookup; null means the token is unknown or mistyped. */
export async function fetchDeveloperSubmissionStatus(token: string): Promise<DeveloperSubmissionStatus | null> {
  const response = await (api as unknown as {
    GET: (path: string, options: { params: { path: { token: string } } }) => Promise<{ data?: Envelope<DeveloperSubmissionStatus>; response: Response }>;
  }).GET('/developer/submissions/{token}', { params: { path: { token } } });
  if (response.response.status === 404) return null;
  const envelope = response.data;
  if (!envelope || envelope.code !== '0000') throw new Error(envelope?.msg || 'developer status failed');
  return envelope.data;
}

const CITY_NAMES: Record<string, { zh: string; en: string }> = {
  'bay-area': { zh: '旧金山湾区', en: 'San Francisco Bay Area' },
  seattle: { zh: '西雅图', en: 'Seattle' },
  london: { zh: '伦敦', en: 'London' },
  beijing: { zh: '北京', en: 'Beijing' },
  tokyo: { zh: '东京', en: 'Tokyo' },
  sydney: { zh: '悉尼', en: 'Sydney' },
  prague: { zh: '布拉格', en: 'Prague' },
  kyiv: { zh: '基辅', en: 'Kyiv' },
  nyc: { zh: '纽约', en: 'New York City' },
  berlin: { zh: '柏林', en: 'Berlin' },
  toronto: { zh: '多伦多', en: 'Toronto' },
  paris: { zh: '巴黎', en: 'Paris' },
  amsterdam: { zh: '阿姆斯特丹', en: 'Amsterdam' },
  vienna: { zh: '维也纳', en: 'Vienna' },
  'the-hague': { zh: '海牙', en: 'The Hague' },
  nottingham: { zh: '诺丁汉', en: 'Nottingham' },
  seoul: { zh: '首尔', en: 'Seoul' },
  hangzhou: { zh: '杭州', en: 'Hangzhou' },
  shenzhen: { zh: '深圳', en: 'Shenzhen' },
  melbourne: { zh: '墨尔本', en: 'Melbourne' },
  chennai: { zh: '金奈', en: 'Chennai' },
  'tel-aviv': { zh: '特拉维夫', en: 'Tel Aviv' },
  milan: { zh: '米兰', en: 'Milan' },
  stockholm: { zh: '斯德哥尔摩', en: 'Stockholm' }
};

export function developerCityLabel(key: string | null | undefined, fallback: string, locale: string): string {
  const name = key ? CITY_NAMES[key] : undefined;
  if (!name) return fallback;
  return locale.toLowerCase().startsWith('zh') ? name.zh : name.en;
}

export function developerPlaceName(place: DeveloperMapPlace, locale: string): string {
  if (place.kind === 'country') return place.countryCode;
  return developerCityLabel(place.key, place.name, locale);
}
