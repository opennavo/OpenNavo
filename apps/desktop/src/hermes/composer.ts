import type { HermesBusyMode } from '@/stores/hermes';

/**
 * What the composer's primary button does. Mirrors the official desktop's
 * `compose-busy-submit-state`: idle sends, a running turn redirects / steers / queues
 * according to `display.busy_input_mode`, and an empty composer stops that turn.
 */
export type ComposerBusyAction = 'send' | 'interrupt' | 'steer' | 'queue' | 'stop';

export interface ComposerSubmitInputs {
  attachmentCount: number;
  /** An approval, clarify, secret, sudo or vault card owns the turn: text queues behind it. */
  blockingPrompt: boolean;
  busy: boolean;
  /** Runtime `display.busy_input_mode`; null until this turn's session event arrives. */
  busyInputMode: HermesBusyMode | null;
  hasPayload: boolean;
}

export interface ComposerSubmitState {
  action: ComposerBusyAction;
  canSubmit: boolean;
}

/**
 * The Send button's gate plus the busy-turn routing. This client cannot carry attachments into
 * a correction (the gateway only takes text), so a file payload waits for the turn to end
 * instead of pretending to queue; everything else follows the runtime's policy.
 */
export function deriveComposerSubmitState({
  attachmentCount,
  blockingPrompt,
  busy,
  busyInputMode,
  hasPayload
}: ComposerSubmitInputs): ComposerSubmitState {
  if (!busy) return { action: 'send', canSubmit: hasPayload };
  if (!hasPayload) return { action: 'stop', canSubmit: true };
  if (attachmentCount > 0) return { action: 'queue', canSubmit: false };
  // A card owns the turn: a redirect or steer cannot reach the model until it is answered.
  if (blockingPrompt) return { action: 'queue', canSubmit: true };
  // The session event has not named this turn's policy yet. Submitting now would pin the default
  // and could turn an intended queue into an interrupt, so wait for the event like the official
  // desktop instead of guessing.
  if (busyInputMode === null) return { action: 'interrupt', canSubmit: false };
  return { action: busyInputMode, canSubmit: true };
}
