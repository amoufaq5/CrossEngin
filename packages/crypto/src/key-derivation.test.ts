import { hkdfSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AEAD_KEY_BYTES } from "./aead.js";
import { sha256 } from "./hashing.js";
import {
  COLUMN_KEY_BYTES,
  COLUMN_KEY_DERIVATION_INFO,
  COLUMN_SECRET_REFUSAL_REASONS,
  CURSOR_KEY_DERIVATION_INFO,
  ColumnSecretRefused,
  DEFAULT_KEY_GENERATION,
  MIN_COLUMN_SECRET_BYTES,
  MIN_COLUMN_SECRET_DISTINCT_BYTES,
  PLATFORM_COLUMN_KEY_SCOPE,
  columnKeyFingerprint,
  deriveTenantColumnKey,
  deriveTenantCursorKey,
  isColumnSecretRefusalReason,
  parseColumnEncryptionSecret,
  parseCursorEncryptionSecret,
} from "./key-derivation.js";

const SECRET_TEXT = "crossengin-column-secret-0123456789abcdef";
const SECRET = parseColumnEncryptionSecret(SECRET_TEXT);
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";

describe("key-derivation constants", () => {
  it("pins the info string", () => {
    expect(COLUMN_KEY_DERIVATION_INFO).toBe("crossengin.column-encryption.v1");
  });

  it("pins the cursor info string, and that it is not the column one", () => {
    expect(CURSOR_KEY_DERIVATION_INFO).toBe("crossengin.list-cursor.v1");
    expect(CURSOR_KEY_DERIVATION_INFO).not.toBe(COLUMN_KEY_DERIVATION_INFO);
  });

  it("pins the secret floors and the derived key size", () => {
    expect(MIN_COLUMN_SECRET_BYTES).toBe(32);
    expect(MIN_COLUMN_SECRET_DISTINCT_BYTES).toBe(16);
    expect(COLUMN_KEY_BYTES).toBe(32);
  });

  it("names the default generation and the platform scope rather than leaving callers to invent them", () => {
    expect(DEFAULT_KEY_GENERATION).toBe(1);
    expect(PLATFORM_COLUMN_KEY_SCOPE).toBe("platform");
  });

  it("declares exactly two refusal reasons", () => {
    expect(COLUMN_SECRET_REFUSAL_REASONS).toEqual(["too_short", "too_uniform"]);
  });
});

describe("isColumnSecretRefusalReason", () => {
  it("accepts every declared reason", () => {
    for (const reason of COLUMN_SECRET_REFUSAL_REASONS) {
      expect(isColumnSecretRefusalReason(reason)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isColumnSecretRefusalReason("too_weak")).toBe(false);
    expect(isColumnSecretRefusalReason(undefined)).toBe(false);
  });
});

describe("ColumnSecretRefused", () => {
  it("is an Error named for itself", () => {
    const err = new ColumnSecretRefused("too_short", "detail text");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ColumnSecretRefused");
  });

  it("carries the machine-readable reason beside the prose", () => {
    const err = new ColumnSecretRefused("too_uniform", "detail text");
    expect(err.reason).toBe("too_uniform");
    expect(err.message).toContain("too_uniform");
    expect(err.message).toContain("detail text");
  });
});

describe("parseColumnEncryptionSecret", () => {
  it("accepts a varied secret and returns its bytes", () => {
    const bytes = parseColumnEncryptionSecret(SECRET_TEXT);
    expect(bytes.length).toBe(SECRET_TEXT.length);
    expect(Buffer.from(bytes).toString("utf8")).toBe(SECRET_TEXT);
  });

  it("accepts the minimum length and refuses one byte below it", () => {
    expect(parseColumnEncryptionSecret("crossengin-column-secret-0123456").length).toBe(
      32,
    );
    expect(() =>
      parseColumnEncryptionSecret("crossengin-column-secret-012345"),
    ).toThrow(ColumnSecretRefused);
  });

  it("measures UTF-8 bytes rather than characters", () => {
    // 16 Greek letters are 16 characters and 32 bytes, so a character-counting
    // implementation would refuse what this accepts.
    const greek = "αβγδεζηθικλμνξοπ";
    expect(greek.length).toBe(16);
    expect(parseColumnEncryptionSecret(greek).length).toBe(32);
  });

  it("refuses an empty secret as too_short", () => {
    try {
      parseColumnEncryptionSecret("");
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as ColumnSecretRefused).reason).toBe("too_short");
    }
  });

  it("names the measured byte count on too_short and nothing of the secret", () => {
    try {
      parseColumnEncryptionSecret("tiny!");
      expect.unreachable("expected a refusal");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("5 bytes");
      expect(message).toContain("32");
      expect(message).not.toContain("tiny");
    }
  });

  it("refuses a short placeholder padded to length", () => {
    // The shape a deployment produces when it is satisfying a length check rather
    // than supplying entropy.
    try {
      parseColumnEncryptionSecret("changeme" + "!".repeat(40));
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as ColumnSecretRefused).reason).toBe("too_uniform");
    }
  });

  it("names the measured distinct count on too_uniform and nothing of the secret", () => {
    try {
      parseColumnEncryptionSecret("ABCDEFGHIJKLMNO".repeat(3));
      expect.unreachable("expected a refusal");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("15 distinct");
      expect(message).toContain("45 bytes");
      expect(message).not.toContain("ABCDE");
    }
  });

  it("accepts exactly the minimum distinct count and refuses one below it", () => {
    expect(parseColumnEncryptionSecret("ABCDEFGHIJKLMNOP".repeat(2)).length).toBe(32);
    expect(() => parseColumnEncryptionSecret("ABCDEFGHIJKLMNO".repeat(3))).toThrow(
      ColumnSecretRefused,
    );
  });

  it("refuses a secret whose bytes repeat, at any length and in any script", () => {
    for (const weak of ["a".repeat(64), "é".repeat(20)]) {
      try {
        parseColumnEncryptionSecret(weak);
        expect.unreachable("expected a refusal");
      } catch (err) {
        expect((err as ColumnSecretRefused).reason).toBe("too_uniform");
      }
    }
  });

  it("refuses rather than padding or stretching a weak secret", () => {
    // The property, stated as a test: there is no outcome in which a refused secret
    // yields a key anyway.
    expect(() => parseColumnEncryptionSecret("tiny")).toThrow(ColumnSecretRefused);
    expect(() => deriveTenantColumnKey(new TextEncoder().encode("tiny"), TENANT)).toThrow(
      ColumnSecretRefused,
    );
  });
});

describe("deriveTenantColumnKey", () => {
  it("matches HKDF-SHA256 computed independently with node:crypto", () => {
    const expected = Buffer.from(
      hkdfSync(
        "sha256",
        new TextEncoder().encode(SECRET_TEXT),
        new TextEncoder().encode(TENANT),
        new TextEncoder().encode(`${COLUMN_KEY_DERIVATION_INFO}:gen1`),
        32,
      ),
    ).toString("base64");
    expect(deriveTenantColumnKey(SECRET, TENANT, 1)).toBe(expected);
  });

  it("matches pinned known-answer vectors", () => {
    // Pinned as literals, not only as a recomputation: changing the derivation makes
    // every existing ciphertext undecryptable, so it must not be possible to change
    // it and still have a green suite. Editing these literals is the deliberate act
    // that says a re-encryption migration was considered.
    expect(deriveTenantColumnKey(SECRET, TENANT)).toBe(
      "BA+HbNNpq/fhAiXghGrB/8Mw73yG7+pED+QAFxIxbXM=",
    );
    expect(deriveTenantColumnKey(SECRET, TENANT, 2)).toBe(
      "/2CXRvyHXDLLuPWIBkAA5SfRATwo8JzK9zfASNMDrl0=",
    );
    expect(deriveTenantColumnKey(SECRET, PLATFORM_COLUMN_KEY_SCOPE)).toBe(
      "3panw/h1q2nTqHlsiWOKaGSgFZpKqNYYT7Q5NbaaNiM=",
    );
  });

  it("returns base64 text of exactly COLUMN_KEY_BYTES bytes", () => {
    const key = deriveTenantColumnKey(SECRET, TENANT);
    expect(key).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(key, "base64").length).toBe(COLUMN_KEY_BYTES);
  });

  it("is stable across calls", () => {
    expect(deriveTenantColumnKey(SECRET, TENANT)).toBe(
      deriveTenantColumnKey(SECRET, TENANT),
    );
  });

  it("is distinct per tenant", () => {
    expect(deriveTenantColumnKey(SECRET, TENANT)).not.toBe(
      deriveTenantColumnKey(SECRET, OTHER_TENANT),
    );
  });

  it("is distinct per generation", () => {
    expect(deriveTenantColumnKey(SECRET, TENANT, 1)).not.toBe(
      deriveTenantColumnKey(SECRET, TENANT, 2),
    );
  });

  it("is distinct per secret", () => {
    const other = parseColumnEncryptionSecret("a-different-deployment-secret-0123456789");
    expect(deriveTenantColumnKey(SECRET, TENANT)).not.toBe(
      deriveTenantColumnKey(other, TENANT),
    );
  });

  it("defaults the generation to DEFAULT_KEY_GENERATION", () => {
    expect(deriveTenantColumnKey(SECRET, TENANT)).toBe(
      deriveTenantColumnKey(SECRET, TENANT, DEFAULT_KEY_GENERATION),
    );
  });

  it("refuses an empty tenantId rather than treating it as platform scope", () => {
    // HKDF substitutes a zero-filled block for an absent salt, so an empty tenant id
    // would silently derive one key shared by every caller that had it.
    expect(() => deriveTenantColumnKey(SECRET, "")).toThrow(/non-empty/);
  });

  it("refuses a non-positive or fractional generation", () => {
    expect(() => deriveTenantColumnKey(SECRET, TENANT, 0)).toThrow(/generation/);
    expect(() => deriveTenantColumnKey(SECRET, TENANT, -1)).toThrow(/generation/);
    expect(() => deriveTenantColumnKey(SECRET, TENANT, 1.5)).toThrow(/generation/);
    expect(() => deriveTenantColumnKey(SECRET, TENANT, Number.NaN)).toThrow(/generation/);
  });

  it("refuses a too-uniform secret handed in directly, bypassing the parser", () => {
    try {
      deriveTenantColumnKey(new TextEncoder().encode("z".repeat(64)), TENANT);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as ColumnSecretRefused).reason).toBe("too_uniform");
    }
  });
});

describe("parseCursorEncryptionSecret", () => {
  it("accepts a varied secret and returns its bytes", () => {
    const bytes = parseCursorEncryptionSecret(SECRET_TEXT);
    expect(bytes.length).toBe(SECRET_TEXT.length);
    expect(Buffer.from(bytes).toString("utf8")).toBe(SECRET_TEXT);
  });

  it("applies the same floors as the column parser, through the same validator", () => {
    expect(parseCursorEncryptionSecret("crossengin-cursor-secret-0123456").length).toBe(
      32,
    );
    expect(() => parseCursorEncryptionSecret("crossengin-cursor-secret-012345")).toThrow(
      ColumnSecretRefused,
    );
    expect(() => parseCursorEncryptionSecret("ABCDEFGHIJKLMNO".repeat(3))).toThrow(
      ColumnSecretRefused,
    );
  });

  it("names the list-cursor secret rather than the column one in both refusals", () => {
    // The whole reason the label is a parameter: an operator told "column encryption
    // secret refused" while configuring the cursor secret is sent to the wrong variable.
    for (const weak of ["tiny!", "ABCDEFGHIJKLMNO".repeat(3)]) {
      try {
        parseCursorEncryptionSecret(weak);
        expect.unreachable("expected a refusal");
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain("list-cursor encryption secret refused");
        expect(message).not.toContain("column encryption secret");
      }
    }
  });

  it("keeps the column parser naming the column secret", () => {
    try {
      parseColumnEncryptionSecret("tiny!");
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as Error).message).toContain("column encryption secret refused");
    }
  });

  it("reports the same machine-readable reasons as the column parser", () => {
    for (const [weak, reason] of [
      ["tiny!", "too_short"],
      ["ABCDEFGHIJKLMNO".repeat(3), "too_uniform"],
    ] as const) {
      try {
        parseCursorEncryptionSecret(weak);
        expect.unreachable("expected a refusal");
      } catch (err) {
        expect((err as ColumnSecretRefused).reason).toBe(reason);
      }
    }
  });
});

describe("deriveTenantCursorKey", () => {
  const CURSOR_SECRET = parseCursorEncryptionSecret(SECRET_TEXT);

  it("returns raw bytes of exactly the length the AEAD takes", () => {
    const key = deriveTenantCursorKey(CURSOR_SECRET, TENANT);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(AEAD_KEY_BYTES);
    expect(AEAD_KEY_BYTES).toBe(32);
  });

  it("matches HKDF-SHA256 computed independently with node:crypto", () => {
    const expected = new Uint8Array(
      hkdfSync(
        "sha256",
        new TextEncoder().encode(SECRET_TEXT),
        new TextEncoder().encode(TENANT),
        new TextEncoder().encode(`${CURSOR_KEY_DERIVATION_INFO}:gen1`),
        32,
      ),
    );
    expect(Buffer.from(deriveTenantCursorKey(CURSOR_SECRET, TENANT, 1))).toEqual(
      Buffer.from(expected),
    );
  });

  it("matches pinned known-answer vectors", () => {
    // Pinned as literals as well as recomputed above, so changing the derivation
    // cannot leave a green suite: every cursor already issued would stop opening, and
    // a client holding one would get a refusal it cannot act on. Editing these
    // literals is the deliberate act that says that was considered.
    const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
    expect(hex(deriveTenantCursorKey(CURSOR_SECRET, TENANT))).toBe(
      "680bcfa97151a09d13f7f6afa4f5c8ae573d491252a8eeaf2cfaa346e80f60cb",
    );
    expect(hex(deriveTenantCursorKey(CURSOR_SECRET, TENANT, 2))).toBe(
      "38ba7f45bed8532f90f4ece9c15bb1bb4a2f6898f882c34586ce0830eebe0d85",
    );
    expect(hex(deriveTenantCursorKey(CURSOR_SECRET, PLATFORM_COLUMN_KEY_SCOPE))).toBe(
      "c64f7513dc15cb9d5576ed10332032d44e977c7f96e247a970bca275d8234f30",
    );
  });

  it("is not the column key for the same secret and tenant", () => {
    // The info strings are the only separation there is, so it is asserted rather than
    // assumed: without it a leaked cursor key would decrypt a PHI column.
    const cursor = deriveTenantCursorKey(CURSOR_SECRET, TENANT);
    const column = Buffer.from(deriveTenantColumnKey(SECRET, TENANT), "base64");
    expect(Buffer.from(cursor)).not.toEqual(column);
    expect(column.length).toBe(cursor.length);
  });

  it("is stable across calls", () => {
    expect(Buffer.from(deriveTenantCursorKey(CURSOR_SECRET, TENANT))).toEqual(
      Buffer.from(deriveTenantCursorKey(CURSOR_SECRET, TENANT)),
    );
  });

  it("is distinct per tenant", () => {
    expect(Buffer.from(deriveTenantCursorKey(CURSOR_SECRET, TENANT))).not.toEqual(
      Buffer.from(deriveTenantCursorKey(CURSOR_SECRET, OTHER_TENANT)),
    );
  });

  it("is distinct per generation", () => {
    expect(Buffer.from(deriveTenantCursorKey(CURSOR_SECRET, TENANT, 1))).not.toEqual(
      Buffer.from(deriveTenantCursorKey(CURSOR_SECRET, TENANT, 2)),
    );
  });

  it("is distinct per secret", () => {
    const other = parseCursorEncryptionSecret("a-different-deployment-secret-0123456789");
    expect(Buffer.from(deriveTenantCursorKey(CURSOR_SECRET, TENANT))).not.toEqual(
      Buffer.from(deriveTenantCursorKey(other, TENANT)),
    );
  });

  it("defaults the generation to DEFAULT_KEY_GENERATION", () => {
    expect(Buffer.from(deriveTenantCursorKey(CURSOR_SECRET, TENANT))).toEqual(
      Buffer.from(deriveTenantCursorKey(CURSOR_SECRET, TENANT, DEFAULT_KEY_GENERATION)),
    );
  });

  it("refuses an empty tenantId rather than treating it as platform scope", () => {
    expect(() => deriveTenantCursorKey(CURSOR_SECRET, "")).toThrow(/non-empty/);
  });

  it("refuses a non-positive or fractional generation", () => {
    expect(() => deriveTenantCursorKey(CURSOR_SECRET, TENANT, 0)).toThrow(/generation/);
    expect(() => deriveTenantCursorKey(CURSOR_SECRET, TENANT, -1)).toThrow(/generation/);
    expect(() => deriveTenantCursorKey(CURSOR_SECRET, TENANT, 1.5)).toThrow(/generation/);
    expect(() => deriveTenantCursorKey(CURSOR_SECRET, TENANT, Number.NaN)).toThrow(
      /generation/,
    );
  });

  it("refuses a weak secret handed in directly, bypassing the parser", () => {
    // The same single validator, so there is no outcome in which a refused secret
    // yields a cursor key anyway.
    for (const [weak, reason] of [
      ["tiny", "too_short"],
      ["z".repeat(64), "too_uniform"],
    ] as const) {
      try {
        deriveTenantCursorKey(new TextEncoder().encode(weak), TENANT);
        expect.unreachable("expected a refusal");
      } catch (err) {
        expect((err as ColumnSecretRefused).reason).toBe(reason);
        expect((err as Error).message).toContain("list-cursor encryption secret");
      }
    }
  });
});

describe("columnKeyFingerprint", () => {
  it("returns 16 lowercase hex characters", () => {
    expect(columnKeyFingerprint(deriveTenantColumnKey(SECRET, TENANT))).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  it("is the sha256 prefix of the key", () => {
    const key = deriveTenantColumnKey(SECRET, TENANT);
    expect(columnKeyFingerprint(key)).toBe(sha256(key).slice(0, 16));
  });

  it("is stable and distinct per key", () => {
    const a = deriveTenantColumnKey(SECRET, TENANT);
    const b = deriveTenantColumnKey(SECRET, OTHER_TENANT);
    expect(columnKeyFingerprint(a)).toBe(columnKeyFingerprint(a));
    expect(columnKeyFingerprint(a)).not.toBe(columnKeyFingerprint(b));
  });

  it("refuses an empty key", () => {
    expect(() => columnKeyFingerprint("")).toThrow(/non-empty/);
  });
});

describe("no module error leaks secret or key material", () => {
  it("keeps a marker out of every reachable Error.message", () => {
    const marker = "MARKERDONOTLOG";
    const validMarkerSecretText = `${marker}-0123456789-xyzwq!`;
    const validSecret = parseColumnEncryptionSecret(validMarkerSecretText);
    const derivedKey = deriveTenantColumnKey(validSecret, TENANT);
    const derivedCursorKeyHex = Buffer.from(
      deriveTenantCursorKey(validSecret, TENANT),
    ).toString("hex");

    const attempts: readonly (() => unknown)[] = [
      // too_short, with the marker inside the refused secret
      () => parseColumnEncryptionSecret(marker),
      // too_uniform, with the marker inside a padded refused secret
      () => parseColumnEncryptionSecret(`${marker}${"A".repeat(30)}`),
      // the same two reached through the derivation, bypassing the parser
      () => deriveTenantColumnKey(new TextEncoder().encode(marker), TENANT),
      () =>
        deriveTenantColumnKey(
          new TextEncoder().encode(`${marker}${"A".repeat(30)}`),
          TENANT,
        ),
      // argument refusals, taken with a valid marker-bearing secret in hand
      () => deriveTenantColumnKey(validSecret, ""),
      () => deriveTenantColumnKey(validSecret, TENANT, 0),
      () => deriveTenantColumnKey(validSecret, TENANT, 1.5),
      () => columnKeyFingerprint(""),
      // the cursor parser and derivation, by the same four routes
      () => parseCursorEncryptionSecret(marker),
      () => parseCursorEncryptionSecret(`${marker}${"A".repeat(30)}`),
      () => deriveTenantCursorKey(new TextEncoder().encode(marker), TENANT),
      () => deriveTenantCursorKey(validSecret, ""),
      () => deriveTenantCursorKey(validSecret, TENANT, 0),
    ];

    const messages: string[] = [];
    for (const attempt of attempts) {
      try {
        attempt();
        expect.unreachable("every attempt must throw");
      } catch (err) {
        messages.push((err as Error).message);
      }
    }

    expect(messages).toHaveLength(attempts.length);
    for (const message of messages) {
      expect(message).not.toContain(marker);
      expect(message).not.toContain(validMarkerSecretText);
      expect(message).not.toContain(derivedKey);
      expect(message).not.toContain(derivedCursorKeyHex);
    }
  });
});
