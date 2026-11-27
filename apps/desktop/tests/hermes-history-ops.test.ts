import { describe, expect, it } from 'vitest';
import { diffHistory } from '@/hermes/historyOps';

const row = (id: string, updatedAt: number) => ({ id, messages: [], updatedAt }) as never;

describe('Hermes history operations', () => {
  it('derives only changed upserts and removed ids from the loaded baseline', () => {
    const baseline = new Map([
      ['shared', JSON.stringify(row('shared', 1))],
      ['deleted', JSON.stringify(row('deleted', 2))]
    ]);
    const { upserts, deletes } = diffHistory([row('shared', 1), row('added', 3)], baseline);
    expect(upserts.map(item => item.id)).toEqual(['added']);
    expect(deletes).toEqual(['deleted']);
  });

  it('a window writing its own row does not resend another window deleted row', () => {
    // B still has the old baseline (including `deleted`) but only changed its own row.
    const baseline = new Map([
      ['shared', JSON.stringify(row('shared', 1))],
      ['deleted', JSON.stringify(row('deleted', 2))]
    ]);
    const { upserts, deletes } = diffHistory([row('shared', 1), row('deleted', 2), row('b', 4)], baseline);
    expect(upserts.map(item => item.id)).toEqual(['b']);
    expect(deletes).toEqual([]);
  });
});
