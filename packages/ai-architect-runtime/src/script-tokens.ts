/**
 * Characters per token for Latin script, used to turn a prompt's length into an
 * input-token count.
 *
 * Deliberately pessimistic for English prose + JSON (real tokenizers average nearer
 * 3.7) because the number feeds a ceiling: over-counting delays a request, while
 * under-counting admits one that should have been refused.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 3.5;

/**
 * The script classes a prompt's code points are priced under.
 *
 * One ratio for every language was ADR-0311's named defect: a tokenizer works on UTF-8
 * bytes, so a CJK ideograph that `ESTIMATED_CHARS_PER_TOKEN` prices at 0.29 tokens really
 * costs one or more — and under-counting is the direction that *admits* a request a
 * ceiling should have refused.
 */
export const TOKEN_SCRIPT_CLASSES = ["latin", "other_script", "cjk", "astral"] as const;
export type TokenScriptClass = (typeof TOKEN_SCRIPT_CLASSES)[number];

/**
 * How many characters of each class one token is assumed to cover. Every figure is a
 * heuristic chosen on the ceiling's asymmetry, so each sits at or past the pessimistic
 * end of what modern BPE vocabularies (cl100k / o200k and the SentencePiece vocabularies
 * a self-hosted model ships with — ADR-0306) actually do:
 *
 * - `latin` — ASCII prose and JSON punctuation, the case the single constant was tuned for.
 * - `other_script` — a non-Latin *alphabet* (Cyrillic, Greek, Arabic, Hebrew, Devanagari,
 *   Thai …). Two to three UTF-8 bytes per character, and these scripts have far less
 *   dedicated vocabulary than Latin, so a character is commonly half a token.
 * - `cjk` — 0.75 means 1.33 tokens per character. A *common* ideograph is one token; a rare
 *   one falls back to its UTF-8 bytes and becomes two or three. The figure sits above the
 *   common case and below the worst, which is the direction the asymmetry asks for.
 * - `astral` — any code point outside the BMP: emoji, and the supplementary CJK extensions.
 *   Four UTF-8 bytes, usually one token when the vocabulary knows the character and up to
 *   four when it does not, so 0.5 means two tokens per code point. This is the class a naive
 *   `.length` gets most wrong: an emoji is two UTF-16 units, which the single constant priced
 *   at 0.57 tokens.
 */
export const CHARS_PER_TOKEN_BY_CLASS: Readonly<Record<TokenScriptClass, number>> = {
  latin: ESTIMATED_CHARS_PER_TOKEN,
  other_script: 2,
  cjk: 0.75,
  astral: 0.5,
};

type CodePointRange = readonly [number, number];

/**
 * Latin script, digits, punctuation and whitespace — the cheapest class, and therefore an
 * explicit allow-list rather than the default. An unrecognised code point must not be priced
 * as the cheapest thing it could be.
 */
const LATIN_RANGES: readonly CodePointRange[] = [
  [0x0000, 0x024f], // Basic Latin, Latin-1 Supplement, Latin Extended-A and -B
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2000, 0x206f], // General Punctuation
  [0x20a0, 0x20cf], // Currency Symbols
];

/** Ideographs, kana, hangul and the fullwidth forms that travel with them. */
const CJK_RANGES: readonly CodePointRange[] = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x2eff], // CJK Radicals Supplement
  [0x2f00, 0x2fdf], // Kangxi Radicals
  [0x3000, 0x303f], // CJK Symbols and Punctuation
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x3100, 0x312f], // Bopomofo
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
];

function inRanges(codePoint: number, ranges: readonly CodePointRange[]): boolean {
  for (const [lo, hi] of ranges) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

/**
 * Which class one code point is priced under. The order of the tests is the decision:
 * everything outside the BMP is `astral` first — including the supplementary CJK blocks,
 * because four UTF-8 bytes is dearer than the three a BMP ideograph costs — and anything
 * the tables do not name falls to `other_script` rather than to `latin`, since an
 * unrecognised script is far likelier to be a multi-byte alphabet than ASCII. It is not
 * defaulted to the *dearest* class either: pricing every unknown code point as an ideograph
 * would refuse legitimate requests, which the ceiling is not for.
 */
export function classifyCodePoint(codePoint: number): TokenScriptClass {
  if (codePoint > 0xffff) return "astral";
  if (inRanges(codePoint, LATIN_RANGES)) return "latin";
  if (inRanges(codePoint, CJK_RANGES)) return "cjk";
  return "other_script";
}

export interface ScriptTokenProfile {
  /** Code points, not UTF-16 units: an emoji counts once, not twice. */
  readonly codePoints: number;
  /** How many code points fell in each class. */
  readonly byClass: Readonly<Record<TokenScriptClass, number>>;
  readonly tokens: number;
}

function emptyCounts(): Record<TokenScriptClass, number> {
  return { latin: 0, other_script: 0, cjk: 0, astral: 0 };
}

/**
 * Counts a prompt's code points per class and prices them. Iteration is `for…of`, which
 * walks code points: `"🙂".length` is 2, and counting it as two Latin characters is exactly
 * the under-count this function exists to stop.
 */
export function scriptTokenProfile(parts: readonly string[]): ScriptTokenProfile {
  const byClass = emptyCounts();
  let codePoints = 0;
  for (const part of parts) {
    for (const ch of part) {
      const codePoint = ch.codePointAt(0);
      if (codePoint === undefined) continue;
      byClass[classifyCodePoint(codePoint)] += 1;
      codePoints += 1;
    }
  }
  let tokens = 0;
  for (const klass of TOKEN_SCRIPT_CLASSES) {
    tokens += byClass[klass] / CHARS_PER_TOKEN_BY_CLASS[klass];
  }
  return { codePoints, byClass, tokens: Math.ceil(tokens) };
}

/** The script-aware input-token estimate for a prompt. */
export function estimateTokensFromScript(parts: readonly string[]): number {
  return scriptTokenProfile(parts).tokens;
}
