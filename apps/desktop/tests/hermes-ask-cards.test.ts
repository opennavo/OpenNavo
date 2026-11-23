import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import HermesClarifyDialog from '@/components/hermes/HermesClarifyDialog.vue';
import HermesValuePrompt from '@/components/hermes/HermesValuePrompt.vue';
import HermesVaultSaveLoginPrompt from '@/components/hermes/HermesVaultSaveLoginPrompt.vue';
import type { HermesClarifyRequest } from '@/stores/hermes';
import { i18n } from '@/i18n';

const global = { plugins: [i18n], stubs: { teleport: true } };

function renderClarify(request: HermesClarifyRequest | null) {
  return mount(HermesClarifyDialog, { props: { open: true, request }, global });
}

interface ValuePromptProps {
  requestKey?: string;
  title?: string;
  description?: string;
  label?: string;
  context?: string;
  contextLabel?: string;
  masked?: boolean;
  inputMode?: 'text' | 'numeric';
  autocomplete?: string;
  placeholder?: string;
  submitLabel?: string;
  skipLabel?: string;
  sanitize?: 'code';
}

function renderValue(props: ValuePromptProps = {}) {
  return mount(HermesValuePrompt, {
    props: {
      open: true,
      requestKey: 'srq-one',
      title: 'Hermes needs a value',
      submitLabel: 'Continue',
      skipLabel: 'Skip',
      ...props
    },
    global
  });
}

function footerButton(wrapper: ReturnType<typeof renderValue>, label: string) {
  return wrapper.findAll('button').find(button => button.text() === label);
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

describe('Hermes value prompt', () => {
  it('Shows the redacted command a sudo prompt belongs to', () => {
    const wrapper = renderValue({
      title: 'Hermes needs your admin password',
      context: 'sudo brew install ripgrep',
      contextLabel: 'Command'
    });

    expect(wrapper.text()).toContain('Hermes needs your admin password');
    expect(wrapper.text()).toContain('sudo brew install ripgrep');
    // The password is masked: a value typed here must not sit in the DOM in clear text.
    expect(wrapper.find('input').attributes('type')).toBe('password');
  });

  it('Names the environment variable the runtime asked for', () => {
    const wrapper = renderValue({ label: 'OPENAI_API_KEY', masked: true });
    expect(wrapper.text()).toContain('OPENAI_API_KEY');
    expect(wrapper.find('input').attributes('type')).toBe('password');
  });

  it('Submits the typed value and skips with an empty string', async () => {
    const wrapper = renderValue();
    await wrapper.find('input').setValue('hunter2');

    await footerButton(wrapper, 'Continue')!.trigger('click');
    expect(wrapper.emitted('submit')?.[0]).toEqual(['hunter2']);

    await footerButton(wrapper, 'Skip')!.trigger('click');
    expect(wrapper.emitted('skip')).toHaveLength(1);
  });

  it('Does not carry a value into the next prompt', async () => {
    const wrapper = renderValue({ requestKey: 'srq-one' });
    await wrapper.find('input').setValue('first-secret');
    await wrapper.setProps({ requestKey: 'srq-two' });
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
  });

  it('Shows a one-time code in clear text and strips its spaces and hyphens', async () => {
    const wrapper = renderValue({
      inputMode: 'numeric',
      autocomplete: 'one-time-code',
      sanitize: 'code',
      masked: false
    });
    const input = wrapper.find('input');
    expect(input.attributes('type')).toBe('text');
    expect(input.attributes('inputmode')).toBe('numeric');
    expect(input.attributes('autocomplete')).toBe('one-time-code');

    await input.setValue('123 456');
    await footerButton(wrapper, 'Continue')!.trigger('click');
    expect(wrapper.emitted('submit')?.[0]).toEqual(['123456']);
  });

  it('Keeps the password manager locked when the user skips', async () => {
    const wrapper = renderValue({ skipLabel: 'Keep locked' });
    await footerButton(wrapper, 'Keep locked')!.trigger('click');
    expect(wrapper.emitted('skip')).toHaveLength(1);
    expect(wrapper.emitted('submit')).toBeUndefined();
  });
});

describe('Hermes vault save-login prompt', () => {
  function renderSaveLogin(requestKey = 'srq-save') {
    return mount(HermesVaultSaveLoginPrompt, {
      props: {
        open: true,
        requestKey,
        title: 'Save the login for example.com?',
        description: 'Hermes can save this login to your vault and fill it on https://example.com.',
        identifierLabel: 'Username or email',
        passwordLabel: 'Password',
        submitLabel: 'Save login',
        declineLabel: 'Don’t save'
      },
      global
    });
  }

  it('Requires both fields before it can save', async () => {
    const wrapper = renderSaveLogin();
    const [identifier, password] = wrapper.findAll('input');
    const save = wrapper.findAll('button').find(button => button.text() === 'Save login')!;

    expect(save.attributes('disabled')).toBeDefined();
    await identifier!.setValue('user@example.com');
    expect(save.attributes('disabled')).toBeDefined();
    await password!.setValue('hunter2');
    expect(save.attributes('disabled')).toBeUndefined();
  });

  it('Saves the identifier and password as typed', async () => {
    const wrapper = renderSaveLogin();
    const [identifier, password] = wrapper.findAll('input');
    await identifier!.setValue('user@example.com');
    await password!.setValue('hunter2');

    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Save login')!
      .trigger('click');
    expect(wrapper.emitted('save')?.[0]).toEqual(['user@example.com', 'hunter2']);
  });

  it('Declines without saving and clears the fields for the next prompt', async () => {
    const wrapper = renderSaveLogin();
    const [identifier, password] = wrapper.findAll('input');
    await identifier!.setValue('user@example.com');
    await password!.setValue('hunter2');

    await wrapper.setProps({ requestKey: 'srq-next' });
    expect((identifier!.element as HTMLInputElement).value).toBe('');
    expect((password!.element as HTMLInputElement).value).toBe('');

    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Don’t save')!
      .trigger('click');
    expect(wrapper.emitted('decline')).toHaveLength(1);
  });
});
