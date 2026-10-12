import type { EncryptedColumn, KeyRotationOutcome, KeyRotationPlan, PgConnection } from "@crossengin/kernel-pg";
import { TENANT_LIFECYCLE_STATES } from "@crossengin/tenant-lifecycle";
import type { TenantRekeyResult, TenantRekeySurvey } from "@crossengin/crypto-pg";
import { describe, expect, it } from "vitest";

import { DEFAULT_COLUMN_KEY_TTL_MS } from "./data-key-envelope.js";
import {
  TENANT_WRITE_STATUSES,
  TENANT_WRITE_STATUS_DETAIL,
  formatRekeyResult,
  formatRekeySurvey,
  formatStaleKeyWindow,
  probeTenantWriteStatus,
  type TenantWriteStatus,
} from "./rekey.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** Null for a statement issued outside any transaction. */
  readonly tx: number | null;
}

interface Fake {
  readonly conn: PgConnection;
  readonly captured: Captured[];
}

/**
 * Answers one `SELECT status` from a fixture and records every statement with the transaction it
 * ran in.
 *
 * The transaction id is here for the same reason `tenant-ciphertext-probe.test.ts` records it, used
 * in the opposite direction: a fake answers any statement, so what it structurally cannot see is
 * whether a read was *scoped*. `meta.tenants` has no `tenant_id` column and no RLS, so the
 * assertion this fake supports is that `probeTenantWriteStatus` opens **no** transaction and sets
 * **no** context — an absent arm here is correct, and only a recording fake can tell that apart
 * from an arm somebody forgot.
 */
function fakeDb(rows: readonly Record<string, unknown>[], onQuery?: () => never): Fake {
  const captured: Captured[] = [];
  let txSeq = 0;
  let currentTx: number | null = null;

  const makeConn = (): PgConnection => ({
    query: async <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
      captured.push({ sql, params: params ?? [], tx: currentTx });
      if (onQuery !== undefined) onQuery();
      return { rows: rows as unknown as T[], rowCount: rows.length };
    },
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const outer = currentTx;
      txSeq += 1;
      currentTx = txSeq;
      try {
        return await fn(makeConn());
      } finally {
        currentTx = outer;
      }
    },
    withAdvisoryLock: async <T>(_key: bigint, fn: () => Promise<T>) => fn(),
    close: async () => undefined,
  });

  return { conn: makeConn(), captured };
}

function plan(overrides: Partial<KeyRotationPlan> = {}): KeyRotationPlan {
  return {
    schema: "public",
    table: "patient",
    column: "mrn",
    dataClass: "phi",
    statement: { sql: "UPDATE ... pgp_sym_encrypt ...", params: [TENANT] },
    confirm: { sql: "SELECT count(...) ...", params: [TENANT] },
    rowsToRewrite: 42,
    ...overrides,
  };
}

function outcome(overrides: Partial<KeyRotationOutcome> = {}): KeyRotationOutcome {
  return { ...plan(), rowsReencrypted: 42, ...overrides };
}

function plaintextColumn(overrides: Partial<EncryptedColumn> = {}): EncryptedColumn {
  return {
    schema: "public",
    table: "citizen",
    column: "national_id",
    dataType: "text",
    dataClass: "regulated",
    encryptedStorage: false,
    ...overrides,
  };
}

function survey(overrides: Partial<TenantRekeySurvey> = {}): TenantRekeySurvey {
  return {
    tenantId: TENANT,
    dataSchema: "public",
    current: { generation: 1, provenance: "seeded_from_derived", kekGeneration: 1 },
    plans: [plan()],
    plaintextAtRest: [],
    rowsToRewrite: 42,
    alternativesWithCiphertext: [],
    refusals: [],
    ...overrides,
  };
}

function result(overrides: Partial<TenantRekeyResult> = {}): TenantRekeyResult {
  return {
    tenantId: TENANT,
    fromGeneration: 1,
    fromProvenance: "seeded_from_derived",
    toGeneration: 2,
    columns: [outcome()],
    rowsReencrypted: 42,
    rowsConfirmed: 42,
    priorGenerationsDestroyed: 1,
    ...overrides,
  };
}

/**
 * 32 raw bytes rendered base64 is 44 characters, which is what `dataKeyToColumnKey` produces. The
 * formatters must never emit one, and the shape is cheap to assert for.
 */
const BASE64_KEY_SHAPED = /[A-Za-z0-9+/]{43}=/;

describe("TENANT_WRITE_STATUSES", () => {
  it("is exactly the three answers, with no_tenant_row distinct from permits_writes", () => {
    // The third value is the whole point: an api-key principal names a UUID with no meta.tenants
    // row, and an absence read as "permits writes" would demand --allow-live-rekey exactly where
    // the warning is least meaningful.
    expect(TENANT_WRITE_STATUSES).toEqual(["blocks_writes", "permits_writes", "no_tenant_row"]);
  });
});

describe("TENANT_WRITE_STATUS_DETAIL", () => {
  it("is total over the statuses and nothing else", () => {
    expect(Object.keys(TENANT_WRITE_STATUS_DETAIL).sort()).toEqual([...TENANT_WRITE_STATUSES].sort());
  });

  it("says something beyond restating its own key", () => {
    for (const status of TENANT_WRITE_STATUSES) {
      const detail = TENANT_WRITE_STATUS_DETAIL[status];
      expect(detail.length).toBeGreaterThan(40);
      expect(detail).not.toBe(status);
      expect(detail).not.toBe(status.replace(/_/g, " "));
    }
  });

  it("speaks about the rekey rather than about the request path", () => {
    // The inversion is the point: blocks_writes is a refusal on the request path and the state to
    // rekey in here, and permits_writes is the only answer needing an operator decision — a line
    // reporting the state alone would leave both to the reader.
    expect(TENANT_WRITE_STATUS_DETAIL.blocks_writes).toContain("rekey in");
    expect(TENANT_WRITE_STATUS_DETAIL.permits_writes).toContain("--allow-live-rekey");
  });

  it("does not claim blocks_writes is enforced on a deployment that lacks the gate", () => {
    // This was the one load-bearing safety claim in the subcommand and it was false on the
    // documented compose path: `meta.tenants.status` is enforced on the request path only by
    // `--tenant-status-gate`, which is opt-in and off by default, so on a default deployment a
    // `suspended` tenant goes on accepting writes — and a rekey "safely" performed in that state
    // is exactly the split-across-two-keys outcome the status was supposed to prevent.
    const detail = TENANT_WRITE_STATUS_DETAIL.blocks_writes;
    expect(detail).toContain("--tenant-status-gate");
    expect(detail).toContain("OPT-IN and off by default");
    expect(detail).toContain("advisory");
    // And the remedy that holds whatever the deployment is configured to do, which is the sentence
    // a conditional enforcement claim has to be paired with.
    expect(detail).toContain("unconditional remedy");
    expect(detail).toContain("stop or roll the serving processes");
    // The two halves are kept apart rather than merged into one reassuring clause.
    expect(detail).toContain("With the gate");
    expect(detail).toContain("without it");
  });
});

describe("probeTenantWriteStatus", () => {
  it("answers a concrete status for each of the five storable states", async () => {
    // Written-out expectations rather than a second call to `blocksWrites`: an elementwise
    // comparison against the predicate the implementation uses would assert agreement rather than
    // correctness.
    const expected: readonly (readonly [string, TenantWriteStatus])[] = [
      ["active", "permits_writes"],
      ["suspended", "blocks_writes"],
      ["archived", "blocks_writes"],
      ["pending_deletion", "blocks_writes"],
      ["deleted", "blocks_writes"],
    ];
    for (const [status, answer] of expected) {
      const fake = fakeDb([{ status }]);
      await expect(probeTenantWriteStatus(fake.conn, "meta", TENANT)).resolves.toBe(answer);
    }
  });

  it("answers for every lifecycle state the contract declares", async () => {
    // The forcing function, derived from the enum: a sixth state must be considered here rather
    // than inheriting whichever answer a hardcoded list happened to omit it from.
    for (const status of TENANT_LIFECYCLE_STATES) {
      const fake = fakeDb([{ status }]);
      await expect(probeTenantWriteStatus(fake.conn, "meta", TENANT)).resolves.toMatch(
        /^(blocks_writes|permits_writes)$/,
      );
    }
  });

  it("answers no_tenant_row when the row is absent", async () => {
    const fake = fakeDb([]);
    await expect(probeTenantWriteStatus(fake.conn, "meta", TENANT)).resolves.toBe("no_tenant_row");
  });

  it("binds the tenant id and never writes it into the SQL text", async () => {
    const fake = fakeDb([{ status: "active" }]);
    await probeTenantWriteStatus(fake.conn, "meta", TENANT);
    const statement = fake.captured[0];
    expect(statement).toBeDefined();
    expect(statement?.params).toEqual([TENANT]);
    expect(statement?.sql).not.toContain(TENANT);
    expect(statement?.sql).toContain("$1");
  });

  it("quotes the schema identifier it interpolates", async () => {
    const fake = fakeDb([{ status: "active" }]);
    await probeTenantWriteStatus(fake.conn, "custom_meta", TENANT);
    expect(fake.captured[0]?.sql).toContain('"custom_meta"."tenants"');
  });

  it("refuses an out-of-pattern schema before issuing any statement", async () => {
    const fake = fakeDb([{ status: "active" }]);
    await expect(probeTenantWriteStatus(fake.conn, 'meta"; DROP TABLE x --', TENANT)).rejects.toThrow(
      /invalid schema identifier/,
    );
    expect(fake.captured).toHaveLength(0);
  });

  it("raises on a status the contract forbids rather than folding it into an answer", async () => {
    // The column CHECK permits only five values, but a row edited past it must not get to decide
    // whether this rekey needs an operator's override (ADR-0289's rule for this exact column).
    const fake = fakeDb([{ status: "past_due" }]);
    await expect(probeTenantWriteStatus(fake.conn, "meta", TENANT)).rejects.toThrow();
  });

  it("opens no transaction and sets no tenant context", async () => {
    // Correct rather than forgotten: meta.tenants carries no tenant_id column and no RLS, so there
    // is nothing for a context to confine. One statement, outside any transaction.
    const fake = fakeDb([{ status: "active" }]);
    await probeTenantWriteStatus(fake.conn, "meta", TENANT);
    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0]?.tx).toBeNull();
    expect(fake.captured.some((c) => c.sql.includes("set_config"))).toBe(false);
  });
});

describe("formatRekeySurvey", () => {
  it("leads with the verdict and the row count when nothing refuses", () => {
    const out = formatRekeySurvey(survey(), "blocks_writes");
    expect(out.split("\n")[0]).toBe(
      `rekey survey: tenant ${TENANT} in schema public — would rewrite 42 row(s) across 1 column(s)`,
    );
  });

  it("names every refusal and says nothing has been written", () => {
    const out = formatRekeySurvey(
      survey({
        refusals: [
          { reason: "no_data_key_row", detail: "no row in the data key table" },
          { reason: "rls_would_confine_this_session", detail: "this role is confined" },
        ],
      }),
      "permits_writes",
    );
    expect(out.split("\n")[0]).toContain("REFUSED (2)");
    expect(out).toContain("REFUSED no_data_key_row: no row in the data key table");
    expect(out).toContain("REFUSED rls_would_confine_this_session: this role is confined");
    expect(out).toContain("nothing has been written");
  });

  it("prints the current generation, kek generation and provenance", () => {
    const out = formatRekeySurvey(
      survey({ current: { generation: 3, provenance: "random", kekGeneration: 2 } }),
      "blocks_writes",
    );
    expect(out).toContain("current data key: generation 3, kek generation 2, provenance random");
  });

  it("says what destroying a seeded key is worth today, and names the remedy", () => {
    const out = formatRekeySurvey(survey(), "blocks_writes");
    expect(out).toContain("data key shreddability: derivable");
    expect(out).toContain("destroying its row destroys nothing");
    expect(out).toContain("Rekeying the tenant");
  });

  it("reports no row as not_applicable without claiming a mode or a seed", () => {
    const out = formatRekeySurvey(survey({ current: null }), "no_tenant_row");
    const line = out.split("\n").find((l) => l.includes("data key shreddability"));
    expect(out).toContain("current data key: none");
    expect(line).toContain("not_applicable");
    expect(line).toContain("nothing to destroy and no deletion horizon");
    expect(out).not.toContain("seeded from");
    // The shared SHREDDABILITY_DETAIL.not_applicable sentence asserts the key "is derived from
    // COLUMN_ENCRYPTION_SECRET … and stored nowhere", which is sound on the boot line where the
    // mode is in hand and false in this surface's likeliest case: envelope mode, a tenant that has
    // never written an encrypted column. So the reason is local and names both possibilities.
    expect(line).not.toContain("and stored nowhere");
    expect(line).toContain("not decidable from here");
    expect(line).toContain("--column-key-mode derived");
  });

  it("prints one line per column with its row count, and the schema it introspected", () => {
    const out = formatRekeySurvey(
      survey({
        dataSchema: "t_abc",
        plans: [plan(), plan({ table: "encounter", column: "note", rowsToRewrite: 7 })],
        rowsToRewrite: 49,
      }),
      "blocks_writes",
    );
    expect(out).toContain("schema t_abc");
    expect(out).toContain("patient.mrn (phi) — 42 row(s) to rewrite");
    expect(out).toContain("encounter.note (phi) — 7 row(s) to rewrite");
    expect(out).toContain("49 row(s)");
  });

  it("renders an uncounted plan as 'not counted' and the total as a lower bound", () => {
    const out = formatRekeySurvey(
      survey({ plans: [plan({ rowsToRewrite: null })], rowsToRewrite: 0 }),
      "blocks_writes",
    );
    const columnLine = out.split("\n").find((l) => l.includes("patient.mrn"));
    // Asserted on the column's own line rather than on the whole output: 0 is also what a confined
    // session reports, and the aggregate legitimately reads 0 while saying it is a lower bound.
    expect(columnLine).toBe("  patient.mrn (phi) — not counted");
    expect(columnLine).not.toContain("0 row(s)");
    expect(out).toContain("lower bound and not a measurement");
  });

  it("prints the total and the schema even when something refused", () => {
    const out = formatRekeySurvey(
      survey({
        dataSchema: "t_abc",
        plans: [plan({ rowsToRewrite: null })],
        rowsToRewrite: 0,
        refusals: [{ reason: "rls_would_confine_this_session", detail: "confined" }],
      }),
      "blocks_writes",
    );
    // The lock window an operator approves must not be the sentence that disappears exactly when
    // the header switched to REFUSED.
    expect(out).toContain("row(s) to rewrite in total across 1 column(s) in schema t_abc");
  });

  it("makes the wrong --data-schema the obvious hypothesis for an empty plan", () => {
    const out = formatRekeySurvey(
      survey({ plans: [], rowsToRewrite: 0, refusals: [] }),
      "blocks_writes",
    );
    expect(out).toContain("--data-schema");
    expect(out).toContain("its own schema");
    // Named even when no alternative holds ciphertext, since that is the case where the hypothesis
    // is all the operator has.
    expect(out).not.toContain("these schemas DO hold one");
  });

  it("names the alternative schemas that do hold ciphertext", () => {
    const out = formatRekeySurvey(
      survey({
        plans: [],
        rowsToRewrite: 0,
        alternativesWithCiphertext: ["t_11111111_1111_4111_8111_111111111111"],
      }),
      "blocks_writes",
    );
    expect(out).toContain("these schemas DO hold one: t_11111111_1111_4111_8111_111111111111");
    expect(out).toContain("pass --data-schema");
  });

  it("reports a hinted-but-plaintext column rather than dropping it", () => {
    const out = formatRekeySurvey(survey({ plaintextAtRest: [plaintextColumn()] }), "blocks_writes");
    expect(out).toContain("SKIPPED citizen.national_id");
    expect(out).toContain("stored as text");
    expect(out).toContain("plaintext at rest");
  });

  it("ends with the write status and its detail", () => {
    for (const status of TENANT_WRITE_STATUSES) {
      const out = formatRekeySurvey(survey(), status);
      const last = out.split("\n").at(-1);
      expect(last).toContain(`write status: ${status}`);
      expect(last).toContain(TENANT_WRITE_STATUS_DETAIL[status]);
    }
  });

  it("prints no key-shaped material and no plan SQL", () => {
    const out = formatRekeySurvey(
      survey({ plaintextAtRest: [plaintextColumn()], refusals: [{ reason: "keys_are_the_same", detail: "same ref" }] }),
      "permits_writes",
    );
    expect(out).not.toMatch(BASE64_KEY_SHAPED);
    expect(out).not.toContain("pgp_sym_encrypt");
    expect(out).not.toContain("UPDATE");
  });
});

describe("formatRekeyResult", () => {
  it("leads with the generation and provenance transition", () => {
    const out = formatRekeyResult(result(), DEFAULT_COLUMN_KEY_TTL_MS, false);
    expect(out.split("\n")[0]).toBe(
      `rekeyed tenant ${TENANT}: generation 1 → 2, provenance seeded_from_derived → random`,
    );
  });

  it("prints one line per column with the rows it re-encrypted", () => {
    const out = formatRekeyResult(
      result({
        columns: [outcome(), outcome({ table: "encounter", column: "note", rowsReencrypted: 7 })],
        rowsReencrypted: 49,
        rowsConfirmed: 49,
      }),
      DEFAULT_COLUMN_KEY_TTL_MS,
      false,
    );
    expect(out).toContain("patient.mrn (phi) — 42 row(s) re-encrypted");
    expect(out).toContain("encounter.note (phi) — 7 row(s) re-encrypted");
  });

  it("reports both totals and the generations destroyed", () => {
    const out = formatRekeyResult(
      result({ priorGenerationsDestroyed: 2 }),
      DEFAULT_COLUMN_KEY_TTL_MS,
      false,
    );
    expect(out).toContain("42 row(s) re-encrypted, 42 confirmed readable under the new key");
    expect(out).toContain("2 earlier generation(s) destroyed");
  });

  it("states the horizon in the corrected words and never overclaims", () => {
    const out = formatRekeyResult(result(), DEFAULT_COLUMN_KEY_TTL_MS, false);
    const horizon = out.split("\n").find((l) => l.includes("data key shreddability"));
    expect(horizon).toContain("shreddability: shreddable");
    expect(horizon).toContain("bounds the deletion horizon");
    expect(horizon).toContain("recoverable only from backups taken before the destruction");
    expect(horizon).toContain("backup retention");
    // ADR-0347 exists partly to retire this claim: the wrapped key and the ciphertext share one
    // database, so one backup holds both. Scoped to the horizon line, because the stale-key window
    // below it makes a different and true "not recoverable" claim about splitting a tenant's
    // columns across two keys, and a whole-output match would couple the two sentences.
    expect(horizon).not.toContain("unrecoverable");
    expect(out).not.toContain("including from backups");
  });

  it("reports the new row as random whatever the previous provenance was", () => {
    const out = formatRekeyResult(
      result({ fromProvenance: "random" }),
      DEFAULT_COLUMN_KEY_TTL_MS,
      false,
    );
    expect(out).toContain("provenance random → random");
    expect(out).toContain("shreddability: shreddable");
  });

  it("ends with the stale key window, and passes `stated` straight through", () => {
    // Both arms, because the result line is the only caller of `formatStaleKeyWindow` on the
    // success path: a report that always printed the default would understate the hazard by up to
    // 10x for a fleet on the 300000ms ceiling, which is the whole reason the parameter exists.
    expect(formatRekeyResult(result(), 45_000, true)).toContain(formatStaleKeyWindow(45_000, true));
    expect(formatRekeyResult(result(), 45_000, false)).toContain(
      formatStaleKeyWindow(45_000, false),
    );
    expect(formatRekeyResult(result(), 45_000, true)).not.toContain("the DEFAULT");
    expect(formatRekeyResult(result(), 45_000, false)).toContain("the DEFAULT");
  });

  it("prints no key-shaped material and no plan SQL", () => {
    for (const stated of [true, false]) {
      const out = formatRekeyResult(result(), DEFAULT_COLUMN_KEY_TTL_MS, stated);
      expect(out).not.toMatch(BASE64_KEY_SHAPED);
      expect(out).not.toContain("pgp_sym_encrypt");
    }
  });
});

describe("formatStaleKeyWindow", () => {
  it("names the hazard in both directions and which one is unrecoverable", () => {
    for (const stated of [true, false]) {
      const out = formatStaleKeyWindow(DEFAULT_COLUMN_KEY_TTL_MS, stated);
      expect(out).toContain("READS raise");
      expect(out).toContain("never a wrong answer");
      expect(out).toContain("WRITES encrypt new values under the previous key");
      expect(out).toContain("not recoverable");
    }
  });

  it("names the remedy and not only the risk", () => {
    for (const stated of [true, false]) {
      const out = formatStaleKeyWindow(DEFAULT_COLUMN_KEY_TTL_MS, stated);
      expect(out).toContain("Remedy");
      expect(out).toContain("restart or roll the serving processes");
      expect(out).toContain("refuses writes");
    }
  });

  it("says the bound does not close the window, and names the flag that sets it", () => {
    for (const stated of [true, false]) {
      const out = formatStaleKeyWindow(DEFAULT_COLUMN_KEY_TTL_MS, stated);
      expect(out).toContain("does not close it");
      // The flag comes from the module that owns the feature, so this sentence cannot point at one
      // the CLI does not parse.
      expect(out).toContain("--column-key-ttl-ms");
    }
  });

  it("renders whole seconds as seconds and anything else in milliseconds", () => {
    for (const stated of [true, false]) {
      expect(formatStaleKeyWindow(30_000, stated)).toContain("stale key window: 30s");
      expect(formatStaleKeyWindow(1_500, stated)).toContain("stale key window: 1500ms");
    }
  });

  it("attributes a stated figure to the operator and names the flag they passed", () => {
    const out = formatStaleKeyWindow(300_000, true);
    expect(out).toContain("stale key window: 300s (--column-key-ttl-ms, as you stated it)");
    // Not labelled a default, because it is not one: the operator read their fleet's value and
    // typed it, and calling it a default would send them looking for a figure they already have.
    expect(out).not.toContain("the DEFAULT");
    expect(out).not.toContain("does not run the gateway");
  });

  it("labels an unstated figure DEFAULT and says this process cannot see the fleet's value", () => {
    // The defect this parameter closes: the line printed `30s` beside `--column-key-ttl-ms` and so
    // read as the configured value, while `parseRekeyArgs` did not parse that flag at all — a 10x
    // understatement for a fleet on the ceiling, in the direction where an operator resumes writes
    // while a replica still holds the previous key.
    const out = formatStaleKeyWindow(DEFAULT_COLUMN_KEY_TTL_MS, false);
    expect(out).toContain("the DEFAULT, not a reading");
    expect(out).toContain("this process does not run the gateway and cannot see its");
    expect(out).toContain("pass it here to have this line reflect your fleet");
    expect(out).not.toContain("as you stated it");
  });

  it("renders the same figure differently on the two arms, and the figure itself identically", () => {
    // The two renderings differ in their *claim* and not in their number, which is what makes the
    // flag a labelling fix rather than an arithmetic one.
    const stated = formatStaleKeyWindow(60_000, true);
    const unstated = formatStaleKeyWindow(60_000, false);
    expect(stated).not.toBe(unstated);
    expect(stated).toContain("60s");
    expect(unstated).toContain("60s");
  });
});
