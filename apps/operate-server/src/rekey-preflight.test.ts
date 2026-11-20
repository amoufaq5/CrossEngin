import {
  dataKeyWrapAad,
  deriveTenantKek,
  generateDataKey,
  parseColumnEncryptionSecret,
  wrapDataKey,
} from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COLUMN_ENCRYPTION_SECRET_VAR } from "./column-encryption.js";
import {
  COLUMN_ENCRYPTION_SECRET_GENERATION_VAR,
  COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR,
} from "./column-secret-ring.js";
import { runRekey } from "./node.js";
import { formatRekeyColumnKeys, type RekeyOptions } from "./rekey.js";

// ADR-0460: `operate-server rekey` runs the boot's column-key check for its tenant before anything
// else, and a refusal stops it there — `--plan` and `--rewrap-kek` included.

const RIGHT = "rekey-right-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789";
const WRONG = "rekey-wrong-secret-abcdefghijklmnopqrstuvwxyz-9876543210";
const TENANT = "00000000-0000-4000-8000-000000000042";

/** Raised by the fake for the first statement past the pre-flight, so a test can see it was reached. */
class PastTheGate extends Error {
  constructor(readonly sql: string) {
    super("past the column-key pre-flight");
  }
}

/**
 * A connection answering exactly the pre-flight's statements for one tenant holding one random key
 * row wrapped under `RIGHT`, and no at-rest column. The key-row read answers the store's `load` too
 * (same table, same predicate), which is what lets `--rewrap-kek --plan` complete. Anything else —
 * the write-status probe, the rotation survey — throws `PastTheGate`.
 */
function fakeConnection(): { conn: PgConnection; statements: string[]; wrapped: Buffer; dek: Uint8Array } {
  const statements: string[] = [];
  const secret = parseColumnEncryptionSecret(RIGHT);
  const dek = generateDataKey();
  const wrapped = Buffer.from(wrapDataKey(deriveTenantKek(secret, TENANT, 1), dek, dataKeyWrapAad(TENANT, 1)));
  const row = {
    tenant_id: TENANT,
    generation: 1,
    wrapped_key: wrapped,
    kek_generation: 1,
    provenance: "random",
  };
  const run = async (sql: string, params: readonly unknown[] = []) => {
    assertBindArity(sql, params);
    statements.push(sql);
    const answer = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
    if (sql.includes("set_config")) return answer([]);
    if (sql.includes("has_table_privilege")) return answer([{ table_exists: true, can_select: true }]);
    if (sql.includes("crossengin.encrypt=at_rest")) return answer([]);
    if (/FROM meta\.tenant_data_keys\s+WHERE tenant_id = \$1\s+ORDER BY generation DESC/.test(sql)) {
      return answer(params[0] === TENANT ? [row] : []);
    }
    throw new PastTheGate(sql);
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };
  return { conn, statements, wrapped, dek };
}

function options(over: Partial<RekeyOptions> = {}): RekeyOptions {
  return {
    tenantId: TENANT,
    confirmTenantId: TENANT,
    plan: false,
    schema: null,
    dataSchema: null,
    allowLiveRekey: false,
    columnKeyTtlMs: null,
    rewrapKek: false,
    format: "human",
    help: false,
    ...over,
  };
}

const VARS = [
  COLUMN_ENCRYPTION_SECRET_VAR,
  COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR,
  COLUMN_ENCRYPTION_SECRET_GENERATION_VAR,
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});
afterEach(() => {
  for (const v of VARS) {
    const value = saved[v];
    if (value === undefined) delete process.env[v];
    else process.env[v] = value;
  }
});

describe("operate-server rekey's column-key pre-flight", () => {
  for (const arm of [
    { name: "a rekey", opts: {} },
    { name: "--plan", opts: { plan: true } },
    { name: "--rewrap-kek", opts: { rewrapKek: true } },
    { name: "--rewrap-kek --plan", opts: { rewrapKek: true, plan: true } },
  ] as const) {
    it(`refuses ${arm.name} up front under a ring that cannot open the tenant's key`, async () => {
      process.env[COLUMN_ENCRYPTION_SECRET_VAR] = WRONG;
      const { conn, statements } = fakeConnection();
      const report = await runRekey(options(arm.opts), () => conn);
      expect(report.ok).toBe(false);
      expect(report.keyConsistency.verdict).toBe("refuse");
      expect(report.keyConsistency.findings.map((f) => f.condition)).toEqual(["kek_secret_mismatch"]);
      // Nothing past the pre-flight ran: no write-status probe, no rotation survey, no re-wrap.
      expect(report).toMatchObject({ writeStatus: null, survey: null, result: null, rewrap: null });
      expect(statements.some((s) => /\bUPDATE\b|\bstatus\b/.test(s))).toBe(false);
      // The survey's own message and remedy, scoped to this tenant; no secret in it.
      const text = formatRekeyColumnKeys(report.keyConsistency);
      expect(text).toContain(`error: column keys (tenant ${TENANT}): KEK_SECRET_MISMATCH`);
      expect(text).toContain("Remedy:");
      expect(text).toContain("REFUSED");
      expect(text).not.toContain("booting");
      for (const secret of [RIGHT, WRONG]) expect(text).not.toContain(secret);
    });
  }

  it("lets a rekey under the right ring through to the write-status probe, its next step (control)", async () => {
    process.env[COLUMN_ENCRYPTION_SECRET_VAR] = RIGHT;
    const { conn } = fakeConnection();
    const err = await runRekey(options(), () => conn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PastTheGate);
    expect((err as PastTheGate).sql).toContain("SELECT status FROM");
  });

  it("reports the clean pre-flight on --rewrap-kek --plan beside the planned re-wrap (control)", async () => {
    process.env[COLUMN_ENCRYPTION_SECRET_VAR] = RIGHT;
    const { conn } = fakeConnection();
    const report = await runRekey(options({ rewrapKek: true, plan: true }), () => conn);
    expect(report.ok).toBe(true);
    expect(report.keyConsistency.verdict).toBe("consistent");
    expect(report.rewrap?.outcome).toBe("already_current");
    expect(formatRekeyColumnKeys(report.keyConsistency)).toBe(
      `ok: column keys (tenant ${TENANT}): consistent — this tenant's stored data key opened under ` +
        "this secret ring; public (per-tenant manifest schemas are not asked) has no at-rest-encrypted column",
    );
  });

  it("carries no key material in the JSON report", async () => {
    process.env[COLUMN_ENCRYPTION_SECRET_VAR] = WRONG;
    const { conn, wrapped, dek } = fakeConnection();
    const json = JSON.stringify(await runRekey(options({ plan: true }), () => conn));
    expect(json).not.toContain(RIGHT);
    expect(json).not.toContain(WRONG);
    // The fixture's own bytes, in every spelling a serializer could emit them: base64, hex, and the
    // `{"type":"Buffer","data":[…]}` form JSON.stringify gives a Buffer — plus the model's field
    // names, so a regression that put survey samples on the report fails here whatever their bytes.
    for (const material of [wrapped, Buffer.from(dek)]) {
      expect(json).not.toContain(material.toString("base64"));
      expect(json).not.toContain(material.toString("hex"));
      expect(json).not.toContain(JSON.stringify([...material]).slice(1, -1));
    }
    expect(json).not.toContain('"data":[');
    expect(json).not.toContain('"wrappedKey"');
    expect(json).not.toContain('"samples"');
    expect(json).toContain('"verdict":"refuse"');
  });
});
