import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import HermesClarifyDialog from '@/components/hermes/HermesClarifyDialog.vue';
import HermesSecretPrompt from '@/components/hermes/HermesSecretPrompt.vue';
import type { HermesClarifyRequest, HermesSecretRequest } from '@/stores/hermes';
import { i18n } from '@/i18n';

function renderClarify(request: HermesClarifyRequest | null) {
  return mount(HermesClarifyDialog, {
    props: { open: true, request },
    global: { plugins: [i18n], stubs: { teleport: true } }
  });
}

function renderSecret(request: HermesSecretRequest | null) {
  return mount(HermesSecretPrompt, {
    props: { open: true, request },
    global: { plugins: [i18n], stubs: { teleport: true } }
  });
}

describe('Hermes clarify card', () => {
  it('Answers a choice question with the clicked option', async () => {
    const wrapper = renderClarify({
      requestId: 'srq-clarify',
      questions: [{ qid: 'q1', question: 'Which database?', choices: ['postgres', 'sqlite'] }]
    });

    expect(wrapper.text()).toContain('Which database?');
    const postgres = wrapper.findAll('button').find(button => button.text() === 'postgres');
    await postgres!.trigger('click');
    const send = wrapper.findAll('button').find(button => button.text() === 'Send answer');
    await send!.trigger('click');

    expect(wrapper.emitted('submit')?.[0]).toEqual([[{ qid: 'q1', answer: 'postgres' }]]);
  });

  it('Collects every question and keeps skipped ones null', async () => {
    const wrapper = renderClarify({
      requestId: 'srq-clarify',
      questions: [
        { qid: 'q1', question: 'Which database?' },
        { qid: 'q2', question: 'Which region?' }
      ]
    });

    const inputs = wrapper.findAll('input');
    await inputs[0]!.setValue('postgres');
    const send = wrapper.findAll('button').find(button => button.text() === 'Send answer');
    await send!.trigger('click');

    expect(wrapper.emitted('submit')?.[0]).toEqual([
      [
        { qid: 'q1', answer: 'postgres' },
        { qid: 'q2', answer: null }
      ]
    ]);
  });

  it('Joins a multi-select answer and lets a pick be undone', async () => {
    const wrapper = renderClarify({
      requestId: 'srq-clarify',
      questions: [{ qid: 'q1', question: 'Which tools?', choices: ['brew', 'npm'], multi_select: true }]
    });

    const pick = async (label: string) => {
      const button = wrapper.findAll('button').find(item => item.text() === label);
      await button!.trigger('click');
    };
    await pick('brew');
    await pick('npm');
    await pick('brew');
    const send = wrapper.findAll('button').find(button => button.text() === 'Send answer');
    await send!.trigger('click');

    expect(wrapper.emitted('submit')?.[0]).toEqual([[{ qid: 'q1', answer: 'npm' }]]);
  });

  it('Reports a dismissal as a cancel, not as empty answers', async () => {
    const wrapper = renderClarify({
      requestId: 'srq-clarify',
      questions: [{ qid: 'q1', question: 'Which database?' }]
    });

    const cancel = wrapper.findAll('button').find(button => button.text() === 'Cancel');
    await cancel!.trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    expect(wrapper.emitted('submit')).toBeUndefined();
  });
});

describe('Hermes secret prompt', () => {
  it('Names the value the runtime asked for', () => {
    const wrapper = renderSecret({ requestId: 'srq-secret', label: 'OPENAI_API_KEY' });
    expect(wrapper.text()).toContain('OPENAI_API_KEY');
    // The input is masked: a value typed here must not sit in the DOM in clear text.
    expect(wrapper.find('input').attributes('type')).toBe('password');
  });

  it('Submits the typed value and skips with an empty string', async () => {
    const wrapper = renderSecret({ requestId: 'srq-secret', label: 'SUDO' });
    await wrapper.find('input').setValue('hunter2');

    const next = wrapper.findAll('button').find(button => button.text() === 'Continue');
    await next!.trigger('click');
    expect(wrapper.emitted('submit')?.[0]).toEqual(['hunter2']);

    const skip = wrapper.findAll('button').find(button => button.text() === 'Skip');
    await skip!.trigger('click');
    expect(wrapper.emitted('skip')).toHaveLength(1);
  });

  it('Does not carry a value into the next prompt', async () => {
    const wrapper = renderSecret({ requestId: 'srq-one', label: 'TOKEN' });
    await wrapper.find('input').setValue('first-secret');
    await wrapper.setProps({ request: { requestId: 'srq-two', label: 'TOKEN' } });
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
  });
});
