import type { TenantId, UserId } from "@crossengin/types";
import type { PrincipalKind } from "./types.js";

export interface AuditActor {
  readonly kind: PrincipalKind;
  readonly userId: UserId | null;
  readonly sessionId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AuditESignature {
  readonly method: string;
  readonly challengeId: string;
  readonly signedAt: string;
}

/**
 * Whose audit trail an entry belongs to: a tenant, or the platform itself.
 *
 * `null` is **platform scope** — a fact about the deployment rather than about one tenant's data.
 * Three escalation paths produce them and none can honestly name a tenant: an SLO surface is not a
 * tenant, the platform forensic chain has none, and a sweep that walks every tenant's proofs is
 * about the walk and not about a row. Before this existed each of those wrote nothing at all, and
 * the alternative — borrowing a tenant — files one scope's record under another's RLS confinement.
 */
export type AuditScope = TenantId | null;

export interface AuditLogEntry {
  readonly id: string;
  /** The tenant this record belongs to, or `null` for a platform-scope one. See {@link AuditScope}. */
  readonly tenantId: AuditScope;
  readonly occurredAt: string;
  readonly actor: AuditActor;
  readonly operation: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly diff: Readonly<Record<string, unknown>> | null;
  readonly reason?: string;
  readonly eSignature?: AuditESignature;
  readonly regoDecisionTrace?: string;
}

export interface AuditEmitter {
  emit(entry: AuditLogEntry): Promise<void>;
}

/**
 * Deterministic JSON: object keys sorted, so two structurally equal values always render to
 * the same string. Postgres `JSONB` does not preserve key order, so a `before`/`after`/`diff`
 * object read back from the database only matches what was written once both are sorted.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Normalizes a timestamp to its UTC instant. The writer supplies whatever offset the caller
 * used; `TIMESTAMPTZ` comes back as an instant, so `…T10:00:00+02:00` and `…T08:00:00.000Z`
 * are the same moment written two ways. Without this the payload computed before the insert
 * would not match the one computed after reading the row back, and every entry would look
 * tampered with.
 */
function canonicalInstant(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/**
 * The exact bytes a tamper-evident chain commits to for one audit entry.
 *
 * Every semantic field is included, so altering any of them after the fact changes the
 * payload and breaks the commitment. `created_at` is deliberately excluded: it is the
 * database's own insert clock, not part of what the actor did, and it is not carried on
 * `AuditLogEntry`.
 *
 * This must be stable across a Postgres round-trip — the writer hashes the entry it is about
 * to insert and a verifier hashes the row it reads back, and the two must agree. Hence sorted
 * keys (JSONB loses order), normalized instants (TIMESTAMPTZ loses the written offset), and
 * absent-vs-null collapsed to absent for the three optional fields (a `NULL` column reads
 * back as an omitted key).
 *
 * **`tenantId` becoming nullable did not move these bytes, and that is load-bearing.** Every
 * stored `chain_entry_hash` in every deployment commits to this payload, so a change to the
 * rendering of an entry that *has* a tenant would stop every existing anchor verifying — the
 * v1→v2 domain-tag situation ADR-0329 had to create for the tombstone content manifest. A
 * tenant-scoped entry still renders `"tenantId":"<uuid>"` at the same sorted position; only the
 * platform-scope entries this change makes possible render `"tenantId":null`, and no stored digest
 * commits to bytes that did not exist. Two pre-change digests are pinned in the tests, computed
 * from the published `dist/` before the type was widened.
 */
export function canonicalAuditEntryPayload(entry: AuditLogEntry): string {
  return canonicalJson({
    id: entry.id,
    // `?? null` so an `undefined` handed over by an untyped caller renders as platform scope
    // rather than *dropping the key* — `canonicalJson` filters `undefined`, and bytes with no
    // `tenantId` at all would be a third rendering nothing verifies against.
    tenantId: entry.tenantId ?? null,
    occurredAt: canonicalInstant(entry.occurredAt),
    actor: {
      kind: entry.actor.kind,
      userId: entry.actor.userId,
      sessionId: entry.actor.sessionId,
      ip: entry.actor.ip,
      userAgent: entry.actor.userAgent,
    },
    operation: entry.operation,
    entity: entry.entity,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    diff: entry.diff ?? null,
    reason: entry.reason ?? null,
    eSignature:
      entry.eSignature === undefined
        ? null
        : {
            method: entry.eSignature.method,
            challengeId: entry.eSignature.challengeId,
            signedAt: canonicalInstant(entry.eSignature.signedAt),
          },
    regoDecisionTrace: entry.regoDecisionTrace ?? null,
  });
}
