import type { PgConnection } from "@crossengin/kernel-pg";
import { CHECK_CONSTRAINT_QUERY } from "@crossengin/kernel-pg";
import { parsePasswordHash } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { sampleKeyedPasswordHash } from "./credential-auth-env.js";
import {
  CREDENTIAL_HASH_ADMISSION_MAY_SERVE,
  CREDENTIAL_HASH_ADMISSION_VERDICTS,
  credentialHashAdmissionRemedy,
  declaredCredentialHashCheck,
  formatCredentialHashAdmission,
  probeCredentialHashAdmission,
} from "./credential-hash-admission.js";

/** The pattern a database applied before the `k<version>$` segment existed carries. */
const PRE_ROTATION_PATTERN = "^scrypt\\$[0-9]{1,8}\\$[0-9]{1,8}\\$[0-9]{1,8}\\$[0-9a-f]{32}\\$[0-9a-f]{128}$";

/** The regex inside the catalog's declared CHECK, as Postgres's `~` reads it. */
function declaredPattern(): RegExp {
  const m = /~\s*'([^']+)'/.exec(declaredCredentialHashCheck());
  if (m === null) throw new Error("no ~ pattern in the declared CHECK");
  return new RegExp(m[1]!);
}

/**
 * A fake that answers the two statements the probe issues **by shape** and throws on anything else
 * (ADR-0350). The evaluation is answered from a JS regex the test hands it per constraint, because
 * a fake cannot run Postgres's `~`: what this fences is the probe's control flow and its reading of
 * the answer, and the live run is what fences the regex itself.
 */
function fakeDb(
  live: readonly { readonly name: string; readonly pattern: string; readonly columns?: readonly string[] }[],
  opts: { readonly throwOnRead?: boolean } = {},
): { conn: PgConnection; statements: string[] } {
  const statements: string[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      statements.push(sql);
      if (/^SET TRANSACTION READ ONLY$/.test(sql) || /SAVEPOINT credential_hash_probe/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (sql === CHECK_CONSTRAINT_QUERY) {
        if (opts.throwOnRead === true) throw new Error("connection refused");
        const rows = live.map((l) => ({
          table_name: "users",
          constraint_name: l.name,
          expression: `(credential_hash ~ '${l.pattern}'::text)`,
          columns: l.columns ?? ["credential_hash"],
        }));
        return { rows, rowCount: rows.length };
      }
      const probe = /^SELECT coalesce\(\(\(credential_hash ~ '(.+)'::text\)\), true\) AS admits/.exec(sql);
      if (probe !== null) {
        const admits = new RegExp(probe[1]!).test(String(params?.[0]));
        return { rows: [{ admits }], rowCount: 1 };
      }
      throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
    }) as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };
  return { conn, statements };
}

describe("sampleKeyedPasswordHash", () => {
  it("is a hash the catalog's CHECK admits and the parser reads back at the version it names", () => {
    for (const version of [1, 2, 37, 9999]) {
      const sample = sampleKeyedPasswordHash(version);
      expect(declaredPattern().test(sample)).toBe(true);
      expect(parsePasswordHash(sample)?.pepperVersion).toBe(version);
    }
  });

  it("carries the k$ segment for every version but the legacy one, which a pre-rotation CHECK refuses", () => {
    const old = new RegExp(PRE_ROTATION_PATTERN);
    expect(old.test(sampleKeyedPasswordHash(1))).toBe(true);
    expect(sampleKeyedPasswordHash(2)).toContain("$k2$");
    expect(old.test(sampleKeyedPasswordHash(2))).toBe(false);
  });

  it("carries no password-derived bytes", () => {
    const parsed = parsePasswordHash(sampleKeyedPasswordHash(2));
    expect(parsed?.saltHex).toBe("0".repeat(32));
    expect(parsed?.hashHex).toBe("0".repeat(128));
  });
});

describe("probeCredentialHashAdmission", () => {
  it("decides boot on a total map in which only refuses stops it", () => {
    expect(Object.keys(CREDENTIAL_HASH_ADMISSION_MAY_SERVE).sort()).toEqual(
      [...CREDENTIAL_HASH_ADMISSION_VERDICTS].sort(),
    );
    expect(
      CREDENTIAL_HASH_ADMISSION_VERDICTS.filter((v) => !CREDENTIAL_HASH_ADMISSION_MAY_SERVE[v]),
    ).toEqual(["refuses"]);
  });

  it("asks nothing for the legacy pepper version", async () => {
    const db = fakeDb([]);
    const out = await probeCredentialHashAdmission(db.conn, { schema: "meta", pepperVersion: 1 });
    expect(out.verdict).toBe("not_applicable");
    expect(db.statements).toEqual([]);
  });

  it("refuses a rotated pepper against a pre-rotation CHECK, naming the constraint", async () => {
    const db = fakeDb([{ name: "users_credential_hash_check", pattern: PRE_ROTATION_PATTERN }]);
    const out = await probeCredentialHashAdmission(db.conn, { schema: "meta", pepperVersion: 2 });
    expect(out.verdict).toBe("refuses");
    expect(out.refusing).toEqual(["users_credential_hash_check"]);
    expect(CREDENTIAL_HASH_ADMISSION_MAY_SERVE[out.verdict]).toBe(false);
    // Read-only, so a CHECK calling a volatile function cannot write anything.
    expect(db.statements[0]).toBe("SET TRANSACTION READ ONLY");
  });

  it("admits a rotated pepper against the catalog's current CHECK", async () => {
    const db = fakeDb([{ name: "users_credential_hash_check", pattern: declaredPattern().source }]);
    const out = await probeCredentialHashAdmission(db.conn, { schema: "meta", pepperVersion: 2 });
    expect(out.verdict).toBe("admits");
  });

  it("reports unconstrained when no single-column CHECK sits on the column", async () => {
    const db = fakeDb([{ name: "users_other_check", pattern: PRE_ROTATION_PATTERN, columns: ["email"] }]);
    const out = await probeCredentialHashAdmission(db.conn, { schema: "meta", pepperVersion: 2 });
    expect(out.verdict).toBe("unconstrained");
  });

  it("reports unreadable rather than admits when the read fails", async () => {
    const db = fakeDb([], { throwOnRead: true });
    const out = await probeCredentialHashAdmission(db.conn, { schema: "meta", pepperVersion: 2 });
    expect(out.verdict).toBe("unreadable");
    expect(CREDENTIAL_HASH_ADMISSION_MAY_SERVE[out.verdict]).toBe(true);
  });

  it("refuses an unsafe schema identifier before any statement", async () => {
    const db = fakeDb([]);
    await expect(
      probeCredentialHashAdmission(db.conn, { schema: "meta; drop", pepperVersion: 2 }),
    ).rejects.toThrow(/invalid schema/);
  });
});

describe("credentialHashAdmissionRemedy and the boot line", () => {
  it("restores the catalog's CHECK in one transaction under the live name", () => {
    const sql = credentialHashAdmissionRemedy("meta", {
      verdict: "refuses",
      pepperVersion: 2,
      refusing: ["users_credential_hash_check"],
      detail: "",
    });
    const lines = sql.split("\n");
    expect(lines[0]).toBe("BEGIN;");
    expect(lines[lines.length - 1]).toBe("COMMIT;");
    expect(sql).toContain('DROP CONSTRAINT "users_credential_hash_check"');
    expect(sql).toContain(`CHECK (${declaredCredentialHashCheck()})`);
  });

  it("says the verdict either way and carries no hash", () => {
    for (const verdict of CREDENTIAL_HASH_ADMISSION_VERDICTS) {
      const line = formatCredentialHashAdmission({ verdict, pepperVersion: 2, refusing: [], detail: "d" });
      expect(line.startsWith("[auth] credential hash admission:")).toBe(true);
      expect(line).not.toContain("scrypt$");
    }
  });
});
