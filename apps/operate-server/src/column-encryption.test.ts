import { ColumnSecretRefused } from "@crossengin/crypto";
import type { Manifest } from "@crossengin/kernel";
import type { ColumnEncryptionKeySource } from "@crossengin/operate-runtime-pg";
import { buildErpHealthcarePack } from "@crossengin/pack-erp-healthcare";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALLOW_PLAINTEXT_PHI_FLAG,
  COLUMN_ENCRYPTION_SECRET_VAR,
  DETAIL_FIELD_LIMIT,
  PHI_STORAGE_VERDICTS,
  PHI_VERDICT_MAY_SERVE,
  buildColumnKeySource,
  decidePhiStorage,
  formatPhiStorageDecision,
  surveyPhiFields,
  type PhiField,
  type PhiStorageInput,
} from "./column-encryption.js";

/** 36 bytes, 20 distinct — comfortably past both of the parser's floors. */
const SECRET = "0123456789abcdefghij0123456789abcdef";
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

/**
 * `ColumnEncryptionKeySource` permits a promise, since a future source might fetch from a
 * KMS. This one derives in-process and is synchronous, so the tests narrow once here rather
 * than awaiting a value that is never a promise.
 */
function keyFor(source: ColumnEncryptionKeySource, tenantId: string): string {
  const key = source(tenantId);
  if (typeof key !== "string") throw new Error("expected a synchronously derived key");
  return key;
}

function manifest(parts: Partial<Manifest> = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: { name: "Fixture", slug: "fixture/pack", version: "1.0.0" },
    ...parts,
  };
}

const PHI: PhiField = { entity: "Patient", field: "mrn", classification: "phi" };

function input(parts: Partial<PhiStorageInput> = {}): PhiStorageInput {
  return {
    store: "pg-columns",
    phiFields: [PHI],
    secretPresent: true,
    allowPlaintextPhi: false,
    ...parts,
  };
}

describe("PHI_STORAGE_VERDICTS", () => {
  it("lists the five verdicts in a stable order", () => {
    expect(PHI_STORAGE_VERDICTS).toEqual([
      "no_phi",
      "encrypted",
      "plaintext_accepted",
      "refused_no_secret",
      "refused_plaintext_store",
    ]);
  });

  it("maps every verdict to a serve answer, so a sixth is a compile error", () => {
    expect(Object.keys(PHI_VERDICT_MAY_SERVE).sort()).toEqual([...PHI_STORAGE_VERDICTS].sort());
  });

  it("refuses exactly the two verdicts whose names say so", () => {
    const refusing = PHI_STORAGE_VERDICTS.filter((v) => !PHI_VERDICT_MAY_SERVE[v]);
    expect(refusing).toEqual(["refused_no_secret", "refused_plaintext_store"]);
  });
});

describe("surveyPhiFields", () => {
  it("finds a phi field declared on the entity", () => {
    const m = manifest({
      entities: [
        {
          name: "Patient",
          fields: [{ name: "mrn", type: { kind: "text" }, classification: "phi" }],
        },
      ],
    });
    expect(surveyPhiFields(m)).toEqual([
      { entity: "Patient", field: "mrn", classification: "phi" },
    ]);
  });

  it("finds a regulated field", () => {
    const m = manifest({
      entities: [
        {
          name: "Batch",
          fields: [{ name: "lot_code", type: { kind: "text" }, classification: "regulated" }],
        },
      ],
    });
    expect(surveyPhiFields(m)).toEqual([
      { entity: "Batch", field: "lot_code", classification: "regulated" },
    ]);
  });

  it("excludes pii, which is sensitive but not encrypted at rest", () => {
    const m = manifest({
      entities: [
        {
          name: "Patient",
          fields: [{ name: "given_name", type: { kind: "text" }, classification: "pii" }],
        },
      ],
    });
    expect(surveyPhiFields(m)).toEqual([]);
  });

  it("excludes public, internal, commercial_sensitive and the unclassified", () => {
    const m = manifest({
      entities: [
        {
          name: "Product",
          fields: [
            { name: "sku", type: { kind: "text" }, classification: "public" },
            { name: "note", type: { kind: "text" }, classification: "internal" },
            {
              name: "unit_cost",
              type: { kind: "decimal", precision: 12, scale: 2 },
              classification: "commercial_sensitive",
            },
            { name: "bare", type: { kind: "text" } },
          ],
        },
      ],
    });
    expect(surveyPhiFields(m)).toEqual([]);
  });

  it("finds a classified field arriving through a custom trait", () => {
    // The blind spot this guards: a trait field is a real column, so a survey over
    // `entity.fields` alone would miss a field `validateManifest` sees.
    const m = manifest({
      traits: [
        {
          name: "clinically_tagged",
          fields: [{ name: "icd_code", type: { kind: "text" }, classification: "phi" }],
        },
      ],
      entities: [
        {
          name: "Encounter",
          traits: ["clinically_tagged"],
          fields: [{ name: "started_at", type: { kind: "datetime" } }],
        },
      ],
    });
    expect(surveyPhiFields(m)).toEqual([
      { entity: "Encounter", field: "icd_code", classification: "phi" },
    ]);
  });

  it("ignores a declared trait no entity references", () => {
    const m = manifest({
      traits: [
        {
          name: "clinically_tagged",
          fields: [{ name: "icd_code", type: { kind: "text" }, classification: "phi" }],
        },
      ],
      entities: [{ name: "Product", fields: [{ name: "sku", type: { kind: "text" } }] }],
    });
    expect(surveyPhiFields(m)).toEqual([]);
  });

  it("takes the entity's own field when a trait declares the same name", () => {
    // `resolvedFields` emits a name once and the entity wins, so the survey must not
    // report two rows for one column.
    const m = manifest({
      traits: [
        {
          name: "clinically_tagged",
          fields: [{ name: "icd_code", type: { kind: "text" }, classification: "phi" }],
        },
      ],
      entities: [
        {
          name: "Encounter",
          traits: ["clinically_tagged"],
          fields: [{ name: "icd_code", type: { kind: "text" }, classification: "internal" }],
        },
      ],
    });
    expect(surveyPhiFields(m)).toEqual([]);
  });

  it("answers [] for a manifest with no entities at all", () => {
    expect(surveyPhiFields(manifest())).toEqual([]);
    expect(surveyPhiFields(manifest({ entities: [] }))).toEqual([]);
  });

  it("orders by entity declaration then resolved field order", () => {
    const m = manifest({
      traits: [
        {
          name: "tagged",
          fields: [{ name: "trait_phi", type: { kind: "text" }, classification: "phi" }],
        },
      ],
      entities: [
        {
          name: "Zebra",
          traits: ["tagged"],
          fields: [{ name: "own_phi", type: { kind: "text" }, classification: "regulated" }],
        },
        {
          name: "Alpha",
          fields: [{ name: "a_phi", type: { kind: "text" }, classification: "phi" }],
        },
      ],
    });
    expect(surveyPhiFields(m).map((f) => `${f.entity}.${f.field}`)).toEqual([
      "Zebra.own_phi",
      "Zebra.trait_phi",
      "Alpha.a_phi",
    ]);
  });

  it("finds Patient.mrn in the real healthcare pack", () => {
    // The field the live defect was reproduced on. A fixture-only suite would not have
    // exercised trait resolution against a pack that actually declares traits.
    expect(surveyPhiFields(buildErpHealthcarePack())).toContainEqual({
      entity: "Patient",
      field: "mrn",
      classification: "phi",
    });
  });

  it("reports only encrypt-at-rest classes from the real healthcare pack", () => {
    for (const f of surveyPhiFields(buildErpHealthcarePack())) {
      expect(["phi", "regulated"]).toContain(f.classification);
    }
  });
});

describe("decidePhiStorage — row 1: no phi fields", () => {
  it("answers no_phi and serves on every store", () => {
    for (const store of ["memory", "pg", "pg-columns"] as const) {
      const d = decidePhiStorage(input({ store, phiFields: [] }));
      expect(d.verdict).toBe("no_phi");
      expect(d.mayServe).toBe(true);
      expect(d.fields).toEqual([]);
    }
  });

  it("does not care whether the secret is set or the opt-out given", () => {
    for (const secretPresent of [true, false]) {
      for (const allowPlaintextPhi of [true, false]) {
        const d = decidePhiStorage(
          input({ store: "pg", phiFields: [], secretPresent, allowPlaintextPhi }),
        );
        expect(d.verdict).toBe("no_phi");
        expect(d.mayServe).toBe(true);
      }
    }
  });

  it("says there is nothing to encrypt rather than naming a variable to set", () => {
    const d = decidePhiStorage(input({ phiFields: [], secretPresent: false }));
    expect(d.detail).toContain("no phi/regulated fields");
    expect(d.detail).not.toContain(COLUMN_ENCRYPTION_SECRET_VAR);
  });
});

describe("decidePhiStorage — row 2: pg-columns with a secret", () => {
  it("answers encrypted and serves, whether or not the opt-out was given", () => {
    for (const allowPlaintextPhi of [true, false]) {
      const d = decidePhiStorage(
        input({ store: "pg-columns", secretPresent: true, allowPlaintextPhi }),
      );
      expect(d.verdict).toBe("encrypted");
      expect(d.mayServe).toBe(true);
    }
  });

  it("names the environment variable the key is derived from, and the field", () => {
    const d = decidePhiStorage(input({ store: "pg-columns", secretPresent: true }));
    expect(d.detail).toContain(COLUMN_ENCRYPTION_SECRET_VAR);
    expect(d.detail).toContain("Patient.mrn");
  });
});

describe("decidePhiStorage — row 3: pg-columns with no secret", () => {
  it("refuses the boot rather than 500ing on the first PHI write", () => {
    const d = decidePhiStorage(input({ store: "pg-columns", secretPresent: false }));
    expect(d.verdict).toBe("refused_no_secret");
    expect(d.mayServe).toBe(false);
    expect(d.detail).toContain(COLUMN_ENCRYPTION_SECRET_VAR);
    expect(d.detail).toContain("Patient.mrn");
  });

  it("is not rescued by the plaintext opt-out, because BYTEA cannot hold plaintext", () => {
    const d = decidePhiStorage(
      input({ store: "pg-columns", secretPresent: false, allowPlaintextPhi: true }),
    );
    expect(d.verdict).toBe("refused_no_secret");
    expect(d.mayServe).toBe(false);
    expect(d.detail).toContain(ALLOW_PLAINTEXT_PHI_FLAG);
    expect(d.detail).toContain("does not apply");
  });
});

describe("decidePhiStorage — rows 4 and 6: a store that cannot encrypt, refused by default", () => {
  for (const store of ["pg", "memory"] as const) {
    it(`refuses --store ${store} with phi fields, with or without a secret`, () => {
      for (const secretPresent of [true, false]) {
        const d = decidePhiStorage(input({ store, secretPresent, allowPlaintextPhi: false }));
        expect(d.verdict).toBe("refused_plaintext_store");
        expect(d.mayServe).toBe(false);
        expect(d.detail).toContain(`--store ${store}`);
      }
    });
  }

  it("names the opt-out and the configuration that does encrypt", () => {
    const d = decidePhiStorage(input({ store: "pg", allowPlaintextPhi: false }));
    expect(d.detail).toContain(ALLOW_PLAINTEXT_PHI_FLAG);
    expect(d.detail).toContain("--store pg-columns");
  });
});

describe("decidePhiStorage — rows 5 and 7: plaintext accepted on request", () => {
  for (const store of ["pg", "memory"] as const) {
    it(`serves --store ${store} when the opt-out is given`, () => {
      for (const secretPresent of [true, false]) {
        const d = decidePhiStorage(input({ store, secretPresent, allowPlaintextPhi: true }));
        expect(d.verdict).toBe("plaintext_accepted");
        expect(d.mayServe).toBe(true);
      }
    });
  }

  it("still says it out loud — the flag buys a boot, not silence", () => {
    const d = decidePhiStorage(input({ store: "pg", allowPlaintextPhi: true }));
    expect(d.detail).toContain("plaintext");
    expect(d.detail).toContain("Patient.mrn");
  });
});

describe("decidePhiStorage — detail", () => {
  const many: readonly PhiField[] = Array.from({ length: DETAIL_FIELD_LIMIT + 2 }, (_, i) => ({
    entity: "Patient",
    field: `f${i.toString()}`,
    classification: "phi",
  }));

  it("carries every surveyed field on the decision even when the detail truncates", () => {
    const d = decidePhiStorage(input({ phiFields: many, secretPresent: false }));
    expect(d.fields).toEqual(many);
  });

  it("names at most DETAIL_FIELD_LIMIT pairs, summarises the rest and states the total", () => {
    const d = decidePhiStorage(input({ phiFields: many, secretPresent: false }));
    expect(d.detail).toContain("Patient.f0");
    expect(d.detail).toContain(`Patient.f${(DETAIL_FIELD_LIMIT - 1).toString()}`);
    expect(d.detail).not.toContain(`Patient.f${DETAIL_FIELD_LIMIT.toString()}`);
    expect(d.detail).toContain("(+2 more)");
    expect(d.detail).toContain(many.length.toString());
  });

  it("names the field and nothing resembling a value", () => {
    const d = decidePhiStorage(input({ phiFields: [PHI], secretPresent: false }));
    expect(d.detail).toContain("Patient.mrn");
    expect(d.detail).not.toContain("MRN-");
    expect(d.detail).not.toContain(SECRET);
  });
});

describe("formatPhiStorageDecision", () => {
  it("leads with the verdict for no_phi so a boot log is greppable", () => {
    const line = formatPhiStorageDecision(decidePhiStorage(input({ phiFields: [] })));
    expect(line.startsWith("phi storage: no_phi")).toBe(true);
    expect(line).not.toContain("REFUSED");
  });

  it("formats encrypted", () => {
    const line = formatPhiStorageDecision(decidePhiStorage(input({ secretPresent: true })));
    expect(line).toContain("encrypted");
    expect(line).not.toContain("REFUSED");
  });

  it("formats plaintext_accepted without shouting, since it was asked for", () => {
    const line = formatPhiStorageDecision(
      decidePhiStorage(input({ store: "pg", allowPlaintextPhi: true })),
    );
    expect(line).toContain("plaintext_accepted");
    expect(line).not.toContain("REFUSED");
  });

  it("formats refused_no_secret as a refusal", () => {
    const line = formatPhiStorageDecision(
      decidePhiStorage(input({ store: "pg-columns", secretPresent: false })),
    );
    expect(line).toContain("REFUSED");
    expect(line).toContain("refused_no_secret");
  });

  it("formats refused_plaintext_store as a refusal", () => {
    const line = formatPhiStorageDecision(decidePhiStorage(input({ store: "pg" })));
    expect(line).toContain("REFUSED");
    expect(line).toContain("refused_plaintext_store");
  });
});

describe("buildColumnKeySource", () => {
  afterEach(() => {
    vi.doUnmock("@crossengin/crypto");
    vi.resetModules();
  });

  it("refuses a short secret eagerly, naming too_short, at boot rather than on first write", () => {
    try {
      buildColumnKeySource("short");
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ColumnSecretRefused);
      expect((err as ColumnSecretRefused).reason).toBe("too_short");
    }
  });

  it("refuses a long but uniform secret as too_uniform", () => {
    try {
      buildColumnKeySource("ab".repeat(30));
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as ColumnSecretRefused).reason).toBe("too_uniform");
    }
  });

  it("puts no part of the secret in the refusal message", () => {
    const weak = "zz".repeat(30);
    try {
      buildColumnKeySource(weak);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as Error).message).not.toContain(weak);
      expect((err as Error).message).not.toContain("zzzz");
    }
  });

  it("derives a 32-byte key, base64-encoded for pgp_sym_encrypt's text key", () => {
    const key = keyFor(buildColumnKeySource(SECRET), TENANT_A);
    expect(key).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(key, "base64")).toHaveLength(32);
  });

  it("derives independent keys per tenant", () => {
    const source = buildColumnKeySource(SECRET);
    expect(source(TENANT_A)).not.toBe(source(TENANT_B));
  });

  it("derives the same key for one tenant across calls", () => {
    const source = buildColumnKeySource(SECRET);
    expect(source(TENANT_A)).toBe(source(TENANT_A));
  });

  it("derives a different key from a different secret", () => {
    const other = `${SECRET}-other-material`;
    expect(buildColumnKeySource(SECRET)(TENANT_A)).not.toBe(buildColumnKeySource(other)(TENANT_A));
  });

  it("never returns the secret itself", () => {
    expect(keyFor(buildColumnKeySource(SECRET), TENANT_A)).not.toContain(SECRET);
  });

  it("derives a different key per generation", () => {
    const g1 = buildColumnKeySource(SECRET, { generation: 1 })(TENANT_A);
    const g2 = buildColumnKeySource(SECRET, { generation: 2 })(TENANT_A);
    expect(g1).not.toBe(g2);
  });

  it("treats an omitted generation as the crypto package's default", () => {
    expect(buildColumnKeySource(SECRET)(TENANT_A)).toBe(
      buildColumnKeySource(SECRET, { generation: 1 })(TENANT_A),
    );
  });

  it("propagates the refusal of an empty tenant id rather than deriving a shared key", () => {
    const source = buildColumnKeySource(SECRET);
    expect(() => source("")).toThrow(/tenantId/);
  });

  it("propagates the refusal of an invalid generation", () => {
    expect(() => buildColumnKeySource(SECRET, { generation: 0 })(TENANT_A)).toThrow(/generation/);
  });

  it("derives once per tenant and serves the cached key afterwards", async () => {
    const derivedFor: string[] = [];
    vi.doMock("@crossengin/crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@crossengin/crypto")>();
      return {
        ...actual,
        deriveTenantColumnKey: (
          secret: Uint8Array,
          tenantId: string,
          generation?: number,
        ): string => {
          derivedFor.push(tenantId);
          return generation === undefined
            ? actual.deriveTenantColumnKey(secret, tenantId)
            : actual.deriveTenantColumnKey(secret, tenantId, generation);
        },
      };
    });
    const mod = await import("./column-encryption.js");
    const source = mod.buildColumnKeySource(SECRET);
    source(TENANT_A);
    source(TENANT_A);
    source(TENANT_B);
    source(TENANT_A);
    expect(derivedFor).toEqual([TENANT_A, TENANT_B]);
  });

  it("parses the secret once, before any key is asked for", async () => {
    let parses = 0;
    vi.doMock("@crossengin/crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@crossengin/crypto")>();
      return {
        ...actual,
        parseColumnEncryptionSecret: (raw: string): Uint8Array => {
          parses += 1;
          return actual.parseColumnEncryptionSecret(raw);
        },
      };
    });
    const mod = await import("./column-encryption.js");
    const source = mod.buildColumnKeySource(SECRET);
    expect(parses).toBe(1);
    source(TENANT_A);
    source(TENANT_B);
    expect(parses).toBe(1);
  });
});
