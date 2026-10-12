import { describe, expect, it } from "vitest";

import {
  AEAD_KEY_BYTES,
  AEAD_MIN_SEALED_BYTES,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  aeadSeal,
} from "./aead.js";
import {
  DATA_KEY_BYTES,
  dataKeyToColumnKey,
  dataKeyWrapAad,
  generateDataKey,
  unwrapDataKey,
  wrapDataKey,
} from "./data-key.js";

const KEK = new Uint8Array(32).fill(7);
const OTHER_KEK = new Uint8Array(32).fill(9);
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const AAD = dataKeyWrapAad(TENANT, 1);

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function flipBit(bytes: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const byte = copy.at(index);
  if (byte === undefined) throw new Error(`index ${index.toString()} out of range`);
  copy.set([byte ^ 0x01], index);
  return copy;
}

describe("DATA_KEY_BYTES", () => {
  it("is the AEAD key length, taken from the cipher rather than restated", () => {
    // A data key is itself an AEAD-grade key, so the two cannot be allowed to drift.
    expect(DATA_KEY_BYTES).toBe(AEAD_KEY_BYTES);
    expect(DATA_KEY_BYTES).toBe(32);
  });
});

describe("generateDataKey", () => {
  it("returns exactly DATA_KEY_BYTES of bytes", () => {
    const dek = generateDataKey();
    expect(dek).toBeInstanceOf(Uint8Array);
    expect(dek.length).toBe(DATA_KEY_BYTES);
  });

  it("is random and not derived, which is what makes the envelope destroyable", () => {
    // The pin for this module's whole reason to exist. A key recomputable from the
    // tenant id and the deployment secret could not be destroyed by deleting its row,
    // so wrapping it would buy a row to delete and no consequence for deleting it.
    const keys = new Set<string>();
    for (let i = 0; i < 64; i += 1) keys.add(hex(generateDataKey()));
    expect(keys.size).toBe(64);
  });
});

describe("dataKeyWrapAad", () => {
  it("renders canonical JSON of [tenantId, generation]", () => {
    expect(text(dataKeyWrapAad(TENANT, 1))).toBe(`["${TENANT}",1]`);
  });

  it("is stable for one pair", () => {
    expect(text(dataKeyWrapAad(TENANT, 3))).toBe(text(dataKeyWrapAad(TENANT, 3)));
  });

  it("differs per tenant", () => {
    expect(text(dataKeyWrapAad(TENANT, 1))).not.toBe(
      text(dataKeyWrapAad(OTHER_TENANT, 1)),
    );
  });

  it("differs per generation", () => {
    expect(text(dataKeyWrapAad(TENANT, 1))).not.toBe(text(dataKeyWrapAad(TENANT, 2)));
  });

  it("distinguishes pairs a joined rendering would run together", () => {
    // ("tenant1", 2) and ("tenant", 12) are one string under any rendering that
    // concatenates the operands, and stay two under JSON — which is the point: the
    // array form does not require anyone to work out which joinings are safe for which
    // operand shapes, and a tenant id is caller-supplied text.
    expect("tenant1" + "2").toBe("tenant" + "12");
    expect(text(dataKeyWrapAad("tenant1", 2))).not.toBe(text(dataKeyWrapAad("tenant", 12)));
  });

  it("distinguishes tenant ids that carry the delimiter a joined rendering would use", () => {
    expect(text(dataKeyWrapAad("t:1", 2))).not.toBe(text(dataKeyWrapAad("t", 12)));
    expect(text(dataKeyWrapAad("t", 1))).not.toBe(text(dataKeyWrapAad("t:1", 1)));
  });

  it("escapes a tenant id that would otherwise close the array", () => {
    // JSON's own escaping is what makes the claim above true for *any* tenant id.
    const hostile = '","x"],[';
    expect(text(dataKeyWrapAad(hostile, 1))).not.toBe(text(dataKeyWrapAad("x", 1)));
    expect(JSON.parse(text(dataKeyWrapAad(hostile, 1))) as unknown).toEqual([hostile, 1]);
  });
});

describe("wrapDataKey / unwrapDataKey round trip", () => {
  it("returns the same data key under the same KEK and AAD", () => {
    const dek = generateDataKey();
    const unwrapped = unwrapDataKey(KEK, wrapDataKey(KEK, dek, AAD), AAD);
    expect(unwrapped).not.toBeNull();
    expect(hex(unwrapped ?? new Uint8Array(0))).toBe(hex(dek));
  });

  it("produces the AEAD wire format over a fixed-width plaintext", () => {
    expect(wrapDataKey(KEK, generateDataKey(), AAD).length).toBe(
      AEAD_NONCE_BYTES + DATA_KEY_BYTES + AEAD_TAG_BYTES,
    );
  });

  it("does not leave the data key in the wrapped bytes", () => {
    const dek = generateDataKey();
    const wrapped = wrapDataKey(KEK, dek, AAD);
    expect(Buffer.from(wrapped).includes(Buffer.from(dek))).toBe(false);
  });

  it("is non-deterministic, so two wraps of one key are not an equality test", () => {
    const dek = generateDataKey();
    expect(hex(wrapDataKey(KEK, dek, AAD))).not.toBe(hex(wrapDataKey(KEK, dek, AAD)));
  });
});

describe("unwrapDataKey answers null rather than throwing", () => {
  const DEK = generateDataKey();
  const WRAPPED = wrapDataKey(KEK, DEK, AAD);

  it("for a wrong key-encryption key", () => {
    expect(unwrapDataKey(OTHER_KEK, WRAPPED, AAD)).toBeNull();
  });

  it("for a row wrapped for another tenant", () => {
    // What makes a copied row useless: the tenant is in the binding, not only in the
    // column the row sits in.
    expect(unwrapDataKey(KEK, WRAPPED, dataKeyWrapAad(OTHER_TENANT, 1))).toBeNull();
  });

  it("for a row replayed as another generation", () => {
    expect(unwrapDataKey(KEK, WRAPPED, dataKeyWrapAad(TENANT, 2))).toBeNull();
  });

  it("for a flipped bit anywhere in the wrapped value", () => {
    for (const index of [0, AEAD_NONCE_BYTES, WRAPPED.length - 1]) {
      expect(unwrapDataKey(KEK, flipBit(WRAPPED, index), AAD)).toBeNull();
    }
  });

  it("for a truncated wrapped value", () => {
    for (const length of [0, 1, AEAD_MIN_SEALED_BYTES - 1, WRAPPED.length - 1]) {
      expect(unwrapDataKey(KEK, WRAPPED.subarray(0, length), AAD)).toBeNull();
    }
  });

  it("for a plaintext that authenticates but is not a usable key length", () => {
    // Only reachable from a row this module did not write. It is folded into the same
    // null because the caller's answer to it is the answer null already demands.
    const short = aeadSeal(KEK, new Uint8Array(16).fill(1), AAD);
    expect(unwrapDataKey(KEK, short, AAD)).toBeNull();
  });

  it("without throwing for any of them", () => {
    expect(() => unwrapDataKey(OTHER_KEK, WRAPPED, AAD)).not.toThrow();
    expect(() => unwrapDataKey(KEK, WRAPPED, dataKeyWrapAad(OTHER_TENANT, 1))).not.toThrow();
    expect(() => unwrapDataKey(KEK, new Uint8Array(0), AAD)).not.toThrow();
  });
});

describe("a wrong-length key throws, where a failed unwrap is null", () => {
  it("on a wrong-length data key at wrap", () => {
    for (const length of [0, 16, 31, 33]) {
      expect(() => wrapDataKey(KEK, new Uint8Array(length).fill(1), AAD)).toThrow(
        /data key must be exactly 32 bytes/,
      );
    }
  });

  it("on a wrong-length KEK at wrap and at unwrap", () => {
    const wrapped = wrapDataKey(KEK, generateDataKey(), AAD);
    expect(() => wrapDataKey(new Uint8Array(31), generateDataKey(), AAD)).toThrow(
      /must be exactly 32 bytes/,
    );
    expect(() => unwrapDataKey(new Uint8Array(31), wrapped, AAD)).toThrow(
      /must be exactly 32 bytes/,
    );
  });

  it("on a wrong-length data key at rendering", () => {
    // The sharpest of the three: pgp_sym_encrypt takes a key of any length, so a short
    // data key rendered to text would encrypt PHI under a weak key and report success.
    expect(() => dataKeyToColumnKey(new Uint8Array(16).fill(1))).toThrow(
      /data key must be exactly 32 bytes/,
    );
  });
});

describe("dataKeyToColumnKey", () => {
  it("renders base64 that decodes back to the data key", () => {
    const dek = generateDataKey();
    const rendered = dataKeyToColumnKey(dek);
    expect(rendered).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(hex(Buffer.from(rendered, "base64"))).toBe(hex(dek));
  });

  it("is 44 characters for a 32-byte key", () => {
    expect(dataKeyToColumnKey(generateDataKey())).toHaveLength(44);
  });

  it("is stable and distinct per key", () => {
    const a = generateDataKey();
    const b = generateDataKey();
    expect(dataKeyToColumnKey(a)).toBe(dataKeyToColumnKey(a));
    expect(dataKeyToColumnKey(a)).not.toBe(dataKeyToColumnKey(b));
  });
});

describe("no message leaks key material", () => {
  it("names only the two lengths", () => {
    const marker = "MARKERDONOTLOG";
    const markerKey = new TextEncoder().encode(`${marker}-wrong-length`);
    expect(markerKey.length).not.toBe(DATA_KEY_BYTES);
    const dek = generateDataKey();

    const attempts: readonly (() => unknown)[] = [
      () => wrapDataKey(KEK, markerKey, AAD),
      () => wrapDataKey(markerKey, dek, AAD),
      () => unwrapDataKey(markerKey, wrapDataKey(KEK, dek, AAD), AAD),
      () => dataKeyToColumnKey(markerKey),
    ];

    for (const attempt of attempts) {
      try {
        attempt();
        expect.unreachable("every attempt must throw");
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(marker);
        expect(message).not.toContain(hex(markerKey));
        expect(message).not.toContain(hex(dek));
        expect(message).not.toContain(dataKeyToColumnKey(dek));
        expect(message).toContain("32 bytes");
      }
    }
  });
});
