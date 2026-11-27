/** Card ids are unique per turn, not globally: two connections may reuse both ids. */
export function askKey(ask: { turnRequestId?: string; requestId: string }): string {
  return `${ask.turnRequestId ?? ''}::${ask.requestId}`;
}

/** Whether a card belongs on the transcript currently shown. */
export function askVisibleTo(
  ask: { conversationId?: string; ownerKey?: string },
  conversationId: string | null,
  ownerKey: string
): boolean {
  return (!ask.conversationId || ask.conversationId === conversationId) && (!ask.ownerKey || ask.ownerKey === ownerKey);
}
