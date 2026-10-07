import { AEAD_KEY_BYTES, ColumnSecretRefused } from "@crossengin/crypto";
import type { CursorKeySource } from "@crossengin/operate-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALLOW_CURSOR_DISCLOSURE_FLAG,
  CURSOR_ENCRYPTION_SECRET_VAR,
  CURSOR_SEALING_MODES,
  buildCursorKeySource,
  formatCursorSealing,
  resolveCursorSealing,
} from "./cursor-encryption.js";

/** 36 bytes, 20 distinct — comfortably past any floor a derivation secret has. */
const SECRET = "0123456789abcdefghij0123456789abcdef";
/** Five bytes. Short of a 256-bit key's worth of material by any measure. */
const WEAK = "short";
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("CURSOR_SEALING_MODES", () => {
  it("lists the three modes in a stable order", () => {
    expect(CURSOR_SEALING_MODES).toEqual(["sealed", "plaintext_accepted", "absent"]);
  });
});

describe("resolveCursorSealing", () => {
  it("seals when a secret is present", () => {
    const resolved = resolveCursorSealing({ secret: SECRET, allowDisclosure: false });
    expect(resolved.mode).toBe("sealed");
    expect(resolved.sealer).not.toBeNull();
  });

  /**
   * The asymmetry that matters. The flag *accepts* a disclosure; it does not request one, so a
   * deployment holding both — a compose file carrying the flag through a migration — must not be
   * silently downgraded from ciphertext to plaintext by the thing it passed while arranging the
   * key.
   */
  it("still seals when a secret is present and the flag was also passed", () => {
    const resolved = resolveCursorSealing({ secret: SECRET, allowDisclosure: true });
    expect(resolved.mode).toBe("sealed");
    expect(resolved.sealer).not.toBeNull();
  });

  it("accepts the disclosure when there is no secret and the flag was passed", () => {
    const resolved = resolveCursorSealing({ secret: null, allowDisclosure: true });
    expect(resolved.mode).toBe("plaintext_accepted");
    expect(resolved.sealer).toBeNull();
  });

  it("answers absent when there is neither a secret nor the flag", () => {
    const resolved = resolveCursorSealing({ secret: null, allowDisclosure: false });
    expect(resolved.mode).toBe("absent");
    expect(resolved.sealer).toBeNull();
  });

  it("reads an empty or whitespace-only secret as unset rather than as a nought-byte secret", () => {
    // The spelling the column secret's reader already uses. Routing `""` to the parser would
    // answer `too_short` where the true fact is that nothing was set, and the remedy for the two
    // is not the same.
    for (const secret of ["", "   ", "\n\t"]) {
      expect(resolveCursorSealing({ secret, allowDisclosure: false }).mode).toBe("absent");
      expect(resolveCursorSealing({ secret, allowDisclosure: true }).mode).toBe(
        "plaintext_accepted",
      );
    }
  });

  it("returns a sealer only in the sealed mode", () => {
    const sealing = [
      resolveCursorSealing({ secret: SECRET, allowDisclosure: false }),
      resolveCursorSealing({ secret: null, allowDisclosure: true }),
      resolveCursorSealing({ secret: null, allowDisclosure: false }),
    ];
    expect(sealing.filter((s) => s.sealer !== null).map((s) => s.mode)).toEqual(["sealed"]);
  });

  it("refuses a weak secret rather than resolving to a mode that reads as configured", () => {
    // The refusal must not degrade to `absent`: a deployment that supplied a secret and had it
    // rejected has a fixable misconfiguration, and reporting it as "no secret set" would hide
    // the remedy behind the mode whose remedy is a flag.
    expect(() => resolveCursorSealing({ secret: WEAK, allowDisclosure: false })).toThrow();
    expect(() => resolveCursorSealing({ secret: WEAK, allowDisclosure: true })).toThrow();
  });
});

describe("buildCursorKeySource", () => {
  afterEach(() => {
    vi.doUnmock("@crossengin/crypto");
    vi.resetModules();
  });

  /**
   * The whole point of validating eagerly: the refusal lands on the build call, so there is no
   * closure to have failed later on the first page of a list.
   */
  it("refuses a weak secret on the build call, not on first use", () => {
    let source: CursorKeySource | null = null;
    expect(() => {
      source = buildCursorKeySource(WEAK);
    }).toThrow();
    expect(source).toBeNull();
  });

  it("refuses a short secret as too_short, naming the measured figure", () => {
    try {
      buildCursorKeySource(WEAK);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ColumnSecretRefused);
      expect((err as ColumnSecretRefused).reason).toBe("too_short");
    }
  });

  it("refuses a long but uniform secret as too_uniform", () => {
    try {
      buildCursorKeySource("ab".repeat(30));
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as ColumnSecretRefused).reason).toBe("too_uniform");
    }
  });

  it("sends the operator to the cursor secret rather than the column one", () => {
    // The two secrets are separate variables with separate rotation costs, and the refusal class
    // is shared — so a refusal that named the column secret would send an operator to rotate the
    // key holding their PHI at rest.
    try {
      buildCursorKeySource(WEAK);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as Error).message).toContain("cursor");
    }
  });

  it("puts no part of the secret in the refusal message", () => {
    const weak = "zz".repeat(30);
    try {
      buildCursorKeySource(weak);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as Error).message).not.toContain(weak);
      expect((err as Error).message).not.toContain("zzzz");
    }
  });

  it("derives a key of exactly the cipher's key length", () => {
    // Read off `AEAD_KEY_BYTES` rather than written as 32, so this cannot drift from the cipher
    // that consumes it — and a wrong length is a throw inside the sealer on the first page.
    const key = buildCursorKeySource(SECRET)(TENANT_A);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(AEAD_KEY_BYTES);
  });

  it("derives independent keys per tenant", () => {
    const source = buildCursorKeySource(SECRET);
    expect(hex(source(TENANT_A))).not.toBe(hex(source(TENANT_B)));
  });

  it("serves one tenant the identical key across calls", () => {
    const source = buildCursorKeySource(SECRET);
    // Identity and not equality: a cache hit returns the same object, so this fails if the
    // cache is missing while the bytes still agree.
    expect(source(TENANT_A)).toBe(source(TENANT_A));
  });

  it("derives a different key from a different secret", () => {
    const other = `${SECRET}-other-material`;
    expect(hex(buildCursorKeySource(SECRET)(TENANT_A))).not.toBe(
      hex(buildCursorKeySource(other)(TENANT_A)),
    );
  });

  it("derives a different key per generation", () => {
    expect(hex(buildCursorKeySource(SECRET, { generation: 1 })(TENANT_A))).not.toBe(
      hex(buildCursorKeySource(SECRET, { generation: 2 })(TENANT_A)),
    );
  });

  it("treats an omitted generation as the crypto package's default", () => {
    expect(hex(buildCursorKeySource(SECRET)(TENANT_A))).toBe(
      hex(buildCursorKeySource(SECRET, { generation: 1 })(TENANT_A)),
    );
  });

  it("propagates the refusal of an empty tenant id rather than deriving a shared key", () => {
    // A key shared across tenants is one any of them could open, which is the sealing undone.
    const source = buildCursorKeySource(SECRET);
    expect(() => source("")).toThrow();
  });

  it("derives once per tenant and serves the cached key afterwards", async () => {
    const derivedFor: string[] = [];
    vi.doMock("@crossengin/crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@crossengin/crypto")>();
      return {
        ...actual,
        deriveTenantCursorKey: (
          secret: Uint8Array,
          tenantId: string,
          generation?: number,
        ): Uint8Array => {
          derivedFor.push(tenantId);
          return generation === undefined
            ? actual.deriveTenantCursorKey(secret, tenantId)
            : actual.deriveTenantCursorKey(secret, tenantId, generation);
        },
      };
    });
    const mod = await import("./cursor-encryption.js");
    const source = mod.buildCursorKeySource(SECRET);
    source(TENANT_A);
    source(TENANT_A);
    source(TENANT_B);
    source(TENANT_A);
    expect(derivedFor).toEqual([TENANT_A, TENANT_B]);
  });

  it("parses the secret once, before any key is asked for", async () => {
    let parses = 0;
    let derives = 0;
    vi.doMock("@crossengin/crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@crossengin/crypto")>();
      return {
        ...actual,
        parseCursorEncryptionSecret: (raw: string): Uint8Array => {
          parses += 1;
          return actual.parseCursorEncryptionSecret(raw);
        },
        deriveTenantCursorKey: (
          secret: Uint8Array,
          tenantId: string,
          generation?: number,
        ): Uint8Array => {
          derives += 1;
          return generation === undefined
            ? actual.deriveTenantCursorKey(secret, tenantId)
            : actual.deriveTenantCursorKey(secret, tenantId, generation);
        },
      };
    });
    const mod = await import("./cursor-encryption.js");
    const source = mod.buildCursorKeySource(SECRET);
    expect(parses).toBe(1);
    expect(derives).toBe(0);
    source(TENANT_A);
    source(TENANT_B);
    expect(parses).toBe(1);
    expect(derives).toBe(2);
  });
});

describe("formatCursorSealing", () => {
  it("leads with the mode, so a boot log is greppable", () => {
    for (const mode of CURSOR_SEALING_MODES) {
      expect(formatCursorSealing(mode).startsWith(`cursor sealing: ${mode} —`)).toBe(true);
    }
  });

  it("gives every mode its own line", () => {
    const lines = CURSOR_SEALING_MODES.map(formatCursorSealing);
    expect(new Set(lines).size).toBe(CURSOR_SEALING_MODES.length);
  });

  it("names the secret the sealed mode derives from", () => {
    expect(formatCursorSealing("sealed")).toContain(CURSOR_ENCRYPTION_SECRET_VAR);
  });

  it("says sealing is uniform rather than per entity", () => {
    expect(formatCursorSealing("sealed")).toContain("not filtered");
  });

  it("names the flag that was given when a disclosure was accepted", () => {
    const line = formatCursorSealing("plaintext_accepted");
    expect(line).toContain(ALLOW_CURSOR_DISCLOSURE_FLAG);
    expect(line).toContain(CURSOR_ENCRYPTION_SECRET_VAR);
  });

  it("names the refusal the absent mode can produce, and that it is conditional", () => {
    // `absent` is not itself a fault — most manifests withhold no rows — so the line has to say
    // what makes it one rather than reading as a standing warning an operator learns to ignore.
    const line = formatCursorSealing("absent");
    expect(line).toContain("cursor_discloses_withheld_rows");
    expect(line).toContain("only if");
  });

  it("never claims a refusal of its own, because the mode alone does not refuse", () => {
    for (const mode of CURSOR_SEALING_MODES) {
      expect(formatCursorSealing(mode)).not.toContain("REFUSED");
    }
  });
});
