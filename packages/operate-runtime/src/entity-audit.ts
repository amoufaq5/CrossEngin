import type { HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { ClassifiedField } from "@crossengin/auth";
import { SENSITIVE_DATA_CLASSIFICATIONS, type DataClassification } from "@crossengin/types/meta-schema";

import type { EntityRecord } from "./store.js";
import type { SystemWriteOrigin } from "./system-writer.js";

/**
 * The 503 for a write whose record could not be made. `rolledBack` decides the sentence, because the
 * two cases tell the caller opposite things: inside a transaction nothing was written, outside one
 * the write stands and only its record is missing — and a 2xx in the second case would assert a
 * record that does not exist.
 */
export function auditUnavailable(rolledBack: boolean): HandlerOutput {
  return {
    kind: "json",
    status: 503,
    body: {
      error: "audit_unavailable",
      detail: rolledBack
        ? "the write could not be recorded in the audit trail, so it was not made; retry shortly"
        : "the write was made and could not be recorded in the audit trail; an operator has been told",
    },
  };
}

/**
 * The record of one entity write: what was written, by whom, and the record before and after.
 *
 * Every successful create, update, delete, transition, link and unlink produces one, and the
 * payloads in it are **already redacted** when the handler hands it over. That is the decision this
 * module exists to hold: the audit trail is `meta.audit_log`, which is a plain JSONB table with no
 * encryption at rest, which the Article 17 erasure **retains** (`PLATFORM_RECORD_TABLES`) so that it
 * outlives the tenant, and which nothing ever deletes. A `phi` value written there in the clear would
 * undo ADR-0338 — the column it came from is ciphertext — and a `pii` value would survive the erasure
 * of the person it describes. So a sensitive field's value never leaves the handler: the payload
 * carries {@link REDACTED_VALUE_KEY} naming the class instead, and the `diff` still says the field
 * changed. Redacting at read time instead would make every reader's redaction the only thing standing
 * between the trail and the plaintext, in a table whose purpose is to be kept.
 *
 * The cost is stated rather than hidden: a reader privileged for `pii` sees the marker and not the
 * old value, so the trail answers *who changed this field and when* and not *from what to what* for a
 * sensitive field. The value itself is in the entity table, under the protections that table has.
 *
 * **The withholding is only as wide as the classification, and that leaves the erasure argument
 * half-made.** An *unclassified* value is copied into the payloads in the clear, and in the shipped
 * `erp-core` nearly every own field carries no classification — among them every field of `Contact`
 * (`given_name`, `family_name`, `email`, `phone`), `Employee.given_name`/`family_name`,
 * `Account.billing_email` and the free-text `notes`/`memo` fields. Since the trail is retained by the
 * Article 17 erasure, those copies outlive a tenant deletion whose proof says nothing about them, and
 * `PLATFORM_RECORD_TABLES`' premise — that those tables hold the platform's record and not the
 * tenant's data — stops being true of `meta.audit_log` for entity rows. Scrubbing the payloads at
 * erasure would break each row's anchor (the chain commits to them), so closing it is a decision —
 * record field names and not values, or classify the personal fields — and not a patch.
 */
export interface EntityWriteAuditEvent {
  /** The gateway's request id, so the request-level chain entry can be told this write is recorded. */
  readonly requestId: string;
  /** The route's operationId — `invoice.create`, `invoice.send` — which is what the trail files under. */
  readonly operationId: string;
  readonly action: EntityAuditAction;
  readonly entity: string;
  readonly tenantId: string;
  /** Null only when the store answered a create with no string id, which none of the three does. */
  readonly recordId: string | null;
  /** The person, through `principalUserId`; null for a credential that names nobody. */
  readonly actorUserId: string | null;
  /** The transition's name for `transition`, and for `link`/`unlink` the related entity. */
  readonly detail: string | null;
  /**
   * The background work that made this write, when it was not a request. Absent for every write a
   * client made; present only on a principal `buildSystemEntityAccess` minted, so no request can
   * claim it. A recorder files the row under it, since `actorUserId` is null for both a job and a
   * bare api-key and the two must not read alike in the trail.
   */
  readonly origin?: SystemWriteOrigin;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly diff: Record<string, unknown> | null;
  /**
   * Whether this event is being recorded inside the transaction that made the write. True for every
   * entity write on a transactional store; false for an association link or unlink, whose store call
   * commits on its own, and for a write on the in-memory store, which has no transaction.
   *
   * A recorder must not treat `true` as advisory: it is the handler's statement that the write and
   * its record share a fate, and a recorder that cannot honour it has to refuse rather than write the
   * record somewhere the rollback cannot reach.
   */
  readonly inTransaction: boolean;
}

export const ENTITY_AUDIT_ACTIONS = ["create", "update", "delete", "transition", "link", "unlink"] as const;
export type EntityAuditAction = (typeof ENTITY_AUDIT_ACTIONS)[number];

/** Where a deployment puts an entity write's record. One method; the handler owns the shape. */
export interface EntityWriteAuditor {
  record(event: EntityWriteAuditEvent): Promise<void>;
}

/**
 * The write's record could not be made. A recorder throws this, and only this, to refuse.
 *
 * Inside a transaction the handler lets it propagate, so the business write rolls back with it and
 * the caller gets a 503: a write the platform cannot account for is not a write it may report as done.
 * Outside one (link, unlink) the write has already committed, and the 503 says exactly that rather
 * than a 2xx that would claim a record nobody made.
 */
export class EntityAuditUnrecorded extends Error {
  constructor(readonly reason: string, options?: { readonly cause?: unknown }) {
    super(`entity write could not be recorded in the audit trail: ${reason}`);
    this.name = "EntityAuditUnrecorded";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isEntityAuditUnrecorded(err: unknown): err is EntityAuditUnrecorded {
  return err instanceof EntityAuditUnrecorded;
}

/**
 * The key a redacted value is replaced by: `{"$redacted": "<class>"}`.
 *
 * An object and not a string, because a string marker is a value a field could legitimately hold —
 * an audit reader could not tell a redaction from a record whose `notes` read `[redacted:pii]`. A
 * `$`-prefixed key cannot be a manifest field name (`FIELD_NAME_REGEX` starts with a letter), so the
 * object is unambiguous at the top level, which is the only level a field's value is judged at.
 */
export const REDACTED_VALUE_KEY = "$redacted";

/** The classes whose values never reach the trail. `SENSITIVE_DATA_CLASSIFICATIONS`, read, not restated. */
export function auditWithholdsClass(classification: DataClassification): boolean {
  return SENSITIVE_DATA_CLASSIFICATIONS.has(classification);
}

function withheldClasses(fields: readonly ClassifiedField[]): ReadonlyMap<string, DataClassification> {
  const out = new Map<string, DataClassification>();
  for (const f of fields) {
    if (f.classification !== undefined && auditWithholdsClass(f.classification)) {
      out.set(f.name, f.classification);
    }
  }
  return out;
}

function redact(
  record: Readonly<Record<string, unknown>> | null,
  withheld: ReadonlyMap<string, DataClassification>,
): Record<string, unknown> | null {
  if (record === null) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const cls = withheld.get(key);
    out[key] = cls === undefined ? value : { [REDACTED_VALUE_KEY]: cls };
  }
  return out;
}

/** Structural equality over JSON-shaped values, key order ignored — what "the field changed" means. */
export function auditValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => auditValuesEqual(v, b[i]));
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      auditValuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export interface AuditPayloads {
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly diff: Record<string, unknown> | null;
}

/**
 * The three payloads an entity write's record carries, with every sensitive value withheld.
 *
 * `diff` is computed from the **unredacted** pair and then redacted, so a sensitive field that changed
 * appears in it — as the marker — and one that did not is absent: the fact of a change is what an
 * audit needs and is not the value. It is null when either side is (a create or a delete), because a
 * diff against nothing restates the other payload.
 */
export function entityAuditPayloads(
  before: Readonly<EntityRecord> | null,
  after: Readonly<EntityRecord> | null,
  classified: readonly ClassifiedField[],
): AuditPayloads {
  const withheld = withheldClasses(classified);
  let diff: Record<string, unknown> | null = null;
  if (before !== null && after !== null) {
    diff = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const from = before[key];
      const to = after[key];
      if (auditValuesEqual(from, to)) continue;
      const cls = withheld.get(key);
      diff[key] =
        cls === undefined ? { from: from ?? null, to: to ?? null } : { [REDACTED_VALUE_KEY]: cls };
    }
  }
  return { before: redact(before, withheld), after: redact(after, withheld), diff };
}
