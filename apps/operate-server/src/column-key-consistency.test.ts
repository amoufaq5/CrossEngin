import {
  dataKeyWrapAad,
  deriveTenantKek,
  generateDataKey,
  parseColumnEncryptionSecret,
  wrapDataKey,
} from "@crossengin/crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { DataKeyProvenance } from "@crossengin/crypto-pg";
import type { PgConnection } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import {
  COLUMN_KEY_CONDITIONS,
  COLUMN_KEY_CONDITION_EFFECT,
  COLUMN_KEY_SURVEY_CEILING_BOUNDS,
  COLUMN_KEY_SURVEY_CEILING_FLAG,
  ColumnKeyConfigurationRefused,
  PER_TENANT_SURVEY_CEILING,
  SAMPLES_PER_GROUP,
  assessColumnKeyConsistency,
  checkKeylessCiphertext,
  formatColumnKeyConsistency,
  keylessCiphertextSecret,
  surveyColumnKeyConsistency,
  surveyDataKeyRows,
  type ColumnKeySurveyScope,
  type DataKeyRowGroup,
  type DataKeyRowSample,
  type DataKeyRowSurvey,
  type KeylessCiphertextCheck,
} from "./column-key-consistency.js";
import type { ColumnSecretRing } from "./column-secret-ring.js";
import { derivedSeed } from "./data-key-envelope.js";

const S1 = parseColumnEncryptionSecret("gen1-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789");
const S2 = parseColumnEncryptionSecret("gen2-secret-abcdefghijklmnopqrstuvwxyz-9876543210");
const S3 = parseColumnEncryptionSecret("gen3-secret-QWERTYUIOPASDFGHJKLZXCVBNM-5647382910");

const T = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

function ring(current: Uint8Array, currentGeneration = 1, previous: Uint8Array | null = null): ColumnSecretRing {
  return { current, currentGeneration, previous };
}

/** A row as a real store would have written it: `dek` wrapped under `wrapSecret` at `kekGeneration`. */
function sample(
  tenantId: string,
  opts: {
    readonly wrapSecret: Uint8Array;
    readonly kekGeneration?: number;
    readonly provenance?: DataKeyProvenance;
    readonly dek?: Uint8Array;
    readonly generation?: number;
  },
): DataKeyRowSample {
  const kekGeneration = opts.kekGeneration ?? 1;
  const generation = opts.generation ?? 1;
  const dek = opts.dek ?? generateDataKey();
  return {
    tenantId,
    generation,
    kekGeneration,
    provenance: opts.provenance ?? "random",
    wrappedKey: wrapDataKey(
      deriveTenantKek(opts.wrapSecret, tenantId, kekGeneration),
      dek,
      dataKeyWrapAad(tenantId, generation),
    ),
  };
}

function group(samples: readonly DataKeyRowSample[], tenants?: number): DataKeyRowGroup {
  const first = samples[0];
  if (first === undefined) throw new Error("a group needs a sample");
  return {
    provenance: first.provenance,
    kekGeneration: first.kekGeneration,
    tenants: tenants ?? samples.length,
    samples,
  };
}

function read(groups: readonly DataKeyRowGroup[], unexaminedTenants = 0): DataKeyRowSurvey {
  return {
    readable: true,
    route: "unconfined",
    groups,
    unexaminedTenants,
    incompleteReason: unexaminedTenants > 0 ? "stopped at the ceiling" : null,
    unreadable: [],
  };
}

function seededBy(secret: Uint8Array, tenantId: string): Uint8Array {
  return derivedSeed(secret, tenantId);
}

/** No at-rest column anywhere: the keyless-ciphertext half has nothing to say. */
const NO_CIPHERTEXT: KeylessCiphertextCheck = {
  checked: true,
  schema: "public",
  columns: 0,
  keyHeld: true,
  found: 0,
  opened: 0,
  unexaminedTenants: 0,
};

const DEPLOYMENT: ColumnKeySurveyScope = { kind: "deployment", ceiling: PER_TENANT_SURVEY_CEILING };

function assess(
  input: Omit<Parameters<typeof assessColumnKeyConsistency>[0], "ciphertext" | "scope"> & {
    readonly ciphertext?: KeylessCiphertextCheck;
    readonly scope?: ColumnKeySurveyScope;
  },
): ReturnType<typeof assessColumnKeyConsistency> {
  return assessColumnKeyConsistency({ ciphertext: NO_CIPHERTEXT, scope: DEPLOYMENT, ...input });
}

describe("COLUMN_KEY_CONDITION_EFFECT", () => {
  it("refuses exactly the conditions that make a tenant's keys or ciphertext unopenable", () => {
    expect(COLUMN_KEY_CONDITIONS.filter((c) => COLUMN_KEY_CONDITION_EFFECT[c] === "refuse")).toEqual([
      "ciphertext_key_mismatch",
      "derived_mode_over_random_keys",
      "derived_secret_not_seed",
      "kek_generation_unheld",
      "kek_secret_mismatch",
    ]);
  });

  it("never turns an unestablished fact into a refusal or an all-clear", () => {
    for (const c of [
      "ciphertext_unchecked",
      "seed_unverifiable",
      "survey_unreadable",
      "survey_incomplete",
    ] as const) {
      expect(COLUMN_KEY_CONDITION_EFFECT[c]).toBe("unknown");
    }
  });
});

describe("assessColumnKeyConsistency — derived mode", () => {
  it("is consistent with no key rows (control)", () => {
    const c = assess({ mode: "derived", ring: ring(S1), survey: read([]) });
    expect(c.verdict).toBe("consistent");
    expect(c.findings).toEqual([]);
    expect(formatColumnKeyConsistency(c)).toEqual([
      {
        level: "info",
        text: expect.stringContaining("no stored data key rows") as unknown as string,
      },
    ]);
  });

  it("refuses when any tenant's current key is a stored random key, naming the count", () => {
    const c = assess({
      mode: "derived",
      ring: ring(S1),
      survey: read([group([sample(T(1), { wrapSecret: S1 }), sample(T(2), { wrapSecret: S1 })], 7)]),
    });
    expect(c.verdict).toBe("refuse");
    expect(c.findings).toHaveLength(1);
    expect(c.findings[0]?.condition).toBe("derived_mode_over_random_keys");
    expect(c.findings[0]?.tenants).toBe(7);
    expect(c.findings[0]?.detail).toContain("--column-key-mode envelope");
  });

  it("refuses random keys even when their wrapping is under a generation it cannot open", () => {
    // The verdict is about provenance, not about whether derived mode could unwrap the row.
    const c = assess({
      mode: "derived",
      ring: ring(S1),
      survey: read([group([sample(T(1), { wrapSecret: S2, kekGeneration: 2 })])]),
    });
    expect(c.findings.map((f) => f.condition)).toEqual(["derived_mode_over_random_keys"]);
  });

  it("is consistent over seeded keys this secret derives — a rollback from an envelope trial (control)", () => {
    const rows = [T(1), T(2)].map((t) =>
      sample(t, { wrapSecret: S1, provenance: "seeded_from_derived", dek: seededBy(S1, t) }),
    );
    const c = assess({ mode: "derived", ring: ring(S1), survey: read([group(rows)]) });
    expect(c.verdict).toBe("consistent");
    expect(formatColumnKeyConsistency(c)[0]?.text).toContain("2 tenant(s) hold a stored data key");
  });

  it("refuses seeded keys at generation 1 that do not open under this secret", () => {
    // Seeded from and wrapped by S1, the generation-1 secret; the deployment now holds S2.
    const rows = [T(1), T(2), T(3)].map((t) =>
      sample(t, { wrapSecret: S1, provenance: "seeded_from_derived", dek: seededBy(S1, t) }),
    );
    const c = assess({ mode: "derived", ring: ring(S2), survey: read([group(rows, 40)]) });
    expect(c.verdict).toBe("refuse");
    expect(c.findings[0]?.condition).toBe("derived_secret_not_seed");
    expect(c.findings[0]?.tenants).toBe(40);
  });

  it("refuses a seeded key that opens under this secret but is not its derived key", () => {
    // After rotation 1 -> 2 the seeded rows were re-wrapped at generation 2; the operator then
    // switched back to derived mode holding the generation-2 secret, whose derived key differs.
    const rows = [T(1)].map((t) =>
      sample(t, {
        wrapSecret: S2,
        kekGeneration: 2,
        provenance: "seeded_from_derived",
        dek: seededBy(S1, t),
      }),
    );
    const c = assess({ mode: "derived", ring: ring(S2), survey: read([group(rows)]) });
    expect(c.findings.map((f) => f.condition)).toEqual(["derived_secret_not_seed"]);
  });

  it("reports corrupt seeded samples beside matching ones, and qualifies the consistent line", () => {
    const good = [T(1), T(2)].map((t) =>
      sample(t, { wrapSecret: S1, provenance: "seeded_from_derived", dek: seededBy(S1, t) }),
    );
    const bad = sample(T(3), { wrapSecret: S1, provenance: "seeded_from_derived", dek: seededBy(S1, T(3)) });
    const corrupt: DataKeyRowSample = { ...bad, wrappedKey: new Uint8Array(bad.wrappedKey.length) };
    const c = assess({ mode: "derived", ring: ring(S1), survey: read([group([...good, corrupt])]) });
    expect(c.verdict).toBe("consistent");
    expect(c.findings.map((f) => f.condition)).toEqual(["rows_unopenable"]);
    const lines = formatColumnKeyConsistency(c);
    expect(lines.find((l) => l.level === "warn")?.text).toContain("1 of 3");
    const info = lines.find((l) => l.level === "info")?.text ?? "";
    expect(info).not.toContain("every one is a seeded key");
    expect(info).toContain("the rows reported above did not open");
  });

  it("says unknown, not consistent, for seeded keys wrapped at a generation it holds no secret for", () => {
    // Re-wrapped under S2 at generation 2, and the deployment holds S1 — which is in fact their
    // seed secret, but the key rows cannot prove it.
    const rows = [T(1)].map((t) =>
      sample(t, {
        wrapSecret: S2,
        kekGeneration: 2,
        provenance: "seeded_from_derived",
        dek: seededBy(S1, t),
      }),
    );
    const c = assess({ mode: "derived", ring: ring(S1), survey: read([group(rows)]) });
    expect(c.verdict).toBe("unknown");
    expect(c.findings.map((f) => f.condition)).toEqual(["seed_unverifiable"]);
    expect(formatColumnKeyConsistency(c).every((l) => l.level !== "info")).toBe(true);
  });
});

describe("assessColumnKeyConsistency — envelope mode", () => {
  it("is consistent when a sample at every generation opens (control)", () => {
    const c = assess({
      mode: "envelope",
      ring: ring(S2, 2, S1),
      survey: read([
        group([sample(T(1), { wrapSecret: S1, kekGeneration: 1 })]),
        group([sample(T(2), { wrapSecret: S2, kekGeneration: 2 })]),
        group([sample(T(3), { wrapSecret: S2, kekGeneration: 2, provenance: "seeded_from_derived" })]),
      ]),
    });
    expect(c.verdict).toBe("consistent");
    expect(c.tenantsWithKeys).toBe(3);
  });

  it("refuses a bumped generation with no previous secret, naming the previous variable", () => {
    const c = assess({
      mode: "envelope",
      ring: ring(S2, 2),
      survey: read([group([sample(T(1), { wrapSecret: S1 })], 12)]),
    });
    expect(c.verdict).toBe("refuse");
    expect(c.findings[0]).toMatchObject({ condition: "kek_generation_unheld", tenants: 12, kekGeneration: 1 });
    expect(c.findings[0]?.detail).toContain("set COLUMN_ENCRYPTION_SECRET_PREVIOUS");
  });

  it("refuses rows two generations back with the re-wrap-forward remedy", () => {
    const c = assess({
      mode: "envelope",
      ring: ring(S3, 3, S2),
      survey: read([group([sample(T(1), { wrapSecret: S1 })])]),
    });
    expect(c.findings[0]?.condition).toBe("kek_generation_unheld");
    expect(c.findings[0]?.detail).toContain("COLUMN_ENCRYPTION_SECRET_GENERATION=2");
  });

  it("refuses rows newer than the ring as a rolled-back secret", () => {
    const c = assess({
      mode: "envelope",
      ring: ring(S1, 1),
      survey: read([group([sample(T(1), { wrapSecret: S2, kekGeneration: 2 })])]),
    });
    expect(c.findings[0]?.condition).toBe("kek_generation_unheld");
    expect(c.findings[0]?.detail).toContain("rolled back");
  });

  it("refuses a new secret at the same generation, which opens none of the rows", () => {
    const rows = [T(1), T(2), T(3)].map((t) => sample(t, { wrapSecret: S1 }));
    const c = assess({ mode: "envelope", ring: ring(S2), survey: read([group(rows, 9)]) });
    expect(c.verdict).toBe("refuse");
    expect(c.findings[0]).toMatchObject({ condition: "kek_secret_mismatch", tenants: 9, kekGeneration: 1 });
    expect(c.findings[0]?.detail).toContain("COLUMN_ENCRYPTION_SECRET_GENERATION=2");
  });

  it("names the previous variable when it is the previous secret that is wrong", () => {
    // Two samples, so "every one failed" is evidence about the secret rather than about one row —
    // the single-sample case is its own test below (ADR-0481).
    const c = assess({
      mode: "envelope",
      ring: ring(S2, 2, S3),
      survey: read([group([sample(T(1), { wrapSecret: S1 }), sample(T(2), { wrapSecret: S1 })])]),
    });
    expect(c.findings[0]?.condition).toBe("kek_secret_mismatch");
    expect(c.findings[0]?.detail).toContain("(COLUMN_ENCRYPTION_SECRET_PREVIOUS)");
    // The generation is already 2, so the remedy is the previous secret's value, not a rotation.
    expect(c.findings[0]?.detail).toContain(
      "Remedy: COLUMN_ENCRYPTION_SECRET_PREVIOUS is not the generation-1 secret: set it to the secret that wrapped these rows",
    );
    expect(c.findings[0]?.detail).not.toContain("COLUMN_ENCRYPTION_SECRET_GENERATION=");
  });

  it("does not advise a second rotation when the current secret is wrong mid-rotation", () => {
    const c = assess({
      mode: "envelope",
      ring: ring(S3, 2, S1),
      survey: read([group([sample(T(1), { wrapSecret: S2, kekGeneration: 2 })])]),
    });
    expect(c.findings[0]?.condition).toBe("kek_secret_mismatch");
    expect(c.findings[0]?.detail).toContain("COLUMN_ENCRYPTION_SECRET is not the generation-2 secret");
    expect(c.findings[0]?.detail).not.toContain("COLUMN_ENCRYPTION_SECRET_GENERATION=");
  });

  it("does not refuse when only a minority of a wide sample is corrupt", () => {
    // Three tenants corrupted their own rows (a tenant-context session may UPDATE its row); the
    // other samples open, so the secret is right.
    const corrupt = [T(1), T(2), T(3)].map((t) => {
      const r = sample(t, { wrapSecret: S1 });
      return { ...r, wrappedKey: new Uint8Array(r.wrappedKey.length) };
    });
    const good = [T(4), T(5)].map((t) => sample(t, { wrapSecret: S1 }));
    const c = assess({ mode: "envelope", ring: ring(S1), survey: read([group([...corrupt, ...good], 40)]) });
    expect(c.verdict).toBe("consistent");
    expect(c.findings.map((f) => f.condition)).toEqual(["rows_unopenable"]);
  });

  it("does not refuse the deployment over one corrupt row when the other samples open", () => {
    const good = [T(1), T(2)].map((t) => sample(t, { wrapSecret: S1 }));
    const bad = sample(T(3), { wrapSecret: S1 });
    const corrupt: DataKeyRowSample = { ...bad, wrappedKey: new Uint8Array(bad.wrappedKey.length) };
    const c = assess({
      mode: "envelope",
      ring: ring(S1),
      survey: read([group([...good, corrupt])]),
    });
    expect(c.verdict).toBe("consistent");
    expect(c.findings.map((f) => f.condition)).toEqual(["rows_unopenable"]);
    expect(formatColumnKeyConsistency(c).find((l) => l.level === "warn")?.text).toContain("1 of 3");
  });
});

describe("a single sample (ADR-0481)", () => {
  it("does not call one unopenable row a wrong secret, and names both remedies", () => {
    const c = assess({
      mode: "envelope",
      ring: ring(S2),
      survey: read([group([sample(T(1), { wrapSecret: S1 })])]),
    });
    expect(c.verdict).toBe("refuse");
    const detail = c.findings[0]?.detail ?? "";
    expect(c.findings[0]?.condition).toBe("kek_secret_mismatch");
    expect(detail).toContain("cannot tell a corrupt row from a wrong secret");
    expect(detail).toContain("Remedy, if the secret is wrong:");
    expect(detail).toContain("if the row is corrupt:");
    // The conclusive sentence is the one a single sample must not carry.
    expect(detail).not.toContain("so it is not the secret");
  });

  it("keeps the conclusive sentence when two samples both fail (the control)", () => {
    const rows = [T(1), T(2)].map((t) => sample(t, { wrapSecret: S1 }));
    const c = assess({ mode: "envelope", ring: ring(S2), survey: read([group(rows)]) });
    expect(c.findings[0]?.detail).toContain("so it is not the secret");
    expect(c.findings[0]?.detail).not.toContain("cannot tell");
  });

  it("is as careful in derived mode, where one seeded row that does not open proves nothing", () => {
    const c = assess({
      mode: "derived",
      ring: ring(S2),
      survey: read([group([sample(T(1), { wrapSecret: S1, provenance: "seeded_from_derived" })])]),
    });
    expect(c.findings[0]?.condition).toBe("derived_secret_not_seed");
    expect(c.findings[0]?.detail).toContain("cannot tell a corrupt row from a wrong secret");
  });
});

describe("the key-provenance line (ADR-0481)", () => {
  const twoRandomOneSeeded = () =>
    read([
      group([sample(T(1), { wrapSecret: S1 }), sample(T(2), { wrapSecret: S1 })]),
      group([sample(T(3), { wrapSecret: S1, provenance: "seeded_from_derived" })]),
    ]);

  it("counts each provenance and says what destroying it buys, with no tenant id", () => {
    const c = assess({ mode: "envelope", ring: ring(S1), survey: twoRandomOneSeeded() });
    const line = formatColumnKeyConsistency(c).find((l) => l.text.includes("key provenance"));
    expect(line).toEqual({
      level: "info",
      text:
        "column keys: key provenance — 2 tenant(s) random (shreddable), 1 tenant(s) seeded_from_derived " +
        "(derivable; run operate-server rekey per tenant)",
    });
    for (const n of [1, 2, 3]) expect(line?.text).not.toContain(T(n));
  });

  it("says the counts are lower bounds when the survey did not examine every tenant", () => {
    const c = assess({ mode: "envelope", ring: ring(S1), survey: read([group([sample(T(1), { wrapSecret: S1 })])], 4) });
    const line = formatColumnKeyConsistency(c).find((l) => l.text.includes("key provenance"));
    expect(line?.text).toContain("4 tenant(s) not examined, so these are lower bounds");
  });

  it("is absent in derived mode, for a tenant scope, and over an unreadable survey", () => {
    const has = (c: ReturnType<typeof assess>) =>
      formatColumnKeyConsistency(c).some((l) => l.text.includes("key provenance"));
    expect(has(assess({ mode: "derived", ring: ring(S1), survey: read([]) }))).toBe(false);
    expect(
      has(assess({ mode: "envelope", ring: ring(S1), survey: twoRandomOneSeeded(), scope: { kind: "tenant", tenantId: T(1) } })),
    ).toBe(false);
    expect(has(assess({ mode: "envelope", ring: ring(S1), survey: { readable: false, reason: "x" } }))).toBe(false);
  });
});

describe("assessColumnKeyConsistency — the survey's own limits", () => {
  it("is unknown when the table could not be read", () => {
    const c = assess({
      mode: "envelope",
      ring: ring(S1),
      survey: { readable: false, reason: "this role may not SELECT meta.tenant_data_keys" },
    });
    expect(c.verdict).toBe("unknown");
    expect(c.findings[0]?.condition).toBe("survey_unreadable");
    expect(formatColumnKeyConsistency(c).map((l) => l.level)).toEqual(["warn"]);
  });

  it("is unknown when tenants were not examined, and says how many", () => {
    const c = assess({
      mode: "envelope",
      ring: ring(S1),
      survey: read([group([sample(T(1), { wrapSecret: S1 })])], 250),
    });
    expect(c.verdict).toBe("unknown");
    expect(c.findings.at(-1)).toMatchObject({ condition: "survey_incomplete", tenants: 250 });
  });

  it("still refuses what it did examine when the survey is incomplete", () => {
    const c = assess({
      mode: "envelope",
      ring: ring(S2),
      survey: read([group([sample(T(1), { wrapSecret: S1 })])], 250),
    });
    expect(c.verdict).toBe("refuse");
  });
});

describe("ColumnKeyConfigurationRefused", () => {
  it("carries the refusal lines and no secret or key material", () => {
    const dek = generateDataKey();
    const c = assess({
      mode: "envelope",
      ring: ring(S2),
      survey: read([group([sample(T(1), { wrapSecret: S1, dek })])]),
    });
    const err = new ColumnKeyConfigurationRefused(c);
    expect(err.message).toContain("KEK_SECRET_MISMATCH");
    expect(err.message).toContain("REFUSED");
    for (const material of [S1, S2, dek]) {
      expect(err.message).not.toContain(Buffer.from(material).toString("base64"));
      expect(err.message).not.toContain(Buffer.from(material).toString("hex"));
      expect(err.message).not.toContain(Buffer.from(material).toString("utf8"));
    }
    expect(err.message).not.toContain(T(1));
  });
});

// ---------------------------------------------------------------------------------------------
// The survey, against a fake that answers each statement by recognising it.

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface FakeOptions {
  readonly exists?: boolean;
  readonly canSelect?: boolean;
  readonly confined?: boolean;
  /** Each tenant's current key row, by tenant id. */
  readonly rows?: readonly DataKeyRowSample[];
  /** Tenants in `meta.tenants`, including ones holding no key row. */
  readonly tenants?: readonly string[];
  readonly throwOn?: "catalog" | "keys";
}

function rowOf(s: DataKeyRowSample): Record<string, unknown> {
  return {
    tenant_id: s.tenantId,
    generation: s.generation,
    wrapped_key: Buffer.from(s.wrappedKey),
    kek_generation: s.kekGeneration,
    provenance: s.provenance,
  };
}

function fakeDb(opts: FakeOptions = {}): { conn: PgConnection; captured: Captured[] } {
  const captured: Captured[] = [];
  const rows = opts.rows ?? [];
  let context: string | null = null;
  const run = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    assertBindArity(sql, params);
    captured.push({ sql, params });
    const answer = (out: Record<string, unknown>[]) => ({ rows: out, rowCount: out.length });
    if (sql.includes("set_config")) {
      context = String(params[0]);
      return answer([{ set_config: context }]);
    }
    if (sql.includes("has_table_privilege")) {
      if (opts.throwOn === "catalog") throw new Error("connection refused");
      const exists = opts.exists ?? true;
      return answer([{ table_exists: exists, can_select: exists && (opts.canSelect ?? true) }]);
    }
    if (sql.includes("row_security_active")) {
      return answer([
        {
          role: "crossengin_app",
          policies_active: opts.confined ?? false,
          bypasses_rls: false,
          is_owner: false,
          rls_enabled: true,
          rls_forced: false,
        },
      ]);
    }
    if (opts.throwOn === "keys" && sql.includes("tenant_data_keys")) {
      throw new Error("permission denied for table tenant_data_keys");
    }
    if (sql.includes("count(*) AS n FROM meta.tenants")) {
      return answer([{ n: String((opts.tenants ?? []).length) }]);
    }
    if (sql.includes("SELECT id FROM meta.tenants")) {
      const limit = Number(params[0]);
      return answer([...(opts.tenants ?? [])].sort().slice(0, limit).map((id) => ({ id })));
    }
    if (sql.includes("WHERE tenant_id = $1")) {
      // The isolation policy: a confined session sees only the row of the tenant in context.
      const visible = rows.filter((r) => r.tenantId === params[0] && (!opts.confined || r.tenantId === context));
      return answer(visible.map(rowOf));
    }
    if (sql.includes("GROUP BY provenance, kek_generation")) {
      const seen = opts.confined ? [] : rows;
      const counts = new Map<string, { provenance: string; kek_generation: number; tenants: string }>();
      for (const r of seen) {
        const k = `${r.provenance}|${r.kekGeneration.toString()}`;
        const prev = counts.get(k);
        counts.set(k, {
          provenance: r.provenance,
          kek_generation: r.kekGeneration,
          tenants: String(Number(prev?.tenants ?? 0) + 1),
        });
      }
      return answer([...counts.values()]);
    }
    if (sql.includes("row_number()")) {
      const seen = opts.confined ? [] : rows;
      const limit = Number(params[0]);
      const ranked = new Map<string, number>();
      const out: Record<string, unknown>[] = [];
      for (const r of [...seen].sort((a, b) => a.tenantId.localeCompare(b.tenantId))) {
        const k = `${r.provenance}|${r.kekGeneration.toString()}`;
        const n = (ranked.get(k) ?? 0) + 1;
        ranked.set(k, n);
        if (n <= limit) out.push(rowOf(r));
      }
      return answer(out);
    }
    throw new Error(`fake: unexpected statement ${sql}`);
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
      try {
        return await fn(conn);
      } finally {
        context = null;
      }
    },
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };
  return { conn, captured };
}

describe("surveyDataKeyRows", () => {
  it("answers an absent table as no rows, conclusively", async () => {
    const { conn } = fakeDb({ exists: false });
    const s = await surveyDataKeyRows(conn);
    expect(s).toMatchObject({ readable: true, groups: [], unexaminedTenants: 0 });
  });

  it("is unreadable when this role may not SELECT the table", async () => {
    const { conn } = fakeDb({ canSelect: false });
    const s = await surveyDataKeyRows(conn);
    expect(s.readable).toBe(false);
  });

  it("is unreadable, never throws, when the database refuses", async () => {
    const { conn } = fakeDb({ throwOn: "catalog" });
    await expect(surveyDataKeyRows(conn)).resolves.toMatchObject({ readable: false });
  });

  it("refuses an invalid schema identifier without issuing SQL", async () => {
    const { conn, captured } = fakeDb();
    const s = await surveyDataKeyRows(conn, { schema: "meta; drop" });
    expect(s.readable).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it("reads every tenant in one pass when the session is not confined", async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => sample(T(n), { wrapSecret: S1 }));
    const { conn, captured } = fakeDb({ rows });
    const s = await surveyDataKeyRows(conn);
    expect(s.readable && s.route).toBe("unconfined");
    if (!s.readable) throw new Error("unreachable");
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]?.tenants).toBe(5);
    expect(SAMPLES_PER_GROUP).toBeGreaterThanOrEqual(5);
    expect(s.groups[0]?.samples).toHaveLength(5);
    // Samples are drawn at random, so the same tenants' rows do not decide every boot.
    expect(captured.find((c) => c.sql.includes("row_number()"))?.sql).toContain("ORDER BY random()");
    expect(captured.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("reads each tenant under its own context when confined, instead of trusting an unscoped zero", async () => {
    const rows = [sample(T(1), { wrapSecret: S1 }), sample(T(3), { wrapSecret: S1, provenance: "seeded_from_derived" })];
    const { conn, captured } = fakeDb({ confined: true, rows, tenants: [T(1), T(2), T(3)] });
    const s = await surveyDataKeyRows(conn);
    if (!s.readable) throw new Error(s.reason);
    expect(s.route).toBe("per_tenant");
    expect(s.groups.map((g) => [g.provenance, g.tenants]).sort()).toEqual([
      ["random", 1],
      ["seeded_from_derived", 1],
    ]);
    const contexts = captured.filter((c) => c.sql.includes("set_config")).map((c) => c.params[0]);
    expect(contexts).toEqual([T(1), T(2), T(3)]);
    // The unscoped aggregate a confined role would read as zero is never asked.
    expect(captured.some((c) => c.sql.includes("GROUP BY"))).toBe(false);
  });

  it("the confined route feeds a refusal the unscoped read would have missed", async () => {
    const rows = [sample(T(1), { wrapSecret: S1 })];
    const confined = await surveyDataKeyRows(fakeDb({ confined: true, rows, tenants: [T(1)] }).conn);
    expect(assess({ mode: "derived", ring: ring(S1), survey: confined }).verdict).toBe(
      "refuse",
    );
  });

  it("stops at the ceiling and reports the unexamined tenants", async () => {
    const tenants = [1, 2, 3, 4, 5].map(T);
    const rows = tenants.map((t) => sample(t, { wrapSecret: S1 }));
    const { conn, captured } = fakeDb({ confined: true, rows, tenants });
    const s = await surveyDataKeyRows(conn, { ceiling: 2 });
    if (!s.readable) throw new Error(s.reason);
    expect(s.unexaminedTenants).toBe(3);
    expect(s.incompleteReason).toContain("stops at 2 tenants");
    expect(captured.filter((c) => c.sql.includes("set_config"))).toHaveLength(2);
  });

  it("asks for one tenant past the ceiling, so exactly-at-the-ceiling is complete", async () => {
    const tenants = [1, 2].map(T);
    const { conn } = fakeDb({ confined: true, rows: [], tenants });
    const s = await surveyDataKeyRows(conn, { ceiling: 2 });
    if (!s.readable) throw new Error(s.reason);
    expect(s.unexaminedTenants).toBe(0);
  });

  it("defaults the ceiling to PER_TENANT_SURVEY_CEILING", async () => {
    const { conn, captured } = fakeDb({ confined: true, tenants: [] });
    await surveyDataKeyRows(conn);
    const tenantRead = captured.find((c) => c.sql.includes("SELECT id FROM meta.tenants"));
    expect(tenantRead?.params).toEqual([PER_TENANT_SURVEY_CEILING + 1]);
  });

  it("keeps a malformed key row as a finding instead of losing the survey to it", async () => {
    const good = sample(T(1), { wrapSecret: S1 });
    const broken = sample(T(2), { wrapSecret: S1 });
    const { conn } = fakeDb({ rows: [good, { ...broken, provenance: "bogus" as DataKeyProvenance }] });
    const s = await surveyDataKeyRows(conn);
    if (!s.readable) throw new Error(s.reason);
    expect(s.unreadable).toHaveLength(2); // the sample row and its count row
    expect(s.groups.find((g) => g.provenance === "random")?.samples).toHaveLength(1);
    const c = assess({ mode: "envelope", ring: ring(S1), survey: s });
    expect(c.verdict).toBe("unknown");
    expect(c.findings.map((f) => f.condition)).toEqual(["rows_unreadable"]);
    expect(c.findings[0]?.detail).not.toContain("bogus");
  });

  it("keeps a malformed key row on the confined route too", async () => {
    const broken = sample(T(2), { wrapSecret: S1 });
    const { conn } = fakeDb({
      confined: true,
      tenants: [T(1), T(2)],
      rows: [sample(T(1), { wrapSecret: S1 }), { ...broken, kekGeneration: Number.NaN }],
    });
    const s = await surveyDataKeyRows(conn);
    if (!s.readable) throw new Error(s.reason);
    expect(s.unreadable).toHaveLength(1);
    expect(s.groups[0]?.tenants).toBe(1);
  });

  it("draws the confined route's samples across the whole group, not the first tenants by id", async () => {
    // The first 35 tenants' rows are corrupt and the last 5 are sound. A fixed first-N sample would
    // see only corrupt rows and call the secret wrong; the reservoir lets later tenants in.
    const tenants = Array.from({ length: 40 }, (_, i) => T(i + 1));
    const rows = tenants.map((t, i) => {
      const r = sample(t, { wrapSecret: S1 });
      return i < 35 ? { ...r, wrappedKey: new Uint8Array(r.wrappedKey.length) } : r;
    });
    const s = await surveyDataKeyRows(fakeDb({ confined: true, rows, tenants }).conn, { random: () => 0 });
    if (!s.readable) throw new Error(s.reason);
    expect(s.groups[0]?.tenants).toBe(40);
    expect(s.groups[0]?.samples).toHaveLength(SAMPLES_PER_GROUP);
    expect(s.groups[0]?.samples.map((x) => x.tenantId)).toContain(T(40));
    const c = assess({ mode: "envelope", ring: ring(S1), survey: s });
    expect(c.verdict).toBe("consistent");
    expect(c.findings.map((f) => f.condition)).toEqual(["rows_unopenable"]);
  });

  it("is unreadable when a key row read fails", async () => {
    const { conn } = fakeDb({ throwOn: "keys" });
    await expect(surveyDataKeyRows(conn)).resolves.toMatchObject({ readable: false });
  });
});

// ---------------------------------------------------------------------------------------------
// Tenants with no key row: the one question the key rows cannot answer.

describe("assessColumnKeyConsistency — ciphertext of tenants with no key row", () => {
  const checked = (over: Partial<Extract<KeylessCiphertextCheck, { checked: true }>>): KeylessCiphertextCheck => ({
    ...(NO_CIPHERTEXT as Extract<KeylessCiphertextCheck, { checked: true }>),
    columns: 4,
    ...over,
  });

  it("refuses derived mode with no key rows whose ciphertext opens under none of its keys — a replaced secret", () => {
    const c = assess({ mode: "derived", ring: ring(S2), survey: read([]), ciphertext: checked({ found: 3, opened: 0 }) });
    expect(c.verdict).toBe("refuse");
    expect(c.findings.map((f) => f.condition)).toEqual(["ciphertext_key_mismatch"]);
    expect(c.findings[0]?.detail).toContain("3 tenant(s) sampled in public");
    expect(formatColumnKeyConsistency(c).some((l) => l.level === "info")).toBe(false);
  });

  it("refuses envelope mode for the same reason, naming the permanent seed", () => {
    const c = assess({ mode: "envelope", ring: ring(S2), survey: read([]), ciphertext: checked({ found: 1, opened: 0 }) });
    expect(c.verdict).toBe("refuse");
    expect(c.findings[0]?.detail).toContain("seeds each such tenant's first data key from — permanently");
  });

  it("is consistent when keyless ciphertext opens, and says what was checked (control)", () => {
    const c = assess({ mode: "derived", ring: ring(S1), survey: read([]), ciphertext: checked({ found: 1, opened: 1 }) });
    expect(c.verdict).toBe("consistent");
    const info = formatColumnKeyConsistency(c).find((l) => l.level === "info")?.text ?? "";
    expect(info).toContain("no stored data key rows");
    expect(info).toContain("opened under the key this configuration reads it with");
  });

  it("says so when no tenant without a key row holds ciphertext (control)", () => {
    const c = assess({ mode: "derived", ring: ring(S1), survey: read([]), ciphertext: checked({}) });
    expect(formatColumnKeyConsistency(c)[0]?.text).toContain("no tenant without a key row holds ciphertext in public");
  });

  it("warns and does not refuse when the ring no longer holds the seed secret", () => {
    const c = assess({
      mode: "envelope",
      ring: ring(S3, 3, S2),
      survey: read([]),
      ciphertext: checked({ keyHeld: false, found: 1, opened: 0 }),
    });
    expect(c.verdict).toBe("consistent");
    expect(c.findings.map((f) => f.condition)).toEqual(["ciphertext_seed_unheld"]);
    expect(formatColumnKeyConsistency(c).find((l) => l.level === "info")?.text).toContain("cannot read");
  });

  it("reports a corrupt keyless value beside one that opened", () => {
    const c = assess({ mode: "derived", ring: ring(S1), survey: read([]), ciphertext: checked({ found: 2, opened: 1 }) });
    expect(c.verdict).toBe("consistent");
    expect(c.findings.map((f) => f.condition)).toEqual(["rows_unopenable"]);
  });

  it("is unknown, never an all-clear, when the check could not run", () => {
    const c = assess({
      mode: "derived",
      ring: ring(S1),
      survey: read([]),
      ciphertext: { checked: false, reason: "function pgp_sym_decrypt_bytea(bytea, text) does not exist" },
    });
    expect(c.verdict).toBe("unknown");
    expect(c.findings.map((f) => f.condition)).toEqual(["ciphertext_unchecked"]);
    expect(formatColumnKeyConsistency(c).every((l) => l.level === "warn")).toBe(true);
  });

  it("is unknown when the scan stopped at its ceiling with nothing decided", () => {
    const c = assess({ mode: "derived", ring: ring(S1), survey: read([]), ciphertext: checked({ unexaminedTenants: 9 }) });
    expect(c.verdict).toBe("unknown");
    expect(c.findings.at(-1)).toMatchObject({ condition: "survey_incomplete", tenants: 9 });
  });

  it("still reports a keyless mismatch when the key table could not be read", () => {
    const c = assess({
      mode: "derived",
      ring: ring(S2),
      survey: { readable: false, reason: "this role may not SELECT meta.tenant_data_keys" },
      ciphertext: checked({ found: 2, opened: 0 }),
    });
    expect(c.verdict).toBe("refuse");
  });

  it("chooses the secret the ciphertext would be read under", () => {
    expect(keylessCiphertextSecret("derived", ring(S2, 1))).toBe(S2);
    expect(keylessCiphertextSecret("envelope", ring(S1, 1))).toBe(S1);
    expect(keylessCiphertextSecret("envelope", ring(S2, 2, S1))).toBe(S1);
    expect(keylessCiphertextSecret("envelope", ring(S3, 3, S2))).toBeNull();
  });
});

interface CipherFakeOptions {
  readonly confined?: boolean;
  readonly columns?: readonly { readonly table: string; readonly column: string }[];
  /** Keyless tenants' ciphertext: each value records the key that opens it. */
  readonly ciphertext?: readonly { readonly tenantId: string; readonly openedBy: string }[];
  readonly tenants?: readonly string[];
  readonly decryptCode?: string;
}

function fakeCipherDb(opts: CipherFakeOptions = {}): { conn: PgConnection; captured: Captured[] } {
  const captured: Captured[] = [];
  const columns = opts.columns ?? [{ table: "patient", column: "mrn" }];
  const values = opts.ciphertext ?? [];
  let context: string | null = null;
  const run = async (sql: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    assertBindArity(sql, params);
    captured.push({ sql, params });
    const answer = (out: Record<string, unknown>[]) => ({ rows: out, rowCount: out.length });
    if (sql.includes("set_config")) {
      context = String(params[0]);
      return answer([]);
    }
    if (sql.includes("SAVEPOINT")) return answer([]);
    if (sql.includes("crossengin.encrypt=at_rest")) {
      return answer(
        columns.map((c) => ({
          schema: "public",
          table_name: c.table,
          column_name: c.column,
          data_type: "bytea",
          comment: "crossengin.encrypt=at_rest",
        })),
      );
    }
    if (sql.includes("to_regclass")) return answer([{ present: true }]);
    if (sql.includes("row_security_active")) {
      return answer([
        {
          role: "crossengin_app",
          policies_active: opts.confined ?? false,
          bypasses_rls: false,
          is_owner: false,
          rls_enabled: true,
          rls_forced: false,
        },
      ]);
    }
    if (sql.includes("pgp_sym_decrypt_bytea")) {
      if (opts.decryptCode !== undefined) throw Object.assign(new Error("decrypt failed"), { code: opts.decryptCode });
      const value = JSON.parse(Buffer.from(params[0] as Uint8Array).toString("utf8")) as { openedBy: string };
      if (value.openedBy !== params[1]) throw Object.assign(new Error("Wrong key or corrupt data"), { code: "39000" });
      return answer([{ n: 12 }]);
    }
    if (sql.includes("SELECT id FROM meta.tenants")) {
      return answer([...(opts.tenants ?? [])].slice(0, Number(params[0])).map((id) => ({ id })));
    }
    if (sql.includes("count(*) AS n FROM meta.tenants")) return answer([{ n: (opts.tenants ?? []).length }]);
    const blob = (v: { tenantId: string; openedBy: string }) => Buffer.from(JSON.stringify(v), "utf8");
    if (sql.startsWith("SELECT ciphertext FROM (")) {
      const t = String(params[0]);
      const visible = values.filter((v) => v.tenantId === t && (!opts.confined || t === context));
      return answer(visible.slice(0, 1).map((v) => ({ ciphertext: blob(v) })));
    }
    if (sql.includes("t.tenant_id::text")) {
      const seen = opts.confined ? [] : values;
      return answer(seen.slice(0, Number(params[0])).map((v) => ({ tenant_id: v.tenantId, ciphertext: blob(v) })));
    }
    throw new Error(`fake: unexpected statement ${sql}`);
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
      try {
        return await fn(conn);
      } finally {
        context = null;
      }
    },
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };
  return { conn, captured };
}

const keyOf = (secret: Uint8Array, tenantId: string): string => Buffer.from(derivedSeed(secret, tenantId)).toString("base64");

describe("checkKeylessCiphertext", () => {
  const under = (secret: Uint8Array, ...tenants: string[]) =>
    tenants.map((t) => ({ tenantId: t, openedBy: keyOf(secret, t) }));

  it("opens keyless ciphertext under the right secret and stops at the first that opens", async () => {
    const { conn, captured } = fakeCipherDb({ ciphertext: under(S1, T(1), T(2)) });
    const c = await checkKeylessCiphertext(conn, { bootSchema: "public", secret: S1 });
    expect(c).toMatchObject({ checked: true, columns: 1, found: 1, opened: 1, keyHeld: true });
    expect(captured.filter((x) => x.sql.includes("pgp_sym_decrypt_bytea"))).toHaveLength(1);
    // Only tenants with no key row are asked, and the plaintext never comes back.
    expect(captured.find((x) => x.sql.includes("t.tenant_id::text"))?.sql).toContain("NOT EXISTS");
    expect(captured.find((x) => x.sql.includes("pgp_sym_decrypt_bytea"))?.sql).toContain("octet_length");
  });

  it("finds a replaced generation-1 secret that no key row could reveal", async () => {
    const { conn } = fakeCipherDb({ ciphertext: under(S1, T(1), T(2), T(3)) });
    const c = await checkKeylessCiphertext(conn, { bootSchema: "public", secret: S2 });
    expect(c).toMatchObject({ checked: true, found: 3, opened: 0 });
    expect(assess({ mode: "derived", ring: ring(S2), survey: read([]), ciphertext: c }).verdict).toBe("refuse");
  });

  it("takes one value per tenant, so one tenant's many rows do not fill the sample", async () => {
    const values = [...under(S1, T(1)), ...under(S1, T(1)), ...under(S1, T(1)), ...under(S1, T(2))];
    const { conn } = fakeCipherDb({ ciphertext: values.map((v, i) => (i < 3 ? { ...v, openedBy: "corrupt" } : v)) });
    const c = await checkKeylessCiphertext(conn, { bootSchema: "public", secret: S1 });
    expect(c).toMatchObject({ found: 2, opened: 1 });
  });

  it("issues no decrypt when the ring holds no seed secret, and says ciphertext was found", async () => {
    const { conn, captured } = fakeCipherDb({ ciphertext: under(S1, T(1)) });
    const c = await checkKeylessCiphertext(conn, { bootSchema: "public", secret: null });
    expect(c).toMatchObject({ checked: true, keyHeld: false, found: 1, opened: 0 });
    expect(captured.some((x) => x.sql.includes("pgp_sym_decrypt_bytea"))).toBe(false);
  });

  it("answers no columns without reading a row (control)", async () => {
    const { conn, captured } = fakeCipherDb({ columns: [] });
    const c = await checkKeylessCiphertext(conn, { bootSchema: "public", secret: S1 });
    expect(c).toMatchObject({ checked: true, columns: 0, found: 0 });
    expect(captured).toHaveLength(1);
  });

  it("is unchecked, never throws, when pgcrypto is absent", async () => {
    const { conn } = fakeCipherDb({ ciphertext: under(S1, T(1)), decryptCode: "42883" });
    await expect(checkKeylessCiphertext(conn, { bootSchema: "public", secret: S1 })).resolves.toMatchObject({
      checked: false,
    });
  });

  it("refuses an invalid schema identifier without issuing SQL", async () => {
    const { conn, captured } = fakeCipherDb();
    const c = await checkKeylessCiphertext(conn, { bootSchema: "public; drop", secret: S1 });
    expect(c.checked).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it("reads each tenant under its own context when confined, decrypting inside a savepoint", async () => {
    const { conn, captured } = fakeCipherDb({
      confined: true,
      tenants: [T(1), T(2), T(3)],
      ciphertext: [...under(S1, T(2)), ...under(S1, T(3))],
    });
    const c = await checkKeylessCiphertext(conn, { bootSchema: "public", secret: S1 });
    expect(c).toMatchObject({ checked: true, found: 1, opened: 1, unexaminedTenants: 0 });
    expect(captured.filter((x) => x.sql.includes("set_config")).map((x) => x.params[0])).toEqual([T(1), T(2)]);
    expect(captured.some((x) => x.sql.includes("RELEASE SAVEPOINT"))).toBe(true);
    expect(captured.some((x) => x.sql.includes("t.tenant_id::text"))).toBe(false);
  });

  it("rolls back to the savepoint on a wrong key and keeps scanning (confined)", async () => {
    const { conn, captured } = fakeCipherDb({
      confined: true,
      tenants: [T(1), T(2)],
      ciphertext: under(S1, T(1), T(2)),
    });
    const c = await checkKeylessCiphertext(conn, { bootSchema: "public", secret: S2 });
    expect(c).toMatchObject({ found: 2, opened: 0, unexaminedTenants: 0 });
    expect(captured.filter((x) => x.sql.includes("ROLLBACK TO SAVEPOINT"))).toHaveLength(2);
  });

  it("reports unexamined tenants when the confined scan stops at its ceiling with nothing decided", async () => {
    const tenants = [1, 2, 3, 4].map(T);
    const { conn } = fakeCipherDb({ confined: true, tenants });
    const c = await checkKeylessCiphertext(conn, { bootSchema: "public", secret: S1, ceiling: 2 });
    expect(c).toMatchObject({ checked: true, found: 0, unexaminedTenants: 2 });
  });
});

// ---------------------------------------------------------------------------------------------
// ADR-0460: one tenant's scope (the rekey's pre-flight) and the boot survey's ceiling.

/**
 * Both fakes behind one connection, routed by statement. The ciphertext statements are recognised
 * first because the keyless sample's per-column branch also reads `WHERE tenant_id = $1`, which the
 * key fake would otherwise answer with key rows.
 */
function fakeBoth(keys: FakeOptions, cipher: CipherFakeOptions): { conn: PgConnection; captured: Captured[] } {
  const k = fakeDb(keys);
  const c = fakeCipherDb(cipher);
  const captured: Captured[] = [];
  const isCipher = (sql: string): boolean =>
    sql.startsWith("SELECT ciphertext FROM (") ||
    sql.includes("crossengin.encrypt=at_rest") ||
    sql.includes("pgp_sym_decrypt_bytea") ||
    sql.includes("SAVEPOINT") ||
    (sql.includes("to_regclass") && !sql.includes("has_table_privilege"));
  const run = async (sql: string, params: readonly unknown[] = []) => {
    captured.push({ sql, params });
    if (sql.includes("set_config")) {
      await c.conn.query(sql, [...params]);
      return k.conn.query(sql, [...params]);
    }
    return isCipher(sql) ? c.conn.query(sql, [...params]) : k.conn.query(sql, [...params]);
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };
  return { conn, captured };
}

describe("a tenant scope (ADR-0460)", () => {
  it("reads only the named tenant, under its own context, even when the session is not confined", async () => {
    const rows = [sample(T(1), { wrapSecret: S1 }), sample(T(2), { wrapSecret: S2 })];
    const { conn, captured } = fakeDb({ rows, tenants: [T(1), T(2)] });
    const s = await surveyDataKeyRows(conn, { tenantId: T(1) });
    if (!s.readable) throw new Error(s.reason);
    expect(s.route).toBe("per_tenant");
    expect(s.groups.map((g) => g.tenants)).toEqual([1]);
    expect(s.groups[0]?.samples.map((x) => x.tenantId)).toEqual([T(1)]);
    expect(captured.filter((c) => c.sql.includes("set_config")).map((c) => c.params[0])).toEqual([T(1)]);
    // Neither the tenant list nor the confinement probe is asked: the read is the same either way.
    expect(captured.some((c) => c.sql.includes("FROM meta.tenants"))).toBe(false);
    expect(captured.some((c) => c.sql.includes("row_security_active"))).toBe(false);
  });

  it("asks one tenant's keyless ciphertext under its own context, confined or not", async () => {
    const { conn, captured } = fakeCipherDb({
      ciphertext: [
        { tenantId: T(1), openedBy: keyOf(S1, T(1)) },
        { tenantId: T(2), openedBy: keyOf(S2, T(2)) },
      ],
    });
    const c = await checkKeylessCiphertext(conn, { bootSchema: "public", secret: S1, tenantId: T(1) });
    expect(c).toMatchObject({ checked: true, found: 1, opened: 1, unexaminedTenants: 0 });
    expect(captured.filter((x) => x.sql.includes("set_config")).map((x) => x.params[0])).toEqual([T(1)]);
    expect(captured.some((x) => x.sql.includes("t.tenant_id::text"))).toBe(false);
    expect(captured.some((x) => x.sql.includes("FROM meta.tenants"))).toBe(false);
  });

  it("refuses the named tenant's key under the wrong ring, saying nothing of booting", async () => {
    const { conn } = fakeBoth({ rows: [sample(T(1), { wrapSecret: S1 })] }, { columns: [] });
    const c = await surveyColumnKeyConsistency(conn, {
      mode: "envelope",
      ring: ring(S2),
      keySchema: "meta",
      dataSchema: "public",
      scope: { kind: "tenant", tenantId: T(1) },
    });
    expect(c.verdict).toBe("refuse");
    expect(c.findings.map((f) => f.condition)).toEqual(["kek_secret_mismatch"]);
    const lines = formatColumnKeyConsistency(c);
    expect(lines.every((l) => l.text.startsWith(`column keys (tenant ${T(1)}):`))).toBe(true);
    const closing = lines.at(-1)?.text ?? "";
    expect(closing).toContain("REFUSED");
    expect(closing).not.toContain("booting");
    expect(closing).toContain("nothing is done for it");
    // The remedy is the boot's own sentence, not a second spelling of it — offered as one of two,
    // because a per-tenant survey reads one row and one row cannot separate a wrong secret from a
    // corrupt row (ADR-0481; this asserted the conclusive form, which one sample cannot support).
    expect(lines[0]?.text).toContain("Remedy, if the secret is wrong: if a new secret was meant as a rotation");
    expect(lines[0]?.text).toContain("cannot tell a corrupt row from a wrong secret");
    expect(lines[0]?.text).toContain("if the row is corrupt: restore the tenant's meta.tenant_data_keys row");
  });

  it("refuses for the named tenant only — another tenant's unopenable row is not its business", async () => {
    const rows = [sample(T(1), { wrapSecret: S1 }), sample(T(2), { wrapSecret: S2 })];
    const { conn } = fakeBoth({ rows }, { columns: [] });
    const scoped = (tenantId: string) =>
      surveyColumnKeyConsistency(conn, {
        mode: "envelope",
        ring: ring(S1),
        keySchema: "meta",
        dataSchema: "public",
        scope: { kind: "tenant", tenantId },
      });
    const clean = await scoped(T(1));
    expect(clean.verdict).toBe("consistent");
    expect(formatColumnKeyConsistency(clean)).toEqual([
      {
        level: "info",
        text:
          `column keys (tenant ${T(1)}): consistent — this tenant's stored data key opened under this ` +
          "secret ring; public (per-tenant manifest schemas are not asked) has no at-rest-encrypted column",
      },
    ]);
    expect((await scoped(T(2))).verdict).toBe("refuse");
  });

  it("refuses a keyless tenant whose ciphertext the ring would mis-seed (control: the right ring opens it)", async () => {
    const both = (secret: Uint8Array) =>
      surveyColumnKeyConsistency(
        fakeBoth({ rows: [] }, { ciphertext: [{ tenantId: T(3), openedBy: keyOf(S1, T(3)) }] }).conn,
        {
          mode: "envelope",
          ring: ring(secret),
          keySchema: "meta",
          dataSchema: "public",
          scope: { kind: "tenant", tenantId: T(3) },
        },
      );
    const wrong = await both(S2);
    expect(wrong.verdict).toBe("refuse");
    expect(wrong.findings.map((f) => f.condition)).toEqual(["ciphertext_key_mismatch"]);
    const right = await both(S1);
    expect(right.verdict).toBe("consistent");
    expect(formatColumnKeyConsistency(right)[0]?.text).toContain(
      "this tenant holds no stored data key row; its ciphertext without a key row opened",
    );
  });

  // ADR-0460 kept the deployment scope's consistent and refusal lines unchanged; these pin both in
  // full, so a rewrite of either arm of the per-scope sentences fails here rather than shipping.
  it("keeps the deployment's consistent line exactly as the boot printed it (control)", () => {
    const c = assess({ mode: "derived", ring: ring(S1), survey: read([]) });
    expect(formatColumnKeyConsistency(c)).toEqual([
      {
        level: "info",
        text:
          "column keys: consistent — no stored data key rows, so --column-key-mode derived has none it " +
          "could fail to open; public (per-tenant manifest schemas are not asked) has no at-rest-encrypted " +
          "column, so no tenant without a key row holds ciphertext",
      },
    ]);
  });

  it("keeps the deployment's refusal sentence exactly as the boot printed it", () => {
    const c = assess({
      mode: "derived",
      ring: ring(S1),
      survey: read([group([sample(T(1), { wrapSecret: S1 })], 1)]),
    });
    expect(c.verdict).toBe("refuse");
    expect(formatColumnKeyConsistency(c).at(-1)).toEqual({
      level: "error",
      text:
        "column keys: REFUSED — this configuration cannot open data keys or ciphertext the database already " +
        "holds; booting would answer those tenants' PHI requests with a 500 (no escape hatch: every remedy " +
        "above is a configuration change)",
    });
  });
});

describe("the survey ceiling (ADR-0460)", () => {
  it("bounds the flag on both sides around today's default", () => {
    expect(COLUMN_KEY_SURVEY_CEILING_FLAG).toBe("--column-key-survey-ceiling");
    expect(COLUMN_KEY_SURVEY_CEILING_BOUNDS.min).toBeGreaterThan(SAMPLES_PER_GROUP);
    expect(COLUMN_KEY_SURVEY_CEILING_BOUNDS.min).toBeLessThan(PER_TENANT_SURVEY_CEILING);
    expect(COLUMN_KEY_SURVEY_CEILING_BOUNDS.max).toBeGreaterThan(PER_TENANT_SURVEY_CEILING);
  });

  it("names the ceiling and the flag on the key survey's incomplete line", async () => {
    const tenants = [1, 2, 3, 4, 5].map(T);
    const rows = tenants.map((t) => sample(t, { wrapSecret: S1 }));
    const { conn } = fakeBoth({ confined: true, rows, tenants }, { columns: [] });
    const c = await surveyColumnKeyConsistency(conn, {
      mode: "envelope",
      ring: ring(S1),
      keySchema: "meta",
      dataSchema: "public",
      scope: { kind: "deployment", ceiling: 3 },
    });
    expect(c.verdict).toBe("unknown");
    const line = formatColumnKeyConsistency(c).find((l) => l.text.includes("SURVEY_INCOMPLETE"));
    expect(line?.level).toBe("warn");
    expect(line?.text).toContain("2 tenant(s) were not examined");
    expect(line?.text).toContain(`the survey stops at 3 tenants (${COLUMN_KEY_SURVEY_CEILING_FLAG}, 1000..100000)`);
  });

  it("names the ceiling and the flag on the keyless scan's incomplete line", () => {
    const c = assess({
      mode: "derived",
      ring: ring(S1),
      survey: read([]),
      scope: { kind: "deployment", ceiling: 4_321 },
      ciphertext: { ...NO_CIPHERTEXT, columns: 2, unexaminedTenants: 9 } as KeylessCiphertextCheck,
    });
    const detail = c.findings.find((f) => f.condition === "survey_incomplete")?.detail ?? "";
    expect(detail).toContain(`the survey stops at 4321 tenants (${COLUMN_KEY_SURVEY_CEILING_FLAG}`);
  });

  it("states no ceiling when it was not reached (control)", async () => {
    const tenants = [1, 2].map(T);
    const { conn } = fakeBoth({ confined: true, rows: tenants.map((t) => sample(t, { wrapSecret: S1 })), tenants }, { columns: [] });
    const c = await surveyColumnKeyConsistency(conn, {
      mode: "envelope",
      ring: ring(S1),
      keySchema: "meta",
      dataSchema: "public",
      scope: { kind: "deployment", ceiling: 3 },
    });
    expect(c.verdict).toBe("consistent");
    expect(formatColumnKeyConsistency(c).map((l) => l.text).join("\n")).not.toContain(COLUMN_KEY_SURVEY_CEILING_FLAG);
  });
});

describe("the boot wiring", () => {
  // As text, because no type can say that a refusal runs before the key source is built.
  const src = readFileSync(resolve(import.meta.dirname, "./node.ts"), "utf8");

  it("surveys the stored keys and throws the refusal in both modes, before any key source exists", () => {
    const survey = src.indexOf("const keyConsistency = await surveyColumnKeyConsistency(conn, {");
    const refusal = src.indexOf("throw new ColumnKeyConfigurationRefused(keyConsistency)");
    const keySource = src.indexOf("return buildEnvelopeKeySource({");
    expect(survey).toBeGreaterThan(0);
    expect(refusal).toBeGreaterThan(survey);
    expect(keySource).toBeGreaterThan(refusal);
    // Gated on the ring alone, never on the mode: derived mode is half of what it refuses.
    const gate = src.lastIndexOf("if (secretRing !== undefined) {", survey);
    expect(gate).toBeGreaterThan(0);
    expect(src.slice(gate, survey)).not.toContain("columnKeyMode ===");
    // The whole deployment, at the ceiling the operator chose: the composed function is what runs
    // the keyless-ciphertext half too, so there is no second call to fence.
    expect(src.slice(survey, refusal)).toContain(
      'scope: { kind: "deployment", ceiling: options.columnKeySurveyCeiling }',
    );
  });

  it("asks the rekey's tenant before the write-status probe, the store and the rekey survey", () => {
    const start = src.indexOf("export async function runRekey(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    const survey = body.indexOf("await surveyColumnKeyConsistency(conn, {");
    expect(survey).toBeGreaterThan(0);
    expect(body.slice(survey, body.indexOf("if (keyConsistency.verdict === \"refuse\")"))).toContain(
      'scope: { kind: "tenant", tenantId: options.tenantId }',
    );
    for (const later of ["new PostgresDataKeyStore(", "probeTenantWriteStatus(", "surveyTenantRekey(", "rekeyTenant("]) {
      expect(body.indexOf(later)).toBeGreaterThan(survey);
    }
  });
});
