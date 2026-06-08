import { randomBytes } from "node:crypto";
import type { PgConnection } from "@crossengin/kernel-pg";

import type { IncidentMetrics, MttrStats } from "./metrics.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeBase32Lower(bytes: Uint8Array, length: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 0x1f];
    }
  }
  while (out.length < length) {
    out += CROCKFORD[(buffer << (5 - bits)) & 0x1f];
    bits = 0;
  }
  return out.slice(0, length);
}

/** Mints a fresh `ims_`-prefixed snapshot id (24 lowercase base32 chars). */
export function generateSnapshotId(): string {
  return `ims_${encodeBase32Lower(new Uint8Array(randomBytes(20)), 24)}`;
}

/** The window an `IncidentMetrics` snapshot summarizes. */
export interface MetricsWindow {
  readonly from: Date | string;
  readonly to: Date | string;
}

/**
 * The shape of the `INSERT` arguments a snapshot writes — the pure projection of
 * a `MetricsWindow` + `IncidentMetrics` into the `meta.incident_metric_snapshots`
 * column set (the four `MttrStats` ride as JSON, nullable when absent). Returned
 * separately so the store's SQL stays a thin binding around it.
 */
export interface IncidentMetricsSnapshotRow {
  readonly snapshotId: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly total: number;
  readonly open: number;
  readonly resolved: number;
  readonly escalations: number;
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly openBySeverity: Readonly<Record<string, number>>;
  readonly mttp: MttrStats | null;
  readonly mtta: MttrStats | null;
  readonly mttm: MttrStats | null;
  readonly mttr: MttrStats | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Pure projector: folds a `MetricsWindow` + `IncidentMetrics` into the row a
 * snapshot persists. Mints a `snapshot_id` when none is supplied.
 */
export function incidentMetricsSnapshotRow(
  window: MetricsWindow,
  metrics: IncidentMetrics,
  opts: { readonly snapshotId?: string } = {},
): IncidentMetricsSnapshotRow {
  return {
    snapshotId: opts.snapshotId ?? generateSnapshotId(),
    windowFrom: toIso(window.from),
    windowTo: toIso(window.to),
    total: metrics.total,
    open: metrics.open,
    resolved: metrics.resolved,
    escalations: metrics.escalations,
    bySeverity: metrics.bySeverity,
    openBySeverity: metrics.openBySeverity,
    mttp: metrics.mttp,
    mtta: metrics.mtta,
    mttm: metrics.mttm,
    mttr: metrics.mttr,
  };
}

interface SnapshotDbRow {
  readonly snapshot_id: string;
  readonly window_from: Date | string;
  readonly window_to: Date | string;
  readonly computed_at: Date | string;
  readonly total: number | string;
  readonly open: number | string;
  readonly resolved: number | string;
  readonly escalations: number | string;
  readonly by_severity: unknown;
  readonly open_by_severity: unknown;
  readonly mttp: unknown;
  readonly mtta: unknown;
  readonly mttm: unknown;
  readonly mttr: unknown;
}

/** A persisted snapshot read back from `meta.incident_metric_snapshots`. */
export interface StoredIncidentMetricsSnapshot extends IncidentMetricsSnapshotRow {
  readonly computedAt: string;
}

function toIsoOrEmpty(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function asInt(value: number | string): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

function asRecord(value: unknown): Record<string, number> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

function asStats(value: unknown): MttrStats | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const num = (k: string): number => (typeof o[k] === "number" ? (o[k] as number) : 0);
  return { count: num("count"), meanMs: num("meanMs"), p50Ms: num("p50Ms"), p95Ms: num("p95Ms"), maxMs: num("maxMs") };
}

function rowToSnapshot(row: SnapshotDbRow): StoredIncidentMetricsSnapshot {
  return {
    snapshotId: row.snapshot_id,
    windowFrom: toIsoOrEmpty(row.window_from),
    windowTo: toIsoOrEmpty(row.window_to),
    computedAt: toIsoOrEmpty(row.computed_at),
    total: asInt(row.total),
    open: asInt(row.open),
    resolved: asInt(row.resolved),
    escalations: asInt(row.escalations),
    bySeverity: asRecord(row.by_severity),
    openBySeverity: asRecord(row.open_by_severity),
    mttp: asStats(row.mttp),
    mtta: asStats(row.mtta),
    mttm: asStats(row.mttm),
    mttr: asStats(row.mttr),
  };
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  return Math.max(1, Math.min(1000, Math.trunc(limit)));
}

/**
 * Persists + reads point-in-time `IncidentMetrics` KPI snapshots to
 * `meta.incident_metric_snapshots` — the historical trend behind the on-demand
 * `computeIncidentMetrics`. `recordSnapshot` INSERTs one window's metrics (the
 * four MTTx stats ride as JSON, nullable); `listSnapshots` reads a window
 * newest-first so a dashboard can chart MTTR/MTTA/MTTM/MTTP + open/resolved over
 * time. Platform-wide (no tenant scoping), mirroring `meta.worker_heartbeats`.
 */
export class PostgresIncidentMetricsStore {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.table = `${schema}.incident_metric_snapshots`;
  }

  /**
   * Writes one snapshot, returning its row (with the minted `snapshot_id`). A
   * fresh `snapshot_id` per call means re-running the same window appends a new
   * point (the trend is append-only); `computed_at` defaults to `now()`.
   */
  async recordSnapshot(
    window: MetricsWindow,
    metrics: IncidentMetrics,
    opts: { readonly snapshotId?: string } = {},
  ): Promise<IncidentMetricsSnapshotRow> {
    const row = incidentMetricsSnapshotRow(window, metrics, opts);
    await this.conn.query(
      `INSERT INTO ${this.table} (
         snapshot_id, window_from, window_to,
         total, open, resolved, escalations,
         by_severity, open_by_severity, mttp, mtta, mttm, mttr
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb)`,
      [
        row.snapshotId,
        row.windowFrom,
        row.windowTo,
        row.total,
        row.open,
        row.resolved,
        row.escalations,
        JSON.stringify(row.bySeverity),
        JSON.stringify(row.openBySeverity),
        row.mttp === null ? null : JSON.stringify(row.mttp),
        row.mtta === null ? null : JSON.stringify(row.mtta),
        row.mttm === null ? null : JSON.stringify(row.mttm),
        row.mttr === null ? null : JSON.stringify(row.mttr),
      ],
    );
    return row;
  }

  /**
   * Reads snapshots whose `computed_at` falls in `[from, to]`, newest-first
   * (capped by `limit`, default 100). Drives the trend dashboard.
   */
  async listSnapshots(query: {
    readonly from: Date | string;
    readonly to: Date | string;
    readonly limit?: number;
  }): Promise<readonly StoredIncidentMetricsSnapshot[]> {
    const limit = clampLimit(query.limit, 100);
    const res = await this.conn.query<SnapshotDbRow>(
      `SELECT snapshot_id, window_from, window_to, computed_at,
              total, open, resolved, escalations,
              by_severity, open_by_severity, mttp, mtta, mttm, mttr
         FROM ${this.table}
        WHERE computed_at >= $1 AND computed_at <= $2
        ORDER BY computed_at DESC, snapshot_id DESC
        LIMIT $3`,
      [toIso(query.from), toIso(query.to), limit],
    );
    return res.rows.map(rowToSnapshot);
  }
}
