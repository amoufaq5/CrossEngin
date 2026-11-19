import { deriveTenantKek, parseColumnEncryptionSecret } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { COLUMN_ENCRYPTION_SECRET_VAR } from "./column-encryption.js";
import {
  COLUMN_ENCRYPTION_SECRET_GENERATION_VAR,
  COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR,
  COLUMN_SECRET_RING_REFUSALS,
  ColumnSecretRingRefused,
  formatColumnSecretRing,
  kekResolverFor,
  resolveColumnSecretRing,
  seedSecretOf,
} from "./column-secret-ring.js";

/** Built by interpolation, so no secret-shaped literal sits in the tree (ADR-0420). */
function material(offset: number): string {
  return Array.from({ length: 40 }, (_, i) => String.fromCharCode(48 + ((i + offset) % 70))).join("");
}
const CURRENT = material(0);
const PREVIOUS = material(7);
const TENANT = "11111111-1111-4111-8111-111111111111";

function refusalOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ColumnSecretRingRefused ? e.reason : `other:${String(e)}`;
  }
}

describe("resolveColumnSecretRing", () => {
  it("defaults to generation 1 with no rotation, so an unrotated deployment is unchanged", () => {
    const ring = resolveColumnSecretRing({ [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT }, "envelope");
    expect(ring.currentGeneration).toBe(1);
    expect(ring.previous).toBeNull();
    // Generation 1 under the ring is byte-identical to the derivation every stored row used.
    const secret = parseColumnEncryptionSecret(CURRENT);
    expect(Buffer.from(kekResolverFor(ring)(TENANT, 1))).toEqual(
      Buffer.from(deriveTenantKek(secret, TENANT)),
    );
  });

  it("opens the previous generation under the previous secret and the current under the current", () => {
    const ring = resolveColumnSecretRing(
      {
        [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT,
        [COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR]: PREVIOUS,
        [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: "2",
      },
      "envelope",
    );
    const kek = kekResolverFor(ring);
    expect(Buffer.from(kek(TENANT, 1))).toEqual(
      Buffer.from(deriveTenantKek(parseColumnEncryptionSecret(PREVIOUS), TENANT, 1)),
    );
    expect(Buffer.from(kek(TENANT, 2))).toEqual(
      Buffer.from(deriveTenantKek(parseColumnEncryptionSecret(CURRENT), TENANT, 2)),
    );
    expect(() => kek(TENANT, 3)).toThrow(/no secret for key-encryption-key generation 3/);
    expect(Buffer.from(seedSecretOf(ring) ?? new Uint8Array())).toEqual(
      Buffer.from(parseColumnEncryptionSecret(PREVIOUS)),
    );
  });

  it("refuses a generation that is not a positive integer", () => {
    for (const raw of ["0", "-1", "1.5", "two", "01"]) {
      expect(
        refusalOf(() =>
          resolveColumnSecretRing(
            { [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT, [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: raw },
            "envelope",
          ),
        ),
      ).toBe("generation_malformed");
    }
  });

  it("refuses a previous secret without a generation of at least 2", () => {
    expect(
      refusalOf(() =>
        resolveColumnSecretRing(
          { [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT, [COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR]: PREVIOUS },
          "envelope",
        ),
      ),
    ).toBe("previous_needs_generation");
  });

  it("refuses a previous secret equal to the current one", () => {
    expect(
      refusalOf(() =>
        resolveColumnSecretRing(
          {
            [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT,
            [COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR]: CURRENT,
            [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: "2",
          },
          "envelope",
        ),
      ),
    ).toBe("previous_identical");
  });

  it("refuses a previous secret in derived mode and names envelope as the route", () => {
    const env = {
      [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT,
      [COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR]: PREVIOUS,
      [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: "2",
    };
    expect(refusalOf(() => resolveColumnSecretRing(env, "derived"))).toBe("previous_in_derived_mode");
    expect(() => resolveColumnSecretRing(env, "derived")).toThrow(/--column-key-mode envelope/);
  });

  it("refuses a generation in derived mode, which reads none, and admits generation 1 there", () => {
    expect(
      refusalOf(() =>
        resolveColumnSecretRing(
          { [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT, [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: "3" },
          "derived",
        ),
      ),
    ).toBe("generation_in_derived_mode");
    expect(
      refusalOf(() =>
        resolveColumnSecretRing(
          { [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT, [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: "1" },
          "derived",
        ),
      ),
    ).toBeNull();
    // Envelope mode keeps any generation: it is where generations mean something.
    expect(
      refusalOf(() =>
        resolveColumnSecretRing(
          { [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT, [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: "3" },
          "envelope",
        ),
      ),
    ).toBeNull();
  });

  it("refuses a weak previous secret by the same rule as a weak current one", () => {
    expect(() =>
      resolveColumnSecretRing(
        {
          [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT,
          [COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR]: "short",
          [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: "2",
        },
        "envelope",
      ),
    ).toThrow();
  });

  it("exercises every refusal reason it declares", () => {
    expect([...COLUMN_SECRET_RING_REFUSALS].sort()).toEqual(
      [
        "generation_malformed",
        "previous_identical",
        "previous_in_derived_mode",
        "previous_needs_generation",
        "generation_in_derived_mode",
      ].sort(),
    );
  });
});

describe("seedSecretOf", () => {
  const secretOf = (raw: string): Buffer => Buffer.from(parseColumnEncryptionSecret(raw));

  it("answers the generation-1 secret while the ring holds it", () => {
    const unrotated = resolveColumnSecretRing({ [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT }, "envelope");
    expect(Buffer.from(seedSecretOf(unrotated) ?? new Uint8Array())).toEqual(secretOf(CURRENT));
  });

  it("answers null once the first rotation completed, never the current secret", () => {
    // Generation 2 with the previous secret unset: derived-mode ciphertext is under generation 1's
    // secret, which this ring no longer holds. The current secret would seed a key that ciphertext
    // is not under.
    const completed = resolveColumnSecretRing(
      { [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT, [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: "2" },
      "envelope",
    );
    expect(seedSecretOf(completed)).toBeNull();
    // A second rotation's previous secret is generation 2's, not generation 1's.
    const second = resolveColumnSecretRing(
      {
        [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT,
        [COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR]: PREVIOUS,
        [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: "3",
      },
      "envelope",
    );
    expect(seedSecretOf(second)).toBeNull();
  });
});

describe("formatColumnSecretRing", () => {
  it("names generations and variables and never a value, either way", () => {
    const quiet = formatColumnSecretRing(
      resolveColumnSecretRing({ [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT }, "envelope"),
    );
    expect(quiet).toMatch(/no rotation in progress/);
    const rotating = formatColumnSecretRing(
      resolveColumnSecretRing(
        {
          [COLUMN_ENCRYPTION_SECRET_VAR]: CURRENT,
          [COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR]: PREVIOUS,
          [COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]: "2",
        },
        "envelope",
      ),
    );
    expect(rotating).toMatch(/ROTATING/);
    expect(rotating).toMatch(/--rewrap-kek/);
    for (const line of [quiet, rotating]) {
      expect(line).not.toContain(CURRENT);
      expect(line).not.toContain(PREVIOUS);
    }
  });
});
