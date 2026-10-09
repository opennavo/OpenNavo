import { describe, expect, it } from 'vitest';
import { parseBrewfile, toBrewfile } from '../src/brewfile';

describe('toBrewfile', () => {
  it('Match API example: title comment and ordered entries', () => {
    const text = toBrewfile(
      [
        { kind: 'cask', token: 'ghostty' },
        { kind: 'cask', token: 'raycast' },
        { kind: 'formula', token: 'uv' }
      ],
      { title: 'OpenNavo 合集：新 Mac 必装 12 款' }
    );
    expect(text).toBe('# OpenNavo 合集：新 Mac 必装 12 款\ncask "ghostty"\ncask "raycast"\nbrew "uv"\n');
  });

  it('Skip invalid/duplicate tokens and flatten title newlines', () => {
    const text = toBrewfile(
      [
        { kind: 'formula', token: 'wget' },
        { kind: 'formula', token: 'x"; system("rm' },
        { kind: 'formula', token: 'wget' },
        { kind: 'cask', token: 'wget' }
      ],
      { title: '第一行\n# 注入' }
    );
    expect(text).toBe('# 第一行 # 注入\nbrew "wget"\ncask "wget"\n');
  });

  it('Empty lists contain only a newline', () => {
    expect(toBrewfile([])).toBe('\n');
  });
});

describe('parseBrewfile', () => {
  it('Recognize brew/cask, ignoring comments, blank lines, official taps', () => {
    const result = parseBrewfile(
      [
        '# 我的 Mac',
        'tap "homebrew/bundle"',
        '',
        "brew 'git'",
        'brew "mysql", restart_service: true # 数据库',
        'cask "visual-studio-code"',
        'cask "homebrew/cask/firefox"',
        'brew "homebrew/core/wget"',
        'cask "ghostty" # 带 "引号" 的注释'
      ].join('\r\n')
    );
    expect(result.unsupported).toEqual([]);
    expect(result.entries).toEqual([
      { kind: 'formula', token: 'git', line: 4, hasOptions: false },
      { kind: 'formula', token: 'mysql', line: 5, hasOptions: true },
      { kind: 'cask', token: 'visual-studio-code', line: 6, hasOptions: false },
      { kind: 'cask', token: 'firefox', line: 7, hasOptions: false },
      { kind: 'formula', token: 'wget', line: 8, hasOptions: false },
      { kind: 'cask', token: 'ghostty', line: 9, hasOptions: false }
    ]);
  });

  it('Explain unsupported lines and keep only first duplicates', () => {
    const result = parseBrewfile(
      [
        'tap "user/tools"',
        'brew "user/tools/thing"',
        'brew "homebrew/core/extra/wget"',
        'mas "Xcode", id: 497799835',
        'vscode "golang.go"',
        'whalebrew "whalebrew/wget"',
        'brew "Bad Token"',
        'if OS.mac?',
        'brew "git"',
        'brew "git"',
        'brew "a#b"'
      ].join('\n')
    );
    expect(result.entries).toEqual([{ kind: 'formula', token: 'git', line: 9, hasOptions: false }]);
    expect(result.unsupported).toEqual([
      { line: 1, text: 'tap "user/tools"', reason: 'third-party' },
      { line: 2, text: 'brew "user/tools/thing"', reason: 'third-party' },
      { line: 3, text: 'brew "homebrew/core/extra/wget"', reason: 'third-party' },
      { line: 4, text: 'mas "Xcode", id: 497799835', reason: 'other-manager' },
      { line: 5, text: 'vscode "golang.go"', reason: 'other-manager' },
      { line: 6, text: 'whalebrew "whalebrew/wget"', reason: 'other-manager' },
      { line: 7, text: 'brew "Bad Token"', reason: 'invalid-token' },
      { line: 8, text: 'if OS.mac?', reason: 'unrecognized' },
      { line: 11, text: 'brew "a#b"', reason: 'invalid-token' }
    ]);
  });

  it('Round-trips the generated Brewfile', () => {
    const items = [
      { kind: 'cask' as const, token: 'ghostty' },
      { kind: 'formula' as const, token: 'python@3.12' }
    ];
    const parsed = parseBrewfile(toBrewfile(items, { title: '往返' }));
    expect(parsed.unsupported).toEqual([]);
    expect(parsed.entries.map(({ kind, token }) => ({ kind, token }))).toEqual(items);
  });
});
