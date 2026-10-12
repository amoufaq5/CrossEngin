import { describe, expect, it } from "vitest";

import {
  CHARS_PER_TOKEN_BY_CLASS,
  ESTIMATED_CHARS_PER_TOKEN,
  TOKEN_SCRIPT_CLASSES,
  classifyCodePoint,
  estimateTokensFromScript,
  scriptTokenProfile,
} from "./script-tokens.js";

const cp = (s: string): number => {
  const c = s.codePointAt(0);
  if (c === undefined) throw new Error("empty");
  return c;
};

/** What a naive `.length`-based estimate would have said, i.e. the pre-ADR-0311 figure. */
const naiveTokens = (text: string): number => Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);

describe("CHARS_PER_TOKEN_BY_CLASS", () => {
  it("has an entry for every class and every entry is positive", () => {
    for (const klass of TOKEN_SCRIPT_CLASSES) {
      expect(CHARS_PER_TOKEN_BY_CLASS[klass]).toBeGreaterThan(0);
    }
    expect(Object.keys(CHARS_PER_TOKEN_BY_CLASS).sort()).toEqual([...TOKEN_SCRIPT_CLASSES].sort());
  });

  it("prices every non-Latin class dearer than Latin, which is the whole correction", () => {
    expect(CHARS_PER_TOKEN_BY_CLASS.latin).toBe(ESTIMATED_CHARS_PER_TOKEN);
    expect(CHARS_PER_TOKEN_BY_CLASS.other_script).toBeLessThan(CHARS_PER_TOKEN_BY_CLASS.latin);
    expect(CHARS_PER_TOKEN_BY_CLASS.cjk).toBeLessThan(CHARS_PER_TOKEN_BY_CLASS.other_script);
    expect(CHARS_PER_TOKEN_BY_CLASS.astral).toBeLessThan(CHARS_PER_TOKEN_BY_CLASS.cjk);
  });

  it("assumes more than one token per CJK character", () => {
    expect(1 / CHARS_PER_TOKEN_BY_CLASS.cjk).toBeGreaterThan(1);
  });
});

describe("classifyCodePoint", () => {
  it("classifies ASCII, accented Latin and Latin Extended Additional as latin", () => {
    expect(classifyCodePoint(cp("A"))).toBe("latin");
    expect(classifyCodePoint(cp("{"))).toBe("latin");
    expect(classifyCodePoint(cp("é"))).toBe("latin");
    expect(classifyCodePoint(0x1e9e)).toBe("latin");
  });

  it("classifies general punctuation and currency symbols as latin", () => {
    expect(classifyCodePoint(0x2014)).toBe("latin");
    expect(classifyCodePoint(0x200d)).toBe("latin");
    expect(classifyCodePoint(cp("€"))).toBe("latin");
  });

  it("classifies ideographs, kana, hangul and fullwidth forms as cjk", () => {
    expect(classifyCodePoint(cp("世"))).toBe("cjk");
    expect(classifyCodePoint(cp("あ"))).toBe("cjk");
    expect(classifyCodePoint(cp("カ"))).toBe("cjk");
    expect(classifyCodePoint(cp("한"))).toBe("cjk");
    expect(classifyCodePoint(0xff21)).toBe("cjk");
    expect(classifyCodePoint(0x3001)).toBe("cjk");
  });

  it("classifies non-Latin alphabets as other_script", () => {
    expect(classifyCodePoint(cp("П"))).toBe("other_script");
    expect(classifyCodePoint(cp("α"))).toBe("other_script");
    expect(classifyCodePoint(cp("م"))).toBe("other_script");
    expect(classifyCodePoint(cp("ש"))).toBe("other_script");
    expect(classifyCodePoint(cp("क"))).toBe("other_script");
    expect(classifyCodePoint(cp("ก"))).toBe("other_script");
  });

  it("classifies everything outside the BMP as astral, including the CJK extensions", () => {
    expect(classifyCodePoint(0x1f600)).toBe("astral");
    expect(classifyCodePoint(0x20000)).toBe("astral");
  });

  it("defaults an unrecognised code point to other_script, never to the cheapest class", () => {
    // Ogham, which no table names. The default must be dearer than latin.
    expect(classifyCodePoint(0x1680)).toBe("other_script");
    expect(CHARS_PER_TOKEN_BY_CLASS.other_script).toBeLessThan(CHARS_PER_TOKEN_BY_CLASS.latin);
  });
});

describe("scriptTokenProfile", () => {
  it("counts nothing for no input", () => {
    const p = scriptTokenProfile([]);
    expect(p.codePoints).toBe(0);
    expect(p.tokens).toBe(0);
  });

  it("counts code points, so a per-class tally always sums to the total", () => {
    const p = scriptTokenProfile(["Order 注文 🙂"]);
    const summed = TOKEN_SCRIPT_CLASSES.reduce((n, k) => n + p.byClass[k], 0);
    expect(summed).toBe(p.codePoints);
  });

  it("prices Latin prose exactly as the single constant did", () => {
    const text = "a".repeat(3500);
    expect(scriptTokenProfile([text]).tokens).toBe(1000);
    expect(scriptTokenProfile([text]).tokens).toBe(naiveTokens(text));
  });

  it("prices CJK far above the single constant, which is the under-count being fixed", () => {
    const text = "你好世界";
    const p = scriptTokenProfile([text]);
    expect(p.byClass.cjk).toBe(4);
    expect(p.tokens).toBe(6);
    expect(p.tokens).toBeGreaterThan(naiveTokens(text));
  });

  it("counts an emoji as one code point and prices it above a naive .length", () => {
    const text = "🙂";
    expect(text.length).toBe(2);
    const p = scriptTokenProfile([text]);
    expect(p.codePoints).toBe(1);
    expect(p.byClass.astral).toBe(1);
    expect(p.tokens).toBe(2);
    expect(p.tokens).toBeGreaterThan(naiveTokens(text));
  });

  it("splits a ZWJ emoji sequence into its astral parts and its joiners", () => {
    const text = "👨‍👩‍👦";
    const p = scriptTokenProfile([text]);
    expect(p.codePoints).toBe(5);
    expect(p.byClass.astral).toBe(3);
    expect(p.byClass.latin).toBe(2);
    expect(p.tokens).toBe(7);
  });

  it("mixes Latin and CJK in one prompt, pricing each at its own ratio", () => {
    const p = scriptTokenProfile(["Order ", "注文"]);
    expect(p.byClass.latin).toBe(6);
    expect(p.byClass.cjk).toBe(2);
    expect(p.tokens).toBe(5);
  });

  it("prices a non-Latin alphabet between Latin and CJK", () => {
    expect(scriptTokenProfile(["Привет"]).tokens).toBe(3);
    expect(scriptTokenProfile(["مرحبا"]).tokens).toBe(3);
  });

  it("sums across parts rather than treating each separately", () => {
    const split = scriptTokenProfile(["你好", "世界"]);
    const whole = scriptTokenProfile(["你好世界"]);
    expect(split.tokens).toBe(whole.tokens);
  });

  it("rounds up, so a sub-token prompt still costs a token", () => {
    expect(scriptTokenProfile(["a"]).tokens).toBe(1);
  });
});

describe("estimateTokensFromScript", () => {
  it("is the profile's token count", () => {
    expect(estimateTokensFromScript(["你好世界"])).toBe(scriptTokenProfile(["你好世界"]).tokens);
  });

  it("never answers below the Latin-only reading for the same length", () => {
    for (const text of ["hello world", "你好", "🙂🙂", "Привет мир", "{\"a\":1}"]) {
      expect(estimateTokensFromScript([text])).toBeGreaterThanOrEqual(naiveTokens(text));
    }
  });
});
