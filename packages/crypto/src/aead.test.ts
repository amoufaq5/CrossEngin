import { describe, expect, it } from "vitest";

import {
  AEAD_ALGORITHM,
  AEAD_KEY_BYTES,
  AEAD_MIN_SEALED_BYTES,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  aeadOpen,
  aeadSeal,
} from "./aead.js";

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const PLAINTEXT = new TextEncoder().encode('{"k":["2026-01-01",12],"id":"abc"}');
const AAD = new TextEncoder().encode("tenant:11111111|op:invoice.list");
const OTHER_AAD = new TextEncoder().encode("tenant:22222222|op:invoice.list");
const EMPTY = new Uint8Array(0);

function flipBit(bytes: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const byte = copy.at(index);
  if (byte === undefined) throw new Error(`index ${index.toString()} out of range`);
  copy.set([byte ^ 0x01], index);
  return copy;
}

describe("aead constants", () => {
  it("pins the algorithm and the three widths that make up the wire format", () => {
    expect(AEAD_ALGORITHM).toBe("aes-256-gcm");
    expect(AEAD_KEY_BYTES).toBe(32);
    expect(AEAD_NONCE_BYTES).toBe(12);
    expect(AEAD_TAG_BYTES).toBe(16);
  });

  it("derives the minimum sealed length from the two fixed-width components", () => {
    expect(AEAD_MIN_SEALED_BYTES).toBe(AEAD_NONCE_BYTES + AEAD_TAG_BYTES);
  });
});

describe("aeadSeal / aeadOpen round trip", () => {
  it("returns the plaintext under the same key and aad", () => {
    const opened = aeadOpen(KEY, aeadSeal(KEY, PLAINTEXT, AAD), AAD);
    expect(opened).not.toBeNull();
    expect(Buffer.from(opened ?? EMPTY)).toEqual(Buffer.from(PLAINTEXT));
  });

  it("round-trips an empty plaintext", () => {
    const sealed = aeadSeal(KEY, EMPTY, AAD);
    expect(sealed.length).toBe(AEAD_MIN_SEALED_BYTES);
    expect(aeadOpen(KEY, sealed, AAD)?.length).toBe(0);
  });

  it("round-trips an empty aad, which is how an unbound seal is spelled", () => {
    // Empty is expressible but has to be passed, so it is visible at the call site.
    const opened = aeadOpen(KEY, aeadSeal(KEY, PLAINTEXT, EMPTY), EMPTY);
    expect(Buffer.from(opened ?? EMPTY)).toEqual(Buffer.from(PLAINTEXT));
  });

  it("round-trips a plaintext longer than one AES block", () => {
    const long = new Uint8Array(1_000).fill(0x41);
    expect(Buffer.from(aeadOpen(KEY, aeadSeal(KEY, long, AAD), AAD) ?? EMPTY)).toEqual(
      Buffer.from(long),
    );
  });

  it("does not leave the plaintext in the sealed bytes", () => {
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    expect(Buffer.from(sealed).includes(Buffer.from(PLAINTEXT))).toBe(false);
  });
});

describe("the wire format", () => {
  it("is nonce || ciphertext || tag, with GCM's ciphertext the length of the plaintext", () => {
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    expect(sealed.length).toBe(
      AEAD_NONCE_BYTES + PLAINTEXT.length + AEAD_TAG_BYTES,
    );
  });

  it("uses a fresh nonce per seal", () => {
    // The nonce-freshness pin. GCM nonce reuse under one key discloses the XOR of two
    // plaintexts and leaks the authenticator subkey, so a counter — which this module
    // has nowhere to persist and would restart at zero every process — is not an
    // option. Compare the nonce prefix specifically: two seals differing only later
    // would pass a whole-buffer comparison.
    const a = aeadSeal(KEY, PLAINTEXT, AAD).subarray(0, AEAD_NONCE_BYTES);
    const b = aeadSeal(KEY, PLAINTEXT, AAD).subarray(0, AEAD_NONCE_BYTES);
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
  });

  it("is not deterministic, so sealed bytes are never an equality key", () => {
    const a = aeadSeal(KEY, PLAINTEXT, AAD);
    const b = aeadSeal(KEY, PLAINTEXT, AAD);
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
    // Both still open to the same plaintext.
    expect(Buffer.from(aeadOpen(KEY, a, AAD) ?? EMPTY)).toEqual(
      Buffer.from(aeadOpen(KEY, b, AAD) ?? EMPTY),
    );
  });
});

describe("aeadOpen answers null rather than throwing", () => {
  it("for a wrong key", () => {
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    expect(aeadOpen(OTHER_KEY, sealed, AAD)).toBeNull();
  });

  it("for a wrong aad, which is what binds a seal to its context", () => {
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    expect(aeadOpen(KEY, sealed, OTHER_AAD)).toBeNull();
    expect(aeadOpen(KEY, sealed, EMPTY)).toBeNull();
  });

  it("for a flipped bit in the nonce", () => {
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    expect(aeadOpen(KEY, flipBit(sealed, 0), AAD)).toBeNull();
  });

  it("for a flipped bit in the ciphertext", () => {
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    expect(aeadOpen(KEY, flipBit(sealed, AEAD_NONCE_BYTES), AAD)).toBeNull();
  });

  it("for a flipped bit in the tag", () => {
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    expect(aeadOpen(KEY, flipBit(sealed, sealed.length - 1), AAD)).toBeNull();
  });

  it("for a buffer too short to carry a nonce and a tag", () => {
    // Settled before `createDecipheriv` sees a truncated nonce, so the answer is the
    // same `null` a tampered value gets rather than a throw from inside node:crypto.
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    for (const length of [0, 1, AEAD_NONCE_BYTES, AEAD_MIN_SEALED_BYTES - 1]) {
      expect(aeadOpen(KEY, sealed.subarray(0, length), AAD)).toBeNull();
    }
  });

  it("for a truncated ciphertext of otherwise valid length", () => {
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    expect(aeadOpen(KEY, sealed.subarray(0, sealed.length - 4), AAD)).toBeNull();
  });

  it("for random bytes of exactly the minimum length", () => {
    expect(aeadOpen(KEY, new Uint8Array(AEAD_MIN_SEALED_BYTES).fill(3), AAD)).toBeNull();
  });

  it("without throwing for any of them", () => {
    // Stated as its own property: the first consumer's input is a string a client
    // sends, so a throw here would turn every stale or edited value into a 500.
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    expect(() => aeadOpen(OTHER_KEY, sealed, AAD)).not.toThrow();
    expect(() => aeadOpen(KEY, sealed, OTHER_AAD)).not.toThrow();
    expect(() => aeadOpen(KEY, flipBit(sealed, sealed.length - 1), AAD)).not.toThrow();
    expect(() => aeadOpen(KEY, EMPTY, AAD)).not.toThrow();
  });
});

describe("a wrong-length key throws", () => {
  const WRONG_LENGTHS = [0, 1, 16, 31, 33, 64];

  it("on seal", () => {
    for (const length of WRONG_LENGTHS) {
      expect(() => aeadSeal(new Uint8Array(length).fill(7), PLAINTEXT, AAD)).toThrow(
        /must be exactly 32 bytes/,
      );
    }
  });

  it("on open", () => {
    const sealed = aeadSeal(KEY, PLAINTEXT, AAD);
    for (const length of WRONG_LENGTHS) {
      expect(() => aeadOpen(new Uint8Array(length).fill(7), sealed, AAD)).toThrow(
        /must be exactly 32 bytes/,
      );
    }
  });

  it("rather than answering null, because the two facts are different", () => {
    // A 31-byte key is wrong for every input and will never start working; a failed
    // authentication is ordinary input. Answering a misconfiguration with null would
    // make it indistinguishable from a tampered value.
    const short = new Uint8Array(31).fill(7);
    expect(() => aeadOpen(short, aeadSeal(KEY, PLAINTEXT, AAD), AAD)).toThrow();
    expect(aeadOpen(OTHER_KEY, aeadSeal(KEY, PLAINTEXT, AAD), AAD)).toBeNull();
  });

  it("checks the key before touching the buffer", () => {
    // Otherwise a short key plus a short buffer would answer null and hide the bug.
    expect(() => aeadOpen(new Uint8Array(31), EMPTY, AAD)).toThrow();
  });
});

describe("no message leaks key material, plaintext or ciphertext", () => {
  it("names only the two lengths", () => {
    const marker = "MARKERDONOTLOG";
    const markerKey = new TextEncoder().encode(`${marker}-short-key-xx`);
    expect(markerKey.length).not.toBe(AEAD_KEY_BYTES);
    const markerPlaintext = new TextEncoder().encode(`${marker}-plaintext`);
    const sealed = aeadSeal(KEY, markerPlaintext, AAD);

    const attempts: readonly (() => unknown)[] = [
      () => aeadSeal(markerKey, markerPlaintext, AAD),
      () => aeadOpen(markerKey, sealed, AAD),
    ];

    for (const attempt of attempts) {
      try {
        attempt();
        expect.unreachable("every attempt must throw");
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(marker);
        expect(message).not.toContain(Buffer.from(markerKey).toString("hex"));
        expect(message).not.toContain(Buffer.from(sealed).toString("hex"));
        expect(message).toContain("32 bytes");
      }
    }
  });
});
