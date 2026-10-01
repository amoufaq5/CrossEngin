import { randomUUID } from "node:crypto";

import { sha256 } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { AUDIT_ANCHOR_VERDICTS, type AuditAnchorVerdict } from "./audit-anchor.js";
import { integrityVerdictPayload, type IntegrityProofReport } from "./integrity-proof.js";

/** Narrows the mirror's plain-string anchor verdict to the real enum, faithfully or not at all. */
function anchorVerdictOf(verdict: string): AuditAnchorVerdict {
  const found = AUDIT_ANCHOR_VERDICTS.find((v) => v === verdict);
  if (found === undefined) throw new Error(`not an anchor verdict: ${verdict}`);
  return found;
}

import {
  PostgresIntegrityVerdictStore,
  canonicalStoredReport,
  integrityVerdictPayloadSha256,
  decodeIntegrityVerdictCursor,
  encodeIntegrityVerdictCursor,
  integrityVerdictIdFor,
  integrityVerdictInputFor,
  storedIntegrityReportFor,
  storedReportMismatches,
  withPlatformAudit,
  type IntegrityVerdictAnchor,
  type IntegrityProofReportLike,
  type IntegrityVerdictRecord,
  type StoredIntegrityReport,
} from "./integrity-verdict-store.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";

const SET_PLATFORM_AUDIT_SQL = "SELECT set_config('app.platform_audit', 'on', true)";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface FakeDb {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  /** The settings the last transaction carried, captured when it ended. */
  readonly settings: { tenant: string | null; platformAudit: boolean }[];
  seed(overrides?: Record<string, unknown>): Record<string, unknown>;
}

function reportFor(overrides: Partial<IntegrityProofReportLike> = {}): IntegrityProofReportLike {
  return {
    scope: TENANT_A,
    verdict: "verified",
    verifiedAt: "2026-09-01T00:00:00.000Z",
    chain: {
      ok: true,
      mode: "from_checkpoint",
      checkpointSequence: 7,
      integrity: { valid: true, brokenAt: null },
      signatures: { valid: true },
    },
    anchors: { checked: 4, verified: 4, unanchored: 0, tampered: [] },
    truncation: { checkpointSequence: 7, tailSequence: 9, truncated: false },
    ...overrides,
  };
}

/**
 * Widens the structural mirror back into the real `IntegrityProofReport`, filling the fields the
 * mirror omits because the verdict payload does not commit to them. Only the committed fields
 * matter to the parity check, which is the point: the payload reads nothing else.
 */
function fullReportFor(report: IntegrityProofReportLike): IntegrityProofReport {
  return {
    scope: report.scope,
    verdict: report.verdict,
    verifiedAt: report.verifiedAt,
    chain: {
      tenantId: report.scope,
      ok: report.chain.ok,
      mode: report.chain.mode === "full" ? "full" : "from_checkpoint",
      checkpointSequence: report.chain.checkpointSequence,
      integrity: report.chain.integrity,
      signatures: {
        valid: report.chain.signatures.valid,
        checked: 0,
        results: [],
        unresolvedFingerprints: [],
      },
    },
    anchors:
      report.anchors === null
        ? null
        : {
            tenantId: report.scope ?? "",
            ok: report.anchors.tampered.length === 0 && report.anchors.unanchored === 0,
            checked: report.anchors.checked,
            verified: report.anchors.verified,
            unanchored: report.anchors.unanchored,
            tampered: report.anchors.tampered.map((t) => ({
              auditId: t.auditId,
              verdict: anchorVerdictOf(t.verdict),
              sequenceNumber: t.sequenceNumber,
            })),
            results: [],
          },
    truncation: report.truncation,
  };
}

function anchorAt(chainEntryHash: string, chainSequenceNumber: number): IntegrityVerdictAnchor {
  return { chainEntryHash, chainSequenceNumber };
}

function rowFor(stored: StoredIntegrityReport, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    verdict_id: integrityVerdictIdFor(stored),
    tenant_id: stored.scope,
    verdict: stored.verdict,
    verified_at: new Date(stored.verifiedAt),
    anchors_checked: stored.anchors?.checked ?? 0,
    anchors_verified: stored.anchors?.verified ?? 0,
    anchors_tampered: stored.anchors?.tampered.length ?? 0,
    anchors_unanchored: stored.anchors?.unanchored ?? 0,
    chain_ok: stored.chain.ok,
    truncated: stored.truncation.truncated,
    report: stored,
    chain_entry_hash: "f".repeat(64),
    chain_sequence_number: 12,
    payload_sha256: integrityVerdictPayloadSha256(stored),
    created_at: new Date(stored.verifiedAt),
    ...overrides,
  };
}

/**
 * A scripted fake modelling `meta.audit_integrity_verdicts` under its RLS policy: a row is visible
 * when it belongs to the transaction's `app.current_tenant_id`, OR when `app.platform_audit` has
 * been elevated to 'on'. A NULL `tenant_id` therefore matches NEITHER arm of plain tenant
 * isolation — exactly what `tenant_id = current_setting(...)` does in Postgres — so a platform
 * verdict is only ever visible under the elevation.
 */
function fakeVerdictDb(): FakeDb {
  const captured: Captured[] = [];
  const settings: { tenant: string | null; platformAudit: boolean }[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  let currentTenant: string | null = null;
  let platformAudit = false;

  const visible = (): Record<string, unknown>[] =>
    [...rows.values()].filter(
      (r) => platformAudit || (r["tenant_id"] !== null && r["tenant_id"] === currentTenant),
    );

  const seed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const stored = storedIntegrityReportFor(reportFor());
    const row = rowFor(stored, overrides);
    rows.set(String(row["verdict_id"]), row);
    return row;
  };

  const matchesWindow = (row: Record<string, unknown>, sql: string, p: readonly unknown[]): boolean => {
    const at = (row["verified_at"] as Date).getTime();
    const from = /verified_at >= \$(\d+)/.exec(sql);
    const to = /verified_at < \$(\d+)::timestamptz\b/.exec(sql);
    if (from !== null && at < Date.parse(String(p[Number(from[1]) - 1]))) return false;
    if (to !== null && at >= Date.parse(String(p[Number(to[1]) - 1]))) return false;
    return true;
  };

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p });
    if (sql.includes("set_config")) {
      if (sql.includes("app.platform_audit")) platformAudit = true;
      else currentTenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO")) {
      const verdictId = String(p[0]);
      // The policy's WITH CHECK: a NULL tenant row is only writable under the elevation.
      const scope = p[1];
      if (scope === null && !platformAudit) return { rows: [], rowCount: 0 };
      if (rows.has(verdictId)) return { rows: [], rowCount: 0 };
      const stored = JSON.parse(String(p[10])) as StoredIntegrityReport;
      rows.set(verdictId, {
        id: randomUUID(),
        verdict_id: verdictId,
        tenant_id: scope,
        verdict: p[2],
        verified_at: new Date(String(p[3])),
        anchors_checked: p[4],
        anchors_verified: p[5],
        anchors_tampered: p[6],
        anchors_unanchored: p[7],
        chain_ok: p[8],
        truncated: p[9],
        report: stored,
        chain_entry_hash: p[11],
        chain_sequence_number: p[12],
        payload_sha256: p[13],
        created_at: new Date("2026-09-30T00:00:00.000Z"),
      });
      return { rows: [rows.get(verdictId) as Record<string, unknown>], rowCount: 1 };
    }
    if (sql.includes("count(*)::int")) {
      const tally = new Map<string, number>();
      for (const r of visible().filter((r) => matchesWindow(r, sql, p))) {
        const key = String(r["verdict"]);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      const grouped = [...tally.entries()].map(([verdict, n]) => ({ verdict, n }));
      return { rows: grouped, rowCount: grouped.length };
    }
    if (sql.includes("WHERE verdict_id = $1")) {
      const row = visible().find((r) => r["verdict_id"] === p[0]);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.startsWith("SELECT")) {
      let list = visible().filter((r) => matchesWindow(r, sql, p));
      const idMatch = /verdict_id = \$(\d+)/.exec(sql);
      if (idMatch !== null) list = list.filter((r) => r["verdict_id"] === p[Number(idMatch[1]) - 1]);
      const vMatch = /\bverdict = \$(\d+)/.exec(sql);
      if (vMatch !== null) list = list.filter((r) => r["verdict"] === p[Number(vMatch[1]) - 1]);
      if (sql.includes("tenant_id IS NULL")) list = list.filter((r) => r["tenant_id"] === null);
      const tMatch = /tenant_id = \$(\d+)/.exec(sql);
      if (tMatch !== null) list = list.filter((r) => r["tenant_id"] === p[Number(tMatch[1]) - 1]);
      const seek = /verified_at < \$(\d+)::timestamptz OR/.exec(sql);
      if (seek !== null) {
        const atIdx = Number(seek[1]) - 1;
        const cursorAt = Date.parse(String(p[atIdx]));
        const cursorId = String(p[atIdx + 1]);
        list = list.filter((r) => {
          const at = (r["verified_at"] as Date).getTime();
          return at < cursorAt || (at === cursorAt && String(r["verdict_id"]) < cursorId);
        });
      }
      list.sort((a, b) => {
        const av = (a["verified_at"] as Date).getTime();
        const bv = (b["verified_at"] as Date).getTime();
        if (av !== bv) return bv - av;
        return String(b["verdict_id"]).localeCompare(String(a["verdict_id"]));
      });
      const limitMatch = /LIMIT \$(\d+)/.exec(sql);
      const limit = limitMatch !== null ? Number(p[Number(limitMatch[1]) - 1]) : sql.includes("LIMIT 1") ? 1 : list.length;
      const page = list.slice(0, limit);
      return { rows: page, rowCount: page.length };
    }
    return { rows: [], rowCount: 0 };
  };

  const tx: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params)) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction not supported by fake");
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params)) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
      try {
        return await fn(tx);
      } finally {
        settings.push({ tenant: currentTenant, platformAudit });
        currentTenant = null;
        platformAudit = false;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, captured, settings, seed };
}

/** The first real data query, skipping the `SELECT set_config(...)` elevation statement. */
function dataSelect(db: FakeDb): Captured | undefined {
  return db.captured.find((c) => c.sql.startsWith("SELECT") && c.sql.includes(" FROM "));
}

/** A one-shot connection whose only row is exactly as given — for the re-validation tests. */
function scriptedConn(row: Record<string, unknown>): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string) => {
      if (sql.includes("set_config")) return { rows: [], rowCount: 0 };
      return { rows: [row], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

describe("integrity-verdict-store — projection and id", () => {
  it("projects a proof report onto the shape the chain commits to", () => {
    const stored = storedIntegrityReportFor(reportFor());
    expect(stored).toEqual({
      kind: "audit_integrity_proof",
      scope: TENANT_A,
      verdict: "verified",
      verifiedAt: "2026-09-01T00:00:00.000Z",
      chain: {
        ok: true,
        mode: "from_checkpoint",
        checkpointSequence: 7,
        integrityValid: true,
        brokenAt: null,
        signaturesValid: true,
      },
      truncation: { checkpointSequence: 7, tailSequence: 9, truncated: false },
      anchors: { checked: 4, verified: 4, unanchored: 0, tampered: [] },
    });
  });

  it("keeps a platform report's null scope and null anchors", () => {
    const stored = storedIntegrityReportFor(reportFor({ scope: null, anchors: null }));
    expect(stored.scope).toBeNull();
    expect(stored.anchors).toBeNull();
  });

  it("carries a tampered anchor's coordinates through the projection", () => {
    const stored = storedIntegrityReportFor(
      reportFor({
        verdict: "compromised",
        anchors: {
          checked: 2,
          verified: 1,
          unanchored: 0,
          tampered: [{ auditId: "a1", verdict: "hash_mismatch", sequenceNumber: 3 }],
        },
      }),
    );
    expect(stored.anchors?.tampered).toEqual([
      { auditId: "a1", verdict: "hash_mismatch", sequenceNumber: 3 },
    ]);
  });

  it("rejects an unknown chain mode rather than storing it", () => {
    expect(() =>
      storedIntegrityReportFor(reportFor({ chain: { ...reportFor().chain, mode: "guesswork" } })),
    ).toThrow();
  });

  it("derives a content-addressed aiv_ id matching the column CHECK", () => {
    const id = integrityVerdictIdFor(storedIntegrityReportFor(reportFor()));
    expect(id).toMatch(/^aiv_[a-z0-9]{8,40}$/);
  });

  it("gives the same verdict the same id and a different verdict a different one", () => {
    const a = integrityVerdictIdFor(storedIntegrityReportFor(reportFor()));
    const b = integrityVerdictIdFor(storedIntegrityReportFor(reportFor()));
    const c = integrityVerdictIdFor(
      storedIntegrityReportFor(reportFor({ verifiedAt: "2026-09-01T01:00:00.000Z" })),
    );
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("canonicalises with a fixed key order regardless of how the object was built", () => {
    const stored = storedIntegrityReportFor(reportFor());
    const shuffled = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(stored).reverse())),
    ) as StoredIntegrityReport;
    expect(canonicalStoredReport(shuffled)).toBe(canonicalStoredReport(stored));
  });

  it("builds the whole insert input from a report plus its chain anchor", () => {
    const input = integrityVerdictInputFor(reportFor(), anchorAt("ab".repeat(32), 3));
    expect(input.verdictId).toMatch(/^aiv_/);
    expect(input.anchor).toEqual({ chainEntryHash: "ab".repeat(32), chainSequenceNumber: 3 });
    expect(input.report.verdict).toBe("verified");
  });

  it("defaults to no anchor at all, which is what an unrecorded verdict has", () => {
    expect(integrityVerdictInputFor(reportFor()).anchor).toEqual({
      chainEntryHash: null,
      chainSequenceNumber: null,
    });
  });

  it("derives the payload digest the chain entry commits to, and the id as its prefix", () => {
    const stored = storedIntegrityReportFor(reportFor());
    const digest = integrityVerdictPayloadSha256(stored);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(integrityVerdictIdFor(stored)).toBe(`aiv_${digest.slice(0, 32)}`);
  });

  it("hashes the SAME bytes the chain entry commits to — the parity nothing else enforces", () => {
    // `integrityVerdictPayload` lives in integrity-proof.ts, which imports this store to persist a
    // verdict, so the store cannot import it back. The parity is therefore maintained by hand and
    // pinned here: if these two digests ever diverge, the row and the chain entry are committing to
    // different content and `payload_sha256` stops meaning anything.
    for (const report of [
      reportFor(),
      reportFor({ scope: null, anchors: null }),
      reportFor({
        verdict: "compromised",
        chain: { ...reportFor().chain, mode: "full", ok: false, checkpointSequence: null },
        anchors: {
          checked: 3,
          verified: 1,
          unanchored: 1,
          tampered: [{ auditId: "a1", verdict: "anchor_missing", sequenceNumber: null }],
        },
        truncation: { checkpointSequence: 7, tailSequence: 4, truncated: true },
      }),
    ]) {
      expect(integrityVerdictPayloadSha256(storedIntegrityReportFor(report))).toBe(
        sha256(integrityVerdictPayload(fullReportFor(report))),
      );
    }
  });
});

describe("integrity-verdict-store — RLS path", () => {
  it("elevates with the transaction-local platform-audit flag as the first statement", async () => {
    const { conn, captured } = fakeVerdictDb();
    await withPlatformAudit(conn, async (tx) => {
      await tx.query("SELECT 1");
      return null;
    });
    expect(captured[0]?.sql).toBe(SET_PLATFORM_AUDIT_SQL);
    expect(captured[1]?.sql).toBe("SELECT 1");
  });

  it("a tenant-scoped read sets app.current_tenant_id and NEVER the platform flag", async () => {
    const db = fakeVerdictDb();
    db.seed();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.list({ scope: { kind: "tenant", tenantId: TENANT_A } });
    expect(db.captured.some((c) => c.sql.includes("app.platform_audit"))).toBe(false);
    expect(db.captured[0]?.sql).toContain("app.current_tenant_id");
    expect(db.settings[0]).toEqual({ tenant: TENANT_A, platformAudit: false });
  });

  it("a cross-tenant read sets the platform flag and no tenant context", async () => {
    const db = fakeVerdictDb();
    db.seed();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.list({ scope: { kind: "all" } });
    expect(db.captured[0]?.sql).toBe(SET_PLATFORM_AUDIT_SQL);
    expect(db.settings[0]).toEqual({ tenant: null, platformAudit: true });
  });

  it("releases both settings when the transaction ends, so nothing leaks onto the pool", async () => {
    const db = fakeVerdictDb();
    db.seed();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.list({ scope: { kind: "all" } });
    await store.list({ scope: { kind: "tenant", tenantId: TENANT_A } });
    expect(db.settings).toEqual([
      { tenant: null, platformAudit: true },
      { tenant: TENANT_A, platformAudit: false },
    ]);
  });

  it("binds the tenant id as a WHERE predicate too, not relying on RLS alone", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.list({ scope: { kind: "tenant", tenantId: TENANT_A } });
    const select = dataSelect(db);
    expect(select?.sql).toContain("tenant_id = $1");
    expect(select?.params[0]).toBe(TENANT_A);
  });

  it("narrows the platform scope to tenant_id IS NULL on top of the elevation", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.list({ scope: { kind: "platform" } });
    const select = dataSelect(db);
    expect(select?.sql).toContain("tenant_id IS NULL");
  });

  it("hides a platform verdict from a tenant-scoped read and shows it under elevation", async () => {
    const db = fakeVerdictDb();
    const platform = storedIntegrityReportFor(reportFor({ scope: null, anchors: null }));
    db.seed({ ...rowFor(platform), tenant_id: null, report: platform, verdict_id: integrityVerdictIdFor(platform) });
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const asTenant = await store.list({ scope: { kind: "tenant", tenantId: TENANT_A } });
    const asPlatform = await store.list({ scope: { kind: "platform" } });
    expect(asTenant.data.filter((r) => r.scope === null)).toHaveLength(0);
    expect(asPlatform.data.map((r) => r.scope)).toEqual([null]);
  });

  it("does not show one tenant's verdicts to another", async () => {
    const db = fakeVerdictDb();
    db.seed();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const page = await store.list({ scope: { kind: "tenant", tenantId: TENANT_B } });
    expect(page.data).toEqual([]);
  });

  it("refuses an invalid schema identifier at construction", () => {
    expect(() => new PostgresIntegrityVerdictStore(fakeVerdictDb().conn, { schema: "me ta" })).toThrow(
      /invalid schema identifier/,
    );
  });
});

describe("integrity-verdict-store — record", () => {
  it("writes a tenant verdict under its tenant context and returns inserted", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const result = await store.record(integrityVerdictInputFor(reportFor(), anchorAt("c".repeat(64), 5)));
    expect(result.inserted).toBe(true);
    expect(result.record.scope).toBe(TENANT_A);
    expect(result.record.chainEntryHash).toBe("c".repeat(64));
    expect(db.captured[0]?.sql).toContain("app.current_tenant_id");
  });

  it("writes a platform verdict under the elevation, since NULL fails tenant isolation", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const result = await store.record(
      integrityVerdictInputFor(reportFor({ scope: null, anchors: null }), anchorAt("d".repeat(64), 6)),
    );
    expect(db.captured[0]?.sql).toBe(SET_PLATFORM_AUDIT_SQL);
    expect(result.record.scope).toBeNull();
    expect(result.record.anchorsChecked).toBe(0);
  });

  it("binds the summary columns from the report, including the tampered count", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.record(
      integrityVerdictInputFor(
        reportFor({
          verdict: "compromised",
          chain: { ...reportFor().chain, ok: false },
          anchors: {
            checked: 3,
            verified: 1,
            unanchored: 1,
            tampered: [{ auditId: "a1", verdict: "hash_mismatch", sequenceNumber: 2 }],
          },
          truncation: { checkpointSequence: 7, tailSequence: 4, truncated: true },
        }),
      ),
    );
    const insert = db.captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.params.slice(2, 10)).toEqual([
      "compromised",
      "2026-09-01T00:00:00.000Z",
      3,
      1,
      1,
      1,
      false,
      true,
    ]);
  });

  it("is idempotent on the content-addressed id: a replayed pass inserts nothing", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const input = integrityVerdictInputFor(reportFor(), anchorAt("e".repeat(64), 7));
    const first = await store.record(input);
    const second = await store.record(input);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.record.verdictId).toBe(first.record.verdictId);
  });

  it("uses ON CONFLICT DO NOTHING rather than an upsert, so a stored verdict is never rewritten", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.record(integrityVerdictInputFor(reportFor()));
    const insert = db.captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("ON CONFLICT (verdict_id) DO NOTHING");
    expect(insert?.sql).not.toContain("DO UPDATE");
  });

  it("refuses to write half an anchor, before opening a transaction", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const input = integrityVerdictInputFor(reportFor());
    await expect(
      store.record({ ...input, anchor: { chainEntryHash: "a".repeat(64), chainSequenceNumber: null } }),
    ).rejects.toThrow(/both a chain entry hash and a sequence/);
    expect(db.captured).toEqual([]);
  });

  it("derives payload_sha256 itself rather than taking it from the caller", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const input = integrityVerdictInputFor(reportFor(), anchorAt("b".repeat(64), 9));
    const result = await store.record(input);
    const insert = db.captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.params.slice(11)).toEqual([
      "b".repeat(64),
      9,
      integrityVerdictPayloadSha256(input.report),
    ]);
    expect(result.record.chainSequenceNumber).toBe(9);
    expect(result.record.payloadSha256).toBe(integrityVerdictPayloadSha256(input.report));
  });

  it("refuses a verdict id the column CHECK would reject, before opening a transaction", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const input = integrityVerdictInputFor(reportFor());
    await expect(store.record({ ...input, verdictId: "nope_1234" })).rejects.toThrow(
      /invalid verdict id/,
    );
    expect(db.captured).toEqual([]);
  });

  it("refuses a report that does not satisfy the stored projection schema", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const input = integrityVerdictInputFor(reportFor());
    const broken = { ...input.report, verdict: "probably_fine" } as unknown as StoredIntegrityReport;
    await expect(store.record({ ...input, report: broken })).rejects.toThrow();
  });
});

describe("integrity-verdict-store — list, counts, latest", () => {
  it("orders by verified_at DESC with a verdict_id tiebreaker and a keyset LIMIT(+1)", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.list({ scope: { kind: "all" }, limit: 10 });
    const select = dataSelect(db);
    expect(select?.sql).toContain("ORDER BY verified_at DESC, verdict_id DESC");
    expect(select?.params.at(-1)).toBe(11);
  });

  it("clamps the limit to the 200 ceiling and defaults to 50", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.list({ scope: { kind: "all" }, limit: 9999 });
    await store.list({ scope: { kind: "all" } });
    const selects = db.captured.filter((c) => c.sql.includes(" FROM ") && c.sql.includes("LIMIT $"));
    expect(selects[0]?.params.at(-1)).toBe(201);
    expect(selects[1]?.params.at(-1)).toBe(51);
  });

  it("pushes the verdict filter and the half-open time window into SQL", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.list({
      scope: { kind: "all" },
      verdict: "compromised",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    });
    const select = dataSelect(db);
    expect(select?.sql).toContain("verdict = $1");
    expect(select?.sql).toContain("verified_at >= $2::timestamptz");
    expect(select?.sql).toContain("verified_at < $3::timestamptz");
  });

  it("pages by keyset, not offset, and the next page excludes the cursor row", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    for (const hour of [1, 2, 3]) {
      await store.record(
        integrityVerdictInputFor(
          reportFor({ verifiedAt: `2026-09-01T0${hour.toString()}:00:00.000Z` }),
        ),
      );
    }
    const first = await store.list({ scope: { kind: "all" }, limit: 2 });
    expect(first.data.map((r) => r.verifiedAt)).toEqual([
      "2026-09-01T03:00:00.000Z",
      "2026-09-01T02:00:00.000Z",
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.list({
      scope: { kind: "all" },
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    expect(second.data.map((r) => r.verifiedAt)).toEqual(["2026-09-01T01:00:00.000Z"]);
    expect(second.nextCursor).toBeNull();
    const seek = db.captured.find((c) => c.sql.includes("verified_at < $"));
    expect(seek?.sql).not.toContain("OFFSET");
  });

  it("refuses a malformed cursor rather than silently returning the first page", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await expect(store.list({ scope: { kind: "all" }, cursor: "not-a-cursor" })).rejects.toThrow(
      /invalid integrity verdict cursor/,
    );
  });

  it("tallies verdicts over the same scope and window", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.record(integrityVerdictInputFor(reportFor()));
    await store.record(
      integrityVerdictInputFor(
        reportFor({ verdict: "unproven", verifiedAt: "2026-09-02T00:00:00.000Z" }),
      ),
    );
    const counts = await store.counts({ scope: { kind: "all" } });
    expect(counts).toEqual({ verified: 1, unproven: 1, compromised: 0, total: 2 });
  });

  it("counts only inside the window", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    await store.record(integrityVerdictInputFor(reportFor()));
    const counts = await store.counts({
      scope: { kind: "all" },
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
    });
    expect(counts.total).toBe(0);
  });

  it("returns the newest verdict in scope, or null when there is none", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    expect(await store.latest({ kind: "all" })).toBeNull();
    await store.record(integrityVerdictInputFor(reportFor()));
    await store.record(
      integrityVerdictInputFor(reportFor({ verifiedAt: "2026-09-05T00:00:00.000Z" })),
    );
    expect((await store.latest({ kind: "all" }))?.verifiedAt).toBe("2026-09-05T00:00:00.000Z");
  });

  it("fetches one verdict by id within scope and refuses a malformed id without querying", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const written = await store.record(integrityVerdictInputFor(reportFor()));
    const found = await store.getByVerdictId(written.record.verdictId, { kind: "all" });
    expect(found?.verdictId).toBe(written.record.verdictId);
    const before = db.captured.length;
    expect(await store.getByVerdictId("bogus", { kind: "all" })).toBeNull();
    expect(db.captured.length).toBe(before);
  });

  it("does not find another tenant's verdict by naming its id", async () => {
    const db = fakeVerdictDb();
    const store = new PostgresIntegrityVerdictStore(db.conn);
    const written = await store.record(integrityVerdictInputFor(reportFor()));
    const found = await store.getByVerdictId(written.record.verdictId, {
      kind: "tenant",
      tenantId: TENANT_B,
    });
    expect(found).toBeNull();
  });
});

describe("integrity-verdict-store — re-validation on read", () => {
  it("parses a well-formed row, including a JSONB report handed back as text", async () => {
    const stored = storedIntegrityReportFor(reportFor());
    const row = rowFor(stored, { report: JSON.stringify(stored) });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    const record = await store.getByVerdictId(String(row["verdict_id"]), { kind: "all" });
    expect(record?.report.verdict).toBe("verified");
  });

  it("refuses a row whose verdict column was edited away from its report", async () => {
    const stored = storedIntegrityReportFor(reportFor({ verdict: "compromised" }));
    const row = rowFor(stored, { verdict: "verified" });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    await expect(store.getByVerdictId(String(row["verdict_id"]), { kind: "all" })).rejects.toThrow(
      /disagrees with its report/,
    );
  });

  it("refuses a row whose truncated flag was cleared while the report still says truncated", async () => {
    const stored = storedIntegrityReportFor(
      reportFor({ truncation: { checkpointSequence: 7, tailSequence: 4, truncated: true } }),
    );
    const row = rowFor(stored, { truncated: false });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    await expect(store.getByVerdictId(String(row["verdict_id"]), { kind: "all" })).rejects.toThrow(
      /truncated/,
    );
  });

  it("refuses a row whose tampered count was zeroed", async () => {
    const stored = storedIntegrityReportFor(
      reportFor({
        verdict: "compromised",
        anchors: {
          checked: 2,
          verified: 1,
          unanchored: 0,
          tampered: [{ auditId: "a1", verdict: "hash_mismatch", sequenceNumber: 3 }],
        },
      }),
    );
    const row = rowFor(stored, { anchors_tampered: 0 });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    await expect(store.getByVerdictId(String(row["verdict_id"]), { kind: "all" })).rejects.toThrow(
      /anchorsTampered/,
    );
  });

  it("refuses a row whose report JSONB was replaced with something unparseable", async () => {
    const stored = storedIntegrityReportFor(reportFor());
    const row = rowFor(stored, { report: "{not json" });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    await expect(store.getByVerdictId(String(row["verdict_id"]), { kind: "all" })).rejects.toThrow();
  });

  it("refuses a row carrying a verdict the CHECK constraint does not allow", async () => {
    const stored = storedIntegrityReportFor(reportFor());
    const row = rowFor(stored, { verdict: "probably_fine" });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    await expect(store.getByVerdictId(String(row["verdict_id"]), { kind: "all" })).rejects.toThrow();
  });

  it("accepts a null chain_ok as 'not recorded' rather than as disagreement", async () => {
    const stored = storedIntegrityReportFor(reportFor());
    const row = rowFor(stored, { chain_ok: null });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    const record = await store.getByVerdictId(String(row["verdict_id"]), { kind: "all" });
    expect(record?.chainOk).toBeNull();
  });

  it("names every disagreement, not only the first", () => {
    const stored = storedIntegrityReportFor(reportFor({ verdict: "compromised" }));
    const record = {
      id: randomUUID(),
      verdictId: integrityVerdictIdFor(stored),
      scope: TENANT_B,
      verdict: "verified",
      verifiedAt: "2026-09-01T00:00:00.000Z",
      anchorsChecked: 4,
      anchorsVerified: 4,
      anchorsTampered: 9,
      anchorsUnanchored: 0,
      chainOk: true,
      truncated: false,
      report: stored,
      chainEntryHash: null,
      chainSequenceNumber: null,
      payloadSha256: integrityVerdictPayloadSha256(stored),
      createdAt: "2026-09-01T00:00:00.000Z",
    } as IntegrityVerdictRecord;
    const issues = storedReportMismatches(record);
    expect(issues.join(" ")).toContain("verdict");
    expect(issues.join(" ")).toContain("scope");
    expect(issues.join(" ")).toContain("anchorsTampered");
    expect(issues.length).toBe(3);
  });

  it("refuses a row whose unanchored count was zeroed to turn unproven into verified", async () => {
    const stored = storedIntegrityReportFor(
      reportFor({ verdict: "unproven", anchors: { checked: 4, verified: 3, unanchored: 1, tampered: [] } }),
    );
    const row = rowFor(stored, { anchors_unanchored: 0 });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    await expect(store.getByVerdictId(String(row["verdict_id"]), { kind: "all" })).rejects.toThrow(
      /anchorsUnanchored/,
    );
  });

  it("refuses a row whose report was rewritten while payload_sha256 still names the original", async () => {
    const original = storedIntegrityReportFor(reportFor({ verdict: "compromised" }));
    const rewritten = storedIntegrityReportFor(reportFor({ verdict: "verified" }));
    // Every column made consistent with the rewrite, so only the digest betrays it — the exact
    // tamper this column exists to catch.
    const row = rowFor(rewritten, {
      verdict_id: integrityVerdictIdFor(rewritten),
      payload_sha256: integrityVerdictPayloadSha256(original),
    });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    await expect(store.getByVerdictId(String(row["verdict_id"]), { kind: "all" })).rejects.toThrow(
      /payloadSha256/,
    );
  });

  it("refuses a row whose verdict id does not match the report it carries", async () => {
    const stored = storedIntegrityReportFor(reportFor());
    const row = rowFor(stored, { verdict_id: "aiv_deadbeef", payload_sha256: null });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    await expect(store.getByVerdictId("aiv_deadbeef", { kind: "all" })).rejects.toThrow(/verdictId/);
  });

  it("refuses a half-present anchor in either direction", async () => {
    const stored = storedIntegrityReportFor(reportFor());
    for (const overrides of [
      { chain_sequence_number: null },
      { chain_entry_hash: null },
    ]) {
      const row = rowFor(stored, overrides);
      const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
      await expect(store.getByVerdictId(String(row["verdict_id"]), { kind: "all" })).rejects.toThrow(
        /half-present/,
      );
    }
  });

  it("accepts a row with no anchor at all, which recordVerdict: false produces", async () => {
    const stored = storedIntegrityReportFor(reportFor());
    const row = rowFor(stored, {
      chain_entry_hash: null,
      chain_sequence_number: null,
      payload_sha256: null,
    });
    const store = new PostgresIntegrityVerdictStore(scriptedConn(row));
    const record = await store.getByVerdictId(String(row["verdict_id"]), { kind: "all" });
    expect(record?.chainEntryHash).toBeNull();
    expect(record?.payloadSha256).toBeNull();
  });
});

describe("integrity-verdict-store — cursor codec", () => {
  it("round-trips a cursor", () => {
    const cursor = { verifiedAt: "2026-09-01T00:00:00.000Z", verdictId: "aiv_abcdef12" };
    expect(decodeIntegrityVerdictCursor(encodeIntegrityVerdictCursor(cursor))).toEqual(cursor);
  });

  it("returns null for an absent, empty, garbled or wrongly-shaped cursor", () => {
    expect(decodeIntegrityVerdictCursor(undefined)).toBeNull();
    expect(decodeIntegrityVerdictCursor("")).toBeNull();
    expect(decodeIntegrityVerdictCursor("!!!!")).toBeNull();
    expect(
      decodeIntegrityVerdictCursor(Buffer.from("v1:nope:aiv_abcdef12").toString("base64url")),
    ).toBeNull();
    expect(
      decodeIntegrityVerdictCursor(
        Buffer.from("v1:2026-09-01T00:00:00.000Z:xx_1").toString("base64url"),
      ),
    ).toBeNull();
  });
});
