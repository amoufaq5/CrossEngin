import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import {
  DECISION_POLICY_COLUMN_SQL,
  DECISION_PRINCIPAL_COLUMN_SQL,
  probeDecisionSchema,
} from "./decision-schema-probe.js";

type Row = { column_name: string; udt_name: string };

function catalogConnection(
  rows: readonly Row[],
  capture?: string[],
): PgConnection {
  return {
    query: vi.fn(async (sql: string): Promise<PgQueryResult> => {
      capture?.push(sql);
      return { rows: rows as unknown as readonly Record<string, unknown>[], rowCount: rows.length };
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

const PATCHED: readonly Row[] = [
  { column_name: "policy_id", udt_name: "text" },
  { column_name: "principal_id", udt_name: "text" },
];

const SHIPPED: readonly Row[] = [
  { column_name: "policy_id", udt_name: "uuid" },
  { column_name: "quota_definition_id", udt_name: "uuid" },
  { column_name: "principal_id", udt_name: "uuid" },
];

describe("probeDecisionSchema — asks the catalog, not the data", () => {
  it("reads information_schema.columns for the three columns", async () => {
    const capture: string[] = [];
    await probeDecisionSchema(catalogConnection(PATCHED, capture));
    expect(capture).toHaveLength(1);
    expect(capture[0]).toContain("information_schema.columns");
    expect(capture[0]).toContain("rate_limit_decisions");
    expect(capture[0]).toContain("policy_id");
    expect(capture[0]).toContain("principal_id");
  });

  it("never counts rows — a count of 0 is also what an empty table gives", async () => {
    const capture: string[] = [];
    await probeDecisionSchema(catalogConnection(PATCHED, capture));
    expect(capture[0]).not.toMatch(/count\(/i);
  });
});

describe("probeDecisionSchema — the patched catalog", () => {
  it("reads both columns as text and is ready with no defects", async () => {
    const probe = await probeDecisionSchema(catalogConnection(PATCHED));
    expect(probe.policyColumn).toBe("text");
    expect(probe.principalColumn).toBe("text");
    expect(probe.ready).toBe(true);
    expect(probe.defects).toHaveLength(0);
    expect(probe.remediationSql).toHaveLength(0);
  });

  it("reports quota_definition_id as present and hands over only its drop", async () => {
    const probe = await probeDecisionSchema(
      catalogConnection([...PATCHED, { column_name: "quota_definition_id", udt_name: "uuid" }]),
    );
    expect(probe.quotaColumnPresent).toBe(true);
    expect(probe.ready).toBe(true);
    expect(probe.remediationSql).toEqual([DECISION_POLICY_COLUMN_SQL[1]]);
  });

  it("treats varchar as text, since either can hold an rlp_ id", async () => {
    const probe = await probeDecisionSchema(
      catalogConnection([
        { column_name: "policy_id", udt_name: "varchar" },
        { column_name: "principal_id", udt_name: "varchar" },
      ]),
    );
    expect(probe.policyColumn).toBe("text");
    expect(probe.ready).toBe(true);
  });
});

describe("probeDecisionSchema — the shipped catalog", () => {
  it("is not ready, because a uuid policy_id cannot hold an rlp_ id", async () => {
    const probe = await probeDecisionSchema(catalogConnection(SHIPPED));
    expect(probe.policyColumn).toBe("uuid");
    expect(probe.ready).toBe(false);
  });

  it("names both defects and hands over both remediations", async () => {
    const probe = await probeDecisionSchema(catalogConnection(SHIPPED));
    expect(probe.defects).toHaveLength(2);
    expect(probe.defects.join(" ")).toMatch(/policy_id is uuid/);
    expect(probe.defects.join(" ")).toMatch(/meta\.users, which has no writer/);
    for (const sql of [...DECISION_POLICY_COLUMN_SQL, ...DECISION_PRINCIPAL_COLUMN_SQL]) {
      expect(probe.remediationSql).toContain(sql);
    }
  });

  it("drops quota_definition_id as part of the policy remediation, not as a second one", async () => {
    const probe = await probeDecisionSchema(catalogConnection(SHIPPED));
    expect(probe.remediationSql.filter((s) => s.includes("quota_definition_id"))).toHaveLength(1);
  });

  it("is still ready when only principal_id lags, since that row can be written without it", async () => {
    const probe = await probeDecisionSchema(
      catalogConnection([
        { column_name: "policy_id", udt_name: "text" },
        { column_name: "principal_id", udt_name: "uuid" },
      ]),
    );
    expect(probe.ready).toBe(true);
    expect(probe.defects).toHaveLength(1);
    expect(probe.remediationSql).toEqual([...DECISION_PRINCIPAL_COLUMN_SQL]);
  });
});

describe("probeDecisionSchema — an absent column", () => {
  it("reads a missing column as absent rather than guessing", async () => {
    const probe = await probeDecisionSchema(catalogConnection([]));
    expect(probe.policyColumn).toBe("absent");
    expect(probe.principalColumn).toBe("absent");
    expect(probe.quotaColumnPresent).toBe(false);
    expect(probe.ready).toBe(false);
  });

  it("reads an unrecognised type as uuid rather than as text — the refusing direction", async () => {
    // Unknown must not read as ready: the mistake that admits a write is the expensive one here,
    // because its failure lands on the request path.
    const probe = await probeDecisionSchema(
      catalogConnection([{ column_name: "policy_id", udt_name: "int8" }]),
    );
    expect(probe.policyColumn).toBe("uuid");
    expect(probe.ready).toBe(false);
  });
});

describe("the remediation SQL", () => {
  it("drops the foreign key before changing the type, since a RESTRICT reference blocks it", () => {
    const fkIdx = DECISION_POLICY_COLUMN_SQL.findIndex((s) => s.includes("DROP CONSTRAINT"));
    const typeIdx = DECISION_POLICY_COLUMN_SQL.findIndex((s) => s.includes("ALTER COLUMN policy_id TYPE"));
    expect(fkIdx).toBeGreaterThanOrEqual(0);
    expect(fkIdx).toBeLessThan(typeIdx);
  });

  it("adds the rlp_ CHECK the catalog declares, so the column is constrained after the change", () => {
    expect(DECISION_POLICY_COLUMN_SQL.join(" ")).toContain("^rlp_[a-z0-9]{8,40}$");
  });

  it("uses IF EXISTS on every drop, so the SQL is safe to re-run", () => {
    for (const sql of [...DECISION_POLICY_COLUMN_SQL, ...DECISION_PRINCIPAL_COLUMN_SQL]) {
      if (sql.includes("DROP")) expect(sql).toContain("IF EXISTS");
    }
  });
});
