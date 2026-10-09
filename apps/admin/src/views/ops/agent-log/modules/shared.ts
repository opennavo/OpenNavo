import type { Schemas } from '@/typings/api/opennavo';
import { $t } from '@/locales';

export type HistoryRef = Schemas['HistoryRef'];
export type ContentRef = Schemas['ContentRef'];

export const HISTORY_ENTITIES: Schemas['HistoryEntity'][] = [
  'package',
  'release',
  'category',
  'collection',
  'collection_item',
  'feature',
  'screenshot',
  'glossary',
  'synonym',
  'announcement',
  'desktop_release',
  'mirror',
  'feedback',
  'asset'
];

export function entityLabel(entity: string): string {
  const key = `page.ops.agentLog.entities.${entity}` as App.I18n.I18nKey;
  const text = $t(key);
  return text === key ? entity : text;
}

export const historyRefLabel = (ref: HistoryRef) => `${entityLabel(ref.entity)} · ${ref.objectKey}`;

export function contentRefLabel(ref: ContentRef): string {
  const ids = [ref.id, ref.secondaryId].filter(value => value !== undefined && value !== null).join('/');
  return ids ? `${entityLabel(ref.entity)} · ${ids}` : entityLabel(ref.entity);
}

export const entityOptions = () => HISTORY_ENTITIES.map(value => ({ value, label: entityLabel(value) }));

/** Date range → inclusive from / exclusive to; include the entire end date. */
export function rangeParams(range: [number, number] | null): { from?: string; to?: string } {
  if (!range) return {};
  const day = 86_400_000;
  return { from: new Date(range[0]).toISOString(), to: new Date(range[1] + day).toISOString() };
}

export const actorLabel = (actor: Schemas['HistoryActor']) =>
  `${$t(`page.ops.agentLog.actorTypes.${actor.type}`)} · ${actor.name}`;

export const pretty = (value: unknown) => JSON.stringify(value ?? null, null, 2);
