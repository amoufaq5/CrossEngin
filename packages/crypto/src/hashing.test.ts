import { describe, expect, it } from "vitest";

import {
  blake2b512Hex,
  constantTimeEqualHex,
  ensureCryptoReady,
  hashChainStep,
  hashWith,
  parseContentAddress,
  sha256,
  sha256ContentAddress,
} from "./hashing.js";

describe("sha256", () => {
  it("produces 64-character lowercase hex", () => {
    const out = sha256("anything");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a known fixture for the empty string", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches a known fixture for 'abc'", () => {
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic across calls", () => {
    expect(sha256("repeat me")).toBe(sha256("repeat me"));
  });

  it("treats Uint8Array and equivalent UTF-8 string identically", () => {
    const utf8 = "hello";
    const bytes = new TextEncoder().encode(utf8);
    expect(sha256(utf8)).toBe(sha256(bytes));
  });
});

describe("blake2b512Hex", () => {
  it("produces 128-char hex (512-bit output)", () => {
    const out = blake2b512Hex("anything");
    expect(out).toMatch(/^[0-9a-f]{128}$/);
  });

  it("matches a known fixture for 'abc'", () => {
    expect(blake2b512Hex("abc")).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  it("is deterministic for identical inputs", () => {
    expect(blake2b512Hex("hello")).toBe(blake2b512Hex("hello"));
  });

  it("produces different output for different inputs", () => {
    expect(blake2b512Hex("a")).not.toBe(blake2b512Hex("b"));
  });
});

describe("hashWith", () => {
  it("dispatches sha256", () => {
    expect(hashWith("sha256", "abc")).toBe(sha256("abc"));
  });

  it("dispatches blake2b-512", () => {
    expect(hashWith("blake2b-512", "abc")).toBe(blake2b512Hex("abc"));
  });
});

describe("hashChainStep", () => {
  it("chains H(prev || payload) with sha256", () => {
    const prev = sha256("step0");
    const payload = sha256("payload");
    const result = hashChainStep(prev, payload, "sha256");
    expect(result).toBe(sha256(prev + payload));
  });

  it("chains H(prev || payload) with blake2b-512", () => {
    const prev = blake2b512Hex("step0");
    const payload = blake2b512Hex("payload");
    const result = hashChainStep(prev, payload, "blake2b-512");
    expect(result).toBe(blake2b512Hex(prev + payload));
  });

  it("rejects non-hex previous hash", () => {
    expect(() => hashChainStep("XYZ", "a".repeat(64), "sha256")).toThrow(
      /previousHashHex/,
    );
  });

  it("rejects non-hex payload hash", () => {
    expect(() => hashChainStep("a".repeat(64), "XYZ", "sha256")).toThrow(
      /payloadHashHex/,
    );
  });

  it("rejects unsupported algorithm", () => {
    expect(() =>
      hashChainStep("a".repeat(64), "a".repeat(64), "md5" as never),
    ).toThrow(/unsupported/);
  });
});

describe("sha256ContentAddress", () => {
  it("prefixes the hash with sha256:", () => {
    const addr = sha256ContentAddress("hello");
    expect(addr).toBe(`sha256:${sha256("hello")}`);
  });
});

describe("parseContentAddress", () => {
  it("parses a valid address", () => {
    const addr = sha256ContentAddress("hello");
    const parsed = parseContentAddress(addr);
    expect(parsed?.algorithm).toBe("sha256");
    expect(parsed?.hex).toBe(sha256("hello"));
  });

  it("returns null for missing prefix", () => {
    expect(parseContentAddress("a".repeat(64))).toBeNull();
  });

  it("returns null for unsupported algorithm", () => {
    expect(parseContentAddress("md5:abc")).toBeNull();
  });

  it("returns null for non-hex hash portion", () => {
    expect(parseContentAddress("sha256:XYZ")).toBeNull();
  });
});

describe("constantTimeEqualHex", () => {
  it("returns true for matching hex", () => {
    expect(constantTimeEqualHex("abcd", "abcd")).toBe(true);
  });

  it("returns false for mismatched hex of same length", () => {
    expect(constantTimeEqualHex("abcd", "abce")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeEqualHex("abcd", "abcdef")).toBe(false);
  });

  it("returns false for non-hex inputs", () => {
    expect(constantTimeEqualHex("zz", "zz")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(constantTimeEqualHex("", "")).toBe(true);
  });
});

describe("ensureCryptoReady", () => {
  it("is idempotent and resolves", async () => {
    await ensureCryptoReady();
    await ensureCryptoReady();
    expect(true).toBe(true);
  });
});
