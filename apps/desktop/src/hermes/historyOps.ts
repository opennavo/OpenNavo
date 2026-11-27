import type { HermesConversation } from '@/stores/hermes';

export interface HistoryDiff {
  /** Rows added or changed since the loaded baseline. */
  upserts: HermesConversation[];
  /** Ids present in the baseline but gone from this window's list. */
  deletes: string[];
  /** Serialized current rows, to become the next baseline after a successful save. */
  current: Map<string, string>;
}

/** Compute explicit operations against the snapshot this window last read/wrote. */
export function diffHistory(conversations: HermesConversation[], baseline: Map<string, string>): HistoryDiff {
  const current = new Map<string, string>();
  const upserts: HermesConversation[] = [];
  for (const conversation of conversations) {
    const serialized = JSON.stringify(conversation);
    current.set(conversation.id, serialized);
    if (baseline.get(conversation.id) !== serialized) upserts.push(conversation);
  }
  const deletes = [...baseline.keys()].filter(id => !current.has(id));
  return { upserts, deletes, current };
}
