import { describe, expect, it } from 'vitest';
import { deriveComposerSubmitState } from '@/hermes/composer';

const base = {
  attachmentCount: 0,
  blockingPrompt: false,
  busy: false,
  busyInputMode: null,
  hasPayload: false
} as const;

describe('Hermes composer submit state', () => {
  it('Sends an idle payload and disables an empty composer', () => {
    expect(deriveComposerSubmitState({ ...base, hasPayload: true })).toEqual({ action: 'send', canSubmit: true });
    expect(deriveComposerSubmitState(base)).toEqual({ action: 'send', canSubmit: false });
  });

  it('Turns the primary button into Stop when a running turn has an empty composer', () => {
    expect(deriveComposerSubmitState({ ...base, busy: true })).toEqual({ action: 'stop', canSubmit: true });
  });

  it('Waits for the session event before routing text mid-turn', () => {
    expect(deriveComposerSubmitState({ ...base, busy: true, hasPayload: true })).toEqual({
      action: 'interrupt',
      canSubmit: false
    });
  });

  it('Follows the runtime busy policy for mid-turn text', () => {
    expect(deriveComposerSubmitState({ ...base, busy: true, hasPayload: true, busyInputMode: 'interrupt' })).toEqual({
      action: 'interrupt',
      canSubmit: true
    });
    expect(deriveComposerSubmitState({ ...base, busy: true, hasPayload: true, busyInputMode: 'steer' })).toEqual({
      action: 'steer',
      canSubmit: true
    });
    expect(deriveComposerSubmitState({ ...base, busy: true, hasPayload: true, busyInputMode: 'queue' })).toEqual({
      action: 'queue',
      canSubmit: true
    });
  });

  it('Queues text behind a card that owns the turn', () => {
    expect(
      deriveComposerSubmitState({
        ...base,
        busy: true,
        hasPayload: true,
        blockingPrompt: true,
        busyInputMode: 'steer'
      })
    ).toEqual({ action: 'queue', canSubmit: true });
  });

  it('Holds attachments until the turn ends instead of pretending to correct with them', () => {
    expect(
      deriveComposerSubmitState({
        ...base,
        busy: true,
        hasPayload: true,
        attachmentCount: 1,
        busyInputMode: 'interrupt'
      })
    ).toEqual({ action: 'queue', canSubmit: false });
    expect(deriveComposerSubmitState({ ...base, hasPayload: true, attachmentCount: 1 })).toEqual({
      action: 'send',
      canSubmit: true
    });
  });
});
