// Homebrew version comparison (03 §11), sharing apps/server/testdata/version_cases.json with Go/Rust for parity.
//
// Rules:
// - Compare numeric core before the first letter segment; missing segments are zero, numbers arbitrary precision.
// - Then suffixes: alpha/a < beta/b < pre/preview < rc < release < p/post < other letters lexically.
// - Suffix numbers sort above letters; missing positions mean release, missing numbers mean zero.
// - Comma build numbers participate like dot/underscore/hyphen separators; ignore leading v, surrounding whitespace, and case.
// - HEAD exceeds fixed versions and equals HEAD; empty/latest are incomparable (null), never implying updates.

type Token = { type: 'number'; value: bigint } | { type: 'word'; rank: number; value: string };

const RANK = { alpha: 0, beta: 1, pre: 2, rc: 3, release: 4, post: 5, other: 6 } as const;

// A lone a/b may be a patch letter (openssl 1.1.1a); only a following digit makes it alpha/beta.
function wordRank(word: string, followedByDigit: boolean): number {
  if (word === 'alpha' || (word === 'a' && followedByDigit)) return RANK.alpha;
  if (word === 'beta' || (word === 'b' && followedByDigit)) return RANK.beta;
  if (word === 'pre' || word === 'preview') return RANK.pre;
  if (word === 'rc') return RANK.rc;
  if (word === 'p' || word === 'post' || word === 'patch') return RANK.post;
  return RANK.other;
}

function tokenize(version: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /(\d+)|([a-z]+)/g;
  for (const match of version.matchAll(pattern)) {
    const [text, digits] = match;
    if (digits !== undefined) {
      tokens.push({ type: 'number', value: BigInt(digits) });
    } else {
      const next = version.charAt(match.index + text.length);
      tokens.push({ type: 'word', rank: wordRank(text, /\d/.test(next)), value: text });
    }
  }
  return tokens;
}

type Parsed = { kind: 'head' } | { kind: 'fixed'; core: bigint[]; suffix: Token[] };

function parse(input: string): Parsed | null {
  const text = input.trim().toLowerCase();
  if (text === '' || text === 'latest') return null;
  if (/^head(?:$|[-_.@])/.test(text)) return { kind: 'head' };

  const tokens = tokenize(text.replace(/^v(?=\d)/, ''));
  // Numeric core precedes the first letter segment.
  const core: bigint[] = [];
  for (const token of tokens) {
    if (token.type === 'word') break;
    core.push(token.value);
  }
  return { kind: 'fixed', core, suffix: tokens.slice(core.length) };
}

function sign(value: number | bigint): -1 | 0 | 1 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function compareCore(left: bigint[], right: bigint[]): -1 | 0 | 1 {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const result = sign((left[index] ?? 0n) - (right[index] ?? 0n));
    if (result !== 0) return result;
  }
  return 0;
}

// Missing suffix position means zero against numbers, release against letters.
function compareWithMissing(token: Token): -1 | 0 | 1 {
  return token.type === 'number' ? sign(token.value) : sign(token.rank - RANK.release);
}

function compareSuffixToken(left: Token, right: Token): -1 | 0 | 1 {
  if (left.type === 'number' && right.type === 'number') return sign(left.value - right.value);
  if (left.type === 'number') return 1;
  if (right.type === 'number') return -1;
  if (left.rank !== right.rank) return sign(left.rank - right.rank);
  if (left.rank === RANK.other) return sign(left.value.localeCompare(right.value, 'en'));
  return 0;
}

/**
 * Compare two Homebrew versions.
 *
 * @returns -1 if left is older, 0 equal, 1 newer; null if either is empty/latest and thus incomparable.
 */
export function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return null;
  if (a.kind === 'head' || b.kind === 'head') {
    if (a.kind === b.kind) return 0;
    return a.kind === 'head' ? 1 : -1;
  }

  const core = compareCore(a.core, b.core);
  if (core !== 0) return core;

  const length = Math.max(a.suffix.length, b.suffix.length);
  for (let index = 0; index < length; index += 1) {
    const leftToken = a.suffix[index];
    const rightToken = b.suffix[index];
    // At least one side exists within the loop range.
    let result: number;
    if (leftToken === undefined) result = -compareWithMissing(rightToken as Token);
    else if (rightToken === undefined) result = compareWithMissing(leftToken);
    else result = compareSuffixToken(leftToken, rightToken);
    if (result !== 0) return sign(result);
  }
  return 0;
}

/** Whether installed is behind latest; incomparable versions return false and must not trigger update notices. */
export function isOutdated(installed: string, latest: string): boolean {
  return compareVersions(installed, latest) === -1;
}
