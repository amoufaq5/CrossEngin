import { describe, expect, it } from "vitest";
import { ScopedWriteRefusedError } from "@crossengin/kernel-pg";

import {
  EVIDENCE_STORE_REFUSALS,
  RECOMPILABLE_COLUMNS,
  EvidenceStoreRefusedError,
  PostgresAccessReviewEvidenceStore,
} from "./evidence-store.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";
import {
  FakeConn,
  UUIDS,
  evidenceRowFor,
  makeCompiledEvidence,
  makeSealedEvidence,
  type QueryResponder,
} from "./test-fakes.js";

/** One affected row for every write; rows for a read when `rows` is supplied. */
const responder =
  (rows: Record<string, unknown>[] = [], rowCount = 1): QueryResponder =>
  (sql) =>
    sql.trimStart().toUpperCase().startsWith("SELECT")
      ? { rows, rowCount: rows.length }
      : { rows: [], rowCount };

const store = (conn: FakeConn) => new PostgresAccessReviewEvidenceStore(conn);

describe("PostgresAccessReviewEvidenceStore.compile", () => {
  it("runs inside the tenant RLS context before the INSERT", async () => {
    const conn = new FakeConn(responder());
    await store(conn).compile(makeCompiledEvidence());
    expect(conn.calls[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(conn.calls[0]?.params).toEqual([UUIDS.tenant]);
    expect(conn.calls[1]?.sql).toContain("INSERT INTO meta.access_review_evidence");
  });

  it("names every column the catalog declares, in catalog order", async () => {
    const conn = new FakeConn(responder());
    await store(conn).compile(makeCompiledEvidence());
    const sql = conn.find("INSERT INTO meta.access_review_evidence")?.sql ?? "";
    for (const col of [
      "evidence_id",
      "tenant_id",
      "framework",
      "period_start_at",
      "period_end_at",
      "campaign_ids",
      "control_mappings",
      "total_items_across_campaigns",
      "completion_rate",
      "keep_rate",
      "revoke_rate",
      "auto_revoke_rate",
      "exception_rate",
      "strong_attestation_rate",
      "overdue_rate",
      "status",
      "compiled_at",
      "sealed_at",
      "sealed_sha256",
      "submitted_at",
      "submitted_to_auditor_id",
      "accepted_at",
      "rejected_at",
      "rejected_reason",
      "storage_uri",
      "created_by",
      "created_at",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("binds the row in order, with the two JSONB columns stringified", async () => {
    const conn = new FakeConn(responder());
    const ev = makeCompiledEvidence();
    await store(conn).compile(ev);
    const params = conn.find("INSERT INTO meta.access_review_evidence")?.params ?? [];
    expect(params[0]).toBe(ev.id);
    expect(params[1]).toBe(ev.tenantId);
    expect(params[2]).toBe("soc2_type2");
    expect(params[5]).toBe(JSON.stringify(ev.campaignIds));
    expect(params[6]).toBe(JSON.stringify(ev.controlMappings));
    expect(params[7]).toBe(3);
    expect(params[8]).toBe(ev.completionRate);
    expect(params[25]).toBe(ev.createdBy);
  });

  it("upserts on evidence_id so a re-compilation lands on the period's own row", async () => {
    const conn = new FakeConn(responder());
    await store(conn).compile(makeCompiledEvidence());
    const sql = conn.find("INSERT INTO meta.access_review_evidence")?.sql ?? "";
    expect(sql).toContain("ON CONFLICT (evidence_id) DO UPDATE SET");
  });

  it("qualifies every guard column, because a bare one is ambiguous against EXCLUDED", async () => {
    const conn = new FakeConn(responder());
    await store(conn).compile(makeCompiledEvidence());
    const sql = conn.find("INSERT INTO meta.access_review_evidence")?.sql ?? "";
    const guard = sql.slice(sql.indexOf("DO UPDATE SET"));
    const where = guard.slice(guard.indexOf("WHERE"));
    expect(where).not.toMatch(/\bWHERE tenant_id\b/);
    expect(where).not.toMatch(/\bAND status\b/);
    expect(where).toContain("access_review_evidence.tenant_id");
    expect(where).toContain("access_review_evidence.status");
  });

  it("guards the DO UPDATE on the pre-seal statuses, not on nothing", async () => {
    const conn = new FakeConn(responder());
    await store(conn).compile(makeCompiledEvidence());
    const sql = conn.find("INSERT INTO meta.access_review_evidence")?.sql ?? "";
    expect(sql).toContain("access_review_evidence.status = ANY($29::text[])");
    const params = conn.find("INSERT INTO meta.access_review_evidence")?.params ?? [];
    expect(params[28]).toEqual(["draft", "compiled"]);
  });

  it("carries a strict tenant_id predicate on the DO UPDATE", async () => {
    const conn = new FakeConn(responder());
    await store(conn).compile(makeCompiledEvidence());
    const call = conn.find("INSERT INTO meta.access_review_evidence");
    // Qualified: a bare `tenant_id` in a DO UPDATE's WHERE is `42702` ambiguous, found live.
    expect(call?.sql).toContain("WHERE access_review_evidence.tenant_id = $28");
    expect(call?.sql).not.toContain("tenant_id IS NULL");
    expect(call?.params?.[27]).toBe(UUIDS.tenant);
  });

  it("never lets the DO UPDATE move the row's identity or its author", async () => {
    const conn = new FakeConn(responder());
    await store(conn).compile(makeCompiledEvidence());
    const sql = conn.find("INSERT INTO meta.access_review_evidence")?.sql ?? "";
    for (const immutable of ["evidence_id", "tenant_id", "framework", "created_by", "created_at"]) {
      expect(sql).not.toContain(`${immutable} = EXCLUDED.${immutable}`);
    }
  });

  it("does move every figure the seal digest commits to", async () => {
    const conn = new FakeConn(responder());
    await store(conn).compile(makeCompiledEvidence());
    const sql = conn.find("INSERT INTO meta.access_review_evidence")?.sql ?? "";
    for (const col of [
      "completion_rate",
      "keep_rate",
      "revoke_rate",
      "auto_revoke_rate",
      "exception_rate",
      "strong_attestation_rate",
      "overdue_rate",
      "total_items_across_campaigns",
      "campaign_ids",
      "control_mappings",
      "period_start_at",
      "period_end_at",
    ]) {
      expect(sql).toContain(`${col} = EXCLUDED.${col}`);
    }
  });

  it("spells the SET list literally, and it matches RECOMPILABLE_COLUMNS exactly", async () => {
    // The literal exists so `pg-column-coverage` can read the columns as text rather than reporting
    // an interpolation it cannot evaluate. This is the assertion that keeps the two from drifting.
    const conn = new FakeConn(responder());
    await store(conn).compile(makeCompiledEvidence());
    const sql = conn.find("INSERT INTO meta.access_review_evidence")?.sql ?? "";
    const setClause = sql.slice(
      sql.indexOf("DO UPDATE SET") + "DO UPDATE SET".length,
      sql.indexOf("WHERE access_review_evidence"),
    );
    const named = [...setClause.matchAll(/(\w+) = EXCLUDED\.\w+/g)].map((m) => m[1]);
    expect(named).toEqual([...RECOMPILABLE_COLUMNS]);
  });

  it("is not DO NOTHING, which would drop a re-compilation silently", async () => {
    const conn = new FakeConn(responder());
    await store(conn).compile(makeCompiledEvidence());
    expect(conn.find("INSERT INTO meta.access_review_evidence")?.sql).not.toContain("DO NOTHING");
  });

  it("throws rather than returning when the guard refuses, since `INSERT 0 0` is ambiguous", async () => {
    // Zero rows affected, and the diagnosing re-read finds the row in another scope.
    const conn = new FakeConn((sql) =>
      sql.trimStart().toUpperCase().startsWith("SELECT TENANT_ID")
        ? { rows: [{ tenant_id: UUIDS.reviewer }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    await expect(store(conn).compile(makeCompiledEvidence())).rejects.toBeInstanceOf(
      ScopedWriteRefusedError,
    );
  });

  it("names `guard_refused` when the row is in this scope and the status refused it", async () => {
    const conn = new FakeConn((sql) =>
      sql.trimStart().toUpperCase().startsWith("SELECT TENANT_ID")
        ? { rows: [{ tenant_id: UUIDS.tenant }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    await expect(store(conn).compile(makeCompiledEvidence())).rejects.toThrow(
      /guard_refused.*sealedSha256 commits to/s,
    );
  });

  it("names `row_absent` when no row anywhere carries the id", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    await expect(store(conn).compile(makeCompiledEvidence())).rejects.toThrow(/row_absent/);
  });

  it("refuses a sealed record, which belongs to seal()", async () => {
    const conn = new FakeConn(responder());
    await expect(store(conn).compile(makeSealedEvidence())).rejects.toBeInstanceOf(
      EvidenceStoreRefusedError,
    );
    expect(conn.calls).toHaveLength(0);
  });

  it("refuses an over-precise rate before touching SQL, naming the field", async () => {
    const conn = new FakeConn(responder());
    const bad = { ...makeCompiledEvidence(), completionRate: 2 / 3 };
    await expect(store(conn).compile(bad)).rejects.toThrow(/rate_not_quantized.*completionRate/s);
    expect(conn.calls).toHaveLength(0);
  });

  it("explains why rounding at the store boundary would be wrong", async () => {
    const conn = new FakeConn(responder());
    const bad = { ...makeCompiledEvidence(), overdueRate: 1 / 7 };
    await expect(store(conn).compile(bad)).rejects.toThrow(/unverifiable against its own sealedSha256/);
  });

  it("accepts a draft record, the other pre-seal status", async () => {
    const conn = new FakeConn(responder());
    const draft = makeCompiledEvidence({ status: "draft", compiledAt: null });
    await expect(store(conn).compile(draft)).resolves.toBeUndefined();
  });
});

describe("PostgresAccessReviewEvidenceStore.seal", () => {
  it("re-asserts status = 'compiled' in the predicate rather than reading first", async () => {
    const conn = new FakeConn(responder());
    await store(conn).seal(makeSealedEvidence());
    const sql = conn.find("UPDATE meta.access_review_evidence")?.sql ?? "";
    expect(sql).toContain("AND status = 'compiled'");
    expect(conn.calls.filter((c) => c.sql.includes("FROM meta.access_review_evidence"))).toHaveLength(0);
  });

  it("carries the strict scope predicate", async () => {
    const conn = new FakeConn(responder());
    await store(conn).seal(makeSealedEvidence());
    const call = conn.find("UPDATE meta.access_review_evidence");
    expect(call?.sql).toContain("tenant_id = $5");
    expect(call?.params?.[4]).toBe(UUIDS.tenant);
  });

  it("writes only the four seal columns", async () => {
    const conn = new FakeConn(responder());
    await store(conn).seal(makeSealedEvidence());
    const sql = conn.find("UPDATE meta.access_review_evidence")?.sql ?? "";
    expect(sql).toContain("SET status = 'sealed'");
    expect(sql).toContain("sealed_at = $1");
    expect(sql).toContain("sealed_sha256 = $2");
    expect(sql).toContain("storage_uri = $3");
    // Everything before WHERE is the SET list, and no figure may be in it: a seal stamps the
    // digest onto figures already there rather than rewriting them alongside it.
    const setClause = sql.slice(0, sql.indexOf("WHERE"));
    for (const col of ["completion_rate", "keep_rate", "total_items_across_campaigns", "campaign_ids"]) {
      expect(setClause).not.toContain(col);
    }
  });

  it("writes the digest verbatim and never recomputes it", async () => {
    const conn = new FakeConn(responder());
    const ev = makeSealedEvidence({ sealedSha256: "b".repeat(64) });
    await store(conn).seal(ev);
    expect(conn.find("UPDATE meta.access_review_evidence")?.params?.[1]).toBe("b".repeat(64));
  });

  it("requires every figure the digest commits to to still match the row", async () => {
    const conn = new FakeConn(responder());
    const ev = makeSealedEvidence();
    await store(conn).seal(ev);
    const call = conn.find("UPDATE meta.access_review_evidence");
    const sql = call?.sql ?? "";
    for (const col of [
      "completion_rate",
      "keep_rate",
      "revoke_rate",
      "auto_revoke_rate",
      "exception_rate",
      "strong_attestation_rate",
      "overdue_rate",
    ]) {
      expect(sql).toContain(`AND ${col} = $`);
    }
    expect(sql).toContain("AND total_items_across_campaigns = $13");
    expect(call?.params?.slice(5, 12)).toEqual([
      ev.completionRate,
      ev.keepRate,
      ev.revokeRate,
      ev.autoRevokeRate,
      ev.exceptionRate,
      ev.strongAttestationRate,
      ev.overdueRate,
    ]);
    expect(call?.params?.[12]).toBe(ev.totalItemsAcrossCampaigns);
  });

  it("casts each figure to the column's own NUMERIC(5, 4), so the comparison can match", async () => {
    const conn = new FakeConn(responder());
    await store(conn).seal(makeSealedEvidence());
    expect(conn.find("UPDATE meta.access_review_evidence")?.sql).toContain("::numeric(5, 4)");
  });

  it("throws when the row refused the seal", async () => {
    const conn = new FakeConn((sql) =>
      sql.trimStart().toUpperCase().startsWith("SELECT TENANT_ID")
        ? { rows: [{ tenant_id: UUIDS.tenant }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    await expect(store(conn).seal(makeSealedEvidence())).rejects.toThrow(
      /guard_refused.*different figures/s,
    );
  });

  it("refuses a record that is not sealed", async () => {
    const conn = new FakeConn(responder());
    await expect(store(conn).seal(makeCompiledEvidence())).rejects.toThrow(
      /wrong_status_for_operation/,
    );
    expect(conn.calls).toHaveLength(0);
  });

  it("names every store refusal exactly once", () => {
    expect(new Set(EVIDENCE_STORE_REFUSALS).size).toBe(EVIDENCE_STORE_REFUSALS.length);
  });
});

describe("PostgresAccessReviewEvidenceStore reads", () => {
  it("latestSealedForFramework carries a strict scope predicate and a total ordering", async () => {
    const conn = new FakeConn(responder());
    await store(conn).latestSealedForFramework(UUIDS.tenant, "soc2_type2");
    const call = conn.find("FROM meta.access_review_evidence");
    expect(call?.sql).toContain("tenant_id = $2");
    expect(call?.sql).toContain("ORDER BY period_end_at DESC, evidence_id DESC");
    expect(call?.params).toEqual(["soc2_type2", UUIDS.tenant]);
  });

  it("latestSealedForFramework filters to the three statuses the assessor accepts", async () => {
    const conn = new FakeConn(responder());
    await store(conn).latestSealedForFramework(UUIDS.tenant, "soc2_type2");
    expect(conn.find("FROM meta.access_review_evidence")?.sql).toContain(
      "status IN ('sealed', 'submitted_to_auditor', 'accepted_by_auditor')",
    );
  });

  it("answers null for an empty scope", async () => {
    const conn = new FakeConn(responder());
    expect(await store(conn).latestSealedForFramework(UUIDS.tenant, "soc2_type2")).toBeNull();
  });

  it("re-parses a stored row through the real schema", async () => {
    const sealed = makeSealedEvidence();
    const conn = new FakeConn(responder([evidenceRowFor(sealed)]));
    const got = await store(conn).latestSealedForFramework(UUIDS.tenant, "soc2_type2");
    expect(got).toEqual(sealed);
  });

  it("parses NUMERIC columns arriving as strings and TIMESTAMPTZ arriving as Dates", async () => {
    const sealed = makeSealedEvidence();
    const row = evidenceRowFor(sealed);
    expect(typeof row["completion_rate"]).toBe("string");
    expect(row["period_end_at"]).toBeInstanceOf(Date);
    const conn = new FakeConn(responder([row]));
    const got = await store(conn).getByEvidenceId(UUIDS.tenant, sealed.id);
    expect(got?.completionRate).toBe(0.6667);
    expect(got?.periodEndAt).toBe("2026-03-31T00:00:00.000Z");
  });

  it("refuses a row the contract forbids, which no CHECK constraint catches", async () => {
    // `sealed` with no digest: a status↔field pairing enforced only by the schema's superRefine.
    const broken = { ...evidenceRowFor(makeSealedEvidence()), sealed_sha256: null };
    const conn = new FakeConn(responder([broken]));
    await expect(store(conn).getByEvidenceId(UUIDS.tenant, "arv_aaaaaaaa")).rejects.toThrow();
  });

  it("refuses a row whose NUMERIC column cannot be read rather than reporting 0", async () => {
    const broken = { ...evidenceRowFor(makeSealedEvidence()), completion_rate: "not-a-number" };
    const conn = new FakeConn(responder([broken]));
    await expect(store(conn).getByEvidenceId(UUIDS.tenant, "arv_aaaaaaaa")).rejects.toThrow(
      /completion_rate/,
    );
  });

  it("getByEvidenceId does not interpolate the id into the SQL", async () => {
    const conn = new FakeConn(responder());
    await store(conn).getByEvidenceId(UUIDS.tenant, "arv_aaaaaaaabbbbbbbbcccccccc");
    expect(conn.find("FROM meta.access_review_evidence")?.sql).not.toContain("arv_aaaa");
  });

  it("listByTenant scopes and orders totally", async () => {
    const conn = new FakeConn(responder());
    await store(conn).listByTenant(UUIDS.tenant);
    const call = conn.find("FROM meta.access_review_evidence");
    expect(call?.sql).toContain("WHERE tenant_id = $1");
    expect(call?.sql).toContain("ORDER BY period_end_at ASC, evidence_id ASC");
    expect(call?.params).toEqual([UUIDS.tenant]);
  });

  it("rejects a tenant id that could never be one", async () => {
    const conn = new FakeConn(responder());
    await expect(store(conn).listByTenant("not a uuid")).rejects.toThrow(/invalid tenantId/);
  });
});
