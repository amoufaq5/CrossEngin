import type { PgConnection } from "@crossengin/kernel-pg";
import {
  PackInstallationSchema,
  PackVersionRecordSchema,
  type PackInstallation,
  type PackVersionRecord,
} from "@crossengin/marketplace";

import type { InstallationRow } from "./records.js";

export const FAKE_TENANT = "00000000-0000-4000-8000-000000000001";
export const FAKE_USER = "00000000-0000-4000-8000-0000000000aa";

/** A fake PgConnection over an in-memory row map that honors the tenant RLS context. */
export function fakePg(): { conn: PgConnection; rows: Map<string, InstallationRow> } {
  const rows = new Map<string, InstallationRow>();
  let tenantCtx: string | null = null;

  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("set_config")) {
      tenantCtx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO")) {
      const row: InstallationRow = {
        id: String(p[0]),
        tenant_id: String(p[1]),
        pack_id: String(p[2]),
        installed_version: (p[3] as string | null) ?? null,
        pinned_version: (p[4] as string | null) ?? null,
        status: String(p[5]),
        update_policy: String(p[6]),
        config: JSON.parse(String(p[7])),
        permission_grants: JSON.parse(String(p[8])),
        requested_at: String(p[9]),
        requested_by: String(p[10]),
        installed_at: (p[11] as string | null) ?? null,
        installed_by: (p[12] as string | null) ?? null,
        last_updated_at: (p[13] as string | null) ?? null,
        uninstalled_at: (p[14] as string | null) ?? null,
        uninstalled_by: (p[15] as string | null) ?? null,
        failure_reason: (p[16] as string | null) ?? null,
        isolation_sandbox: (p[17] as string | null) ?? null,
      };
      rows.set(row.id, row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT")) {
      let visible = [...rows.values()].filter((r) => tenantCtx !== null && r.tenant_id === tenantCtx);
      visible = visible.filter((r) => r.tenant_id === p[0]);
      if (sql.includes("AND id = $2")) visible = visible.filter((r) => r.id === p[1]);
      if (sql.includes("AND pack_id = $2")) {
        visible = visible.filter((r) => r.pack_id === p[1] && r.status !== "uninstalled" && r.status !== "failed");
      }
      visible.sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)) || a.id.localeCompare(b.id));
      return { rows: visible, rowCount: visible.length };
    }
    return { rows: [], rowCount: 0 };
  };

  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const before = tenantCtx;
      try {
        return await fn(conn);
      } finally {
        tenantCtx = before;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, rows };
}

/** A schema-valid `PackInstallation` fixture (default `installing`, tenant FAKE_TENANT). */
export function fakeInstallation(overrides: Partial<PackInstallation> = {}): PackInstallation {
  return PackInstallationSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: FAKE_TENANT,
    packId: "com.crossengin.example",
    installedVersion: null,
    pinnedVersion: null,
    status: "installing",
    updatePolicy: "manual",
    config: {},
    permissionGrants: [],
    requestedAt: "2026-05-16T12:00:00.000Z",
    requestedBy: FAKE_USER,
    installedAt: null,
    installedBy: null,
    lastUpdatedAt: null,
    uninstalledAt: null,
    uninstalledBy: null,
    ...overrides,
  });
}

const SHA = "a".repeat(64);

/** A schema-valid `PackVersionRecord` fixture (default `draft`, pending review, beta channel). */
export function fakePackVersion(overrides: Partial<PackVersionRecord> = {}): PackVersionRecord {
  return PackVersionRecordSchema.parse({
    packId: "com.acme.loyalty",
    version: "1.0.0",
    status: "draft",
    channel: "beta",
    bundleSha256: SHA,
    bundleSizeBytes: 4096,
    manifestSha256: SHA,
    signature: {
      algorithm: "ed25519",
      publicKeyFingerprint: SHA,
      signature: "c2lnbmF0dXJl",
      signedAt: "2026-06-01T00:00:00.000Z",
    },
    securityReviewStatus: "pending",
    changelog: "Initial release",
    ...overrides,
  });
}

/**
 * A fake PgConnection for the platform-wide `pack_versions` table: an in-memory
 * row map keyed by `(pack_id, version)` that honors the UPSERT + the SELECT reads,
 * capturing every `{sql, params}`.
 */
export function fakeVersionPg(): {
  conn: PgConnection;
  calls: { sql: string; params: readonly unknown[] }[];
} {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const rows = new Map<string, Record<string, unknown>>();

  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    calls.push({ sql, params: p });
    if (sql.includes("INSERT INTO")) {
      const row = {
        pack_id: p[0],
        version: p[1],
        status: p[2],
        channel: p[3],
        bundle_sha256: p[4],
        bundle_size_bytes: p[5],
        manifest_sha256: p[6],
        signature: p[7],
        changelog: p[8],
        published_at: p[9] ?? null,
        published_by: p[10] ?? null,
        deprecated_at: p[11] ?? null,
        deprecated_reason: p[12] ?? null,
        withdrawn_at: p[13] ?? null,
        withdrawn_reason: p[14] ?? null,
        superseded_by: p[15] ?? null,
        security_review_status: p[16],
        security_reviewed_at: p[17] ?? null,
        security_reviewer: p[18] ?? null,
      };
      rows.set(`${String(p[0])}|${String(p[1])}`, row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT")) {
      let visible = [...rows.values()].filter((r) => r["pack_id"] === p[0]);
      if (sql.includes("AND version = $2")) visible = visible.filter((r) => r["version"] === p[1]);
      if (sql.includes("AND status = $2")) visible = visible.filter((r) => r["status"] === p[1]);
      return { rows: visible, rowCount: visible.length };
    }
    return { rows: [], rowCount: 0 };
  };

  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls };
}
