import { describe, expect, it } from 'vitest';
import { askKey, askVisibleTo } from '@/hermes/askKey';

describe('Hermes ask identity', () => {
  it('scopes a card by its turn as well as its request id', () => {
    expect(askKey({ turnRequestId: 'turn-a', requestId: 'srq-1' })).not.toBe(
      askKey({ turnRequestId: 'turn-b', requestId: 'srq-1' })
    );
    expect(askKey({ turnRequestId: 'turn-a', requestId: 'srq-1' })).not.toBe(
      askKey({ turnRequestId: 'turn-a', requestId: 'srq-2' })
    );
  });

  it('does not show a same-conversation card owned by another connection', () => {
    expect(askVisibleTo({ conversationId: 'c-1', ownerKey: 'panel-a::default' }, 'c-1', 'panel-a::default')).toBe(true);
    expect(askVisibleTo({ conversationId: 'c-1', ownerKey: 'panel-a::default' }, 'c-1', 'panel-b::default')).toBe(
      false
    );
    // Legacy cards without an owner keep the previous conversation-only rule.
    expect(askVisibleTo({ conversationId: 'c-1' }, 'c-1', 'panel-b::default')).toBe(true);
  });
});
