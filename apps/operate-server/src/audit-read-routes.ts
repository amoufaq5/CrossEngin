import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import {
  computeRedactedFields,
  redactJsonValue,
  type Handler,
  type HandlerOutput,
  type PrincipalRoles,
  type ResponseRedactionSpec,
} from "@crossengin/api-gateway-runtime";
import type {
  AuditLogEntry,
  ClassifiedField,
  RoleDefinition,
  RoleName,
  SensitiveFieldPolicy,
} from "@crossengin/auth";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { entityClassifiedFields, type Entity } from "@crossengin/types/meta-schema";

import { resolveWindow } from "./integrity-verdict-routes.js";

/**
 * Read-only HTTP over the hash-chained audit trail (the ADR-0279 follow-up).
 *
 * The trail has been written and verified since ADR-0286 and could not be read: "who touched this
 * record" was a psql question. These handlers answer it — a windowed, filterable listing and a
 * single entry — and nothing else. There is no write path here and the store behind it exposes
 * none, so no request can append to or alter the chain.
 *
 * Three things carry the weight.
 *
 * **An audit entry is the most sensitive row in the system.** `before` and `after` hold the field
 * values an actor wrote, which for a healthcare pack is PHI and for almost any pack is PII. So the
 * payloads go through `computeClassifiedFieldRedaction` — via `api-gateway-runtime`'s
 * `computeRedactedFields`, the same path the gateway uses on every entity response — keyed on the
 * entry's OWN entity, because the classification of `after.mrn` depends on which entity the row is
 * about. It fails closed three ways: a classified field with no explicit grant is dropped unless
 * the reader is privileged; an entity the classification source does not know has its payloads
 * withheld whole rather than served unclassified; and a payload key the entity does not declare is
 * dropped, because a value nothing describes is a value nobody has decided may be read.
 *
 * **A read of the trail is itself privileged, so it is recorded before it is served.** `recordRead`
 * is not optional — there is no way to wire these routes without it — and a granted read whose
 * record cannot be written is refused with 503 rather than served unaudited (CLAUDE.md's fail-closed
 * invariant, and the shape ADR-0279's tenant-scope notification read already uses). The record goes
 * into `meta.audit_log` itself, so reading the trail appears in the trail.
 *
 * **The grant decides the scope, not the path.** One listing serves a tenant reading its own
 * entries and a platform operator reading across tenants; a tenant naming another tenant is refused
 * rather than silently narrowed.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const DEFAULT_MAX_RANGE_DAYS = 92;

// ---------------------------------------------------------------------------
// Store seam
// ---------------------------------------------------------------------------

export type AuditReadScopeLike =
  | { readonly kind: "tenant"; readonly tenantId: string }
  | { readonly kind: "all" };

export interface AuditAnchorRefLike {
  readonly sequenceNumber: number;
  readonly entryHash: string;
}

export interface AnchoredAuditEntryLike {
  readonly entry: AuditLogEntry;
  readonly anchor: AuditAnchorRefLike | null;
}

export interface AuditReadQueryLike {
  readonly scope: AuditReadScopeLike;
  readonly from?: string;
  readonly to?: string;
  readonly entity?: string;
  readonly operation?: string;
  readonly entityId?: string;
  readonly actorUserId?: string;
  readonly anchoredOnly?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AuditReadPageLike {
  readonly data: readonly AnchoredAuditEntryLike[];
  readonly nextCursor: string | null;
}

/**
 * Structural mirror of the read store. Declared here rather than imported so the route layer stays
 * decoupled from Postgres — and so the mirror can offer no write method at all.
 */
export interface AuditReadSourceLike {
  list(query: AuditReadQueryLike): Promise<AuditReadPageLike>;
  getById(id: string, scope: AuditReadScopeLike): Promise<AnchoredAuditEntryLike | null>;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The fields an audited entity declares, with their data classes.
 *
 * ALL fields, not only the classified ones: the unclassified names are what tell the reader which
 * payload keys are describable at all. Returning null for an entity means "I do not know this
 * entity", which is not the same as "it has nothing sensitive" and must not read as it.
 */
export type EntityFieldLookup = (entity: string) => readonly ClassifiedField[] | null;

export interface AuditClassificationContext {
  readonly fieldsFor: EntityFieldLookup;
  readonly roles: ReadonlyMap<RoleName, RoleDefinition>;
  /**
   * Which roles may read a sensitive value, and which classes count as sensitive. Omitted ⇒
   * `isSensitiveDataClass` decides and NO role is privileged, so pii/phi/regulated/
   * commercial_sensitive values are redacted for everyone — the fail-closed default.
   */
  readonly policy?: SensitiveFieldPolicy;
}

/**
 * Builds a lookup from a resolved manifest's entities.
 *
 * Only the entity's *declared* fields: trait-added columns (`id`, `created_at`, a soft-delete
 * marker) are not among them, so a payload carrying them has those keys dropped as undescribed. A
 * deployment that wants them readable builds the lookup from the kernel's `resolvedFields` instead
 * — the same function `validateManifest` uses — rather than this convenience.
 */
export function entityFieldLookupFrom(manifest: {
  readonly entities?: readonly Entity[];
}): EntityFieldLookup {
  const byName = new Map<string, readonly ClassifiedField[]>();
  for (const entity of manifest.entities ?? []) {
    const classified = new Map(entityClassifiedFields(entity).map((c) => [c.field, c.classification]));
    byName.set(
      entity.name,
      entity.fields.map((f) => {
        const classification = classified.get(f.name);
        return classification === undefined
          ? { name: f.name }
          : { name: f.name, classification };
      }),
    );
  }
  return (entity: string): readonly ClassifiedField[] | null => byName.get(entity) ?? null;
}

/**
 * The actor's own identifying details, treated as classified rather than special-cased.
 *
 * An IP and a user agent are personal data about the person who acted, and an audit trail is read
 * by people who are entitled to know *what* happened without being entitled to know from which
 * device. Running them through the same redaction as a record's fields means one rule decides both.
 */
export const AUDIT_ACTOR_CLASSIFIED_FIELDS: readonly ClassifiedField[] = [
  { name: "ip", classification: "pii" },
  { name: "userAgent", classification: "pii" },
];

export const PAYLOAD_WITHHOLDINGS = ["unclassified_entity", "classification_unavailable"] as const;
export type PayloadWithholding = (typeof PAYLOAD_WITHHOLDINGS)[number];

export interface RedactedAuditPayloads {
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly diff: Record<string, unknown> | null;
  /** Declared fields this reader may not see. Names, never values — a name is schema, not data. */
  readonly redactedFields: readonly string[];
  /** Payload keys the entity does not declare, dropped because nothing classifies them. */
  readonly undescribedFields: readonly string[];
  /** Set when the payloads were withheld whole, with the reason. */
  readonly withheld: PayloadWithholding | null;
}

const EMPTY_WITHHELD = (withheld: PayloadWithholding): RedactedAuditPayloads => ({
  before: null,
  after: null,
  diff: null,
  redactedFields: [],
  undescribedFields: [],
  withheld,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Top-level keys only. A payload's top level is the entity's field names; anything deeper is the
 * *value* of one of them, so judging it against the field list would strip the inside of every JSON
 * column and every `{from, to}` pair in a diff.
 */
function topLevelKeys(payload: Readonly<Record<string, unknown>> | null): readonly string[] {
  return payload === null ? [] : Object.keys(payload);
}

function specFor(
  ctx: AuditReadRoutesContext,
  classifiedFields: readonly ClassifiedField[],
): ResponseRedactionSpec {
  return {
    classifiedFields,
    roles: ctx.classification.roles,
    rolesForPrincipal: ctx.principalRoles,
    // One entry's payload at a time, so the shape is a record — this path already redacts per row,
    // which is what ADR-0343 gave the gateway. It deliberately supplies **no** record and no
    // `abac`, so a record-bearing field policy resolves `undischargeable` here and the field stays
    // redacted. Two reasons, and the second is the real one: the "record" on this path is a
    // *historical snapshot* in `before`/`after`, not the live row, so a policy of the form "only on
    // a patient in your department" would be answered against the department the record held when
    // it was written rather than the one it holds now — a different question, and the wrong one to
    // answer silently.
    recordShape: "record",
    ...(ctx.classification.policy !== undefined ? { policy: ctx.classification.policy } : {}),
  };
}

/**
 * Redacts one entry's payloads for one reader.
 *
 * The drop set is the union of two fail-closed decisions: the fields this reader's roles do not
 * reach (classification-aware, via `computeClassifiedFieldRedaction`), and the keys the entity does
 * not describe. Dropping is removal, not nulling — a null tells a reader the field was empty, which
 * about a redacted PHI value is a lie.
 */
export function redactAuditPayloads(
  ctx: AuditReadRoutesContext,
  entry: AuditLogEntry,
  principal: ResolvedPrincipal | null,
): RedactedAuditPayloads {
  let fields: readonly ClassifiedField[] | null;
  try {
    fields = ctx.classification.fieldsFor(entry.entity);
  } catch {
    // A classification source that cannot answer is not an answer of "nothing sensitive here".
    return EMPTY_WITHHELD("classification_unavailable");
  }
  if (fields === null) return EMPTY_WITHHELD("unclassified_entity");
  const redacted = computeRedactedFields(specFor(ctx, fields), principal);
  const declared = new Set(fields.map((f) => f.name));
  const present = new Set([
    ...topLevelKeys(entry.before),
    ...topLevelKeys(entry.after),
    ...topLevelKeys(entry.diff),
  ]);
  const undescribed = [...present].filter((k) => !declared.has(k)).sort();
  const drop = new Set([...redacted, ...undescribed]);
  const apply = (
    payload: Readonly<Record<string, unknown>> | null,
  ): Record<string, unknown> | null => {
    if (payload === null) return null;
    const next = redactJsonValue(payload, drop);
    return isRecord(next) ? next : null;
  };
  return {
    before: apply(entry.before),
    after: apply(entry.after),
    diff: apply(entry.diff),
    redactedFields: [...redacted].filter((f) => present.has(f)).sort(),
    undescribedFields: undescribed,
    withheld: null,
  };
}

export interface AuditActorView {
  readonly kind: string;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly redactedFields: readonly string[];
}

export function redactAuditActor(
  ctx: AuditReadRoutesContext,
  entry: AuditLogEntry,
  principal: ResolvedPrincipal | null,
): AuditActorView {
  const redacted = new Set(
    computeRedactedFields(specFor(ctx, AUDIT_ACTOR_CLASSIFIED_FIELDS), principal),
  );
  return {
    kind: entry.actor.kind,
    userId: entry.actor.userId,
    sessionId: entry.actor.sessionId,
    ...(redacted.has("ip") ? {} : { ip: entry.actor.ip }),
    ...(redacted.has("userAgent") ? {} : { userAgent: entry.actor.userAgent }),
    redactedFields: [...redacted].sort(),
  };
}

/**
 * One entry as the route reports it.
 *
 * `anchored` is spelled out rather than inferred from a null hash, because the difference between
 * "committed to the chain" and "a row somebody wrote" is the whole basis for believing the trail.
 * `regoDecisionTrace` is deliberately NOT shipped — a policy trace embeds the input it decided
 * over, which is the record's field values, i.e. exactly what the redaction above just removed —
 * so its presence is reported and its content is not.
 */
export function toAuditEntryView(
  ctx: AuditReadRoutesContext,
  row: AnchoredAuditEntryLike,
  principal: ResolvedPrincipal | null,
): Record<string, unknown> {
  const { entry, anchor } = row;
  const payloads = redactAuditPayloads(ctx, entry, principal);
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    occurredAt: entry.occurredAt,
    operation: entry.operation,
    entity: entry.entity,
    entityId: entry.entityId,
    actor: redactAuditActor(ctx, entry, principal),
    reason: entry.reason ?? null,
    eSignature: entry.eSignature ?? null,
    hasDecisionTrace: entry.regoDecisionTrace !== undefined,
    anchor,
    anchored: anchor !== null,
    before: payloads.before,
    after: payloads.after,
    diff: payloads.diff,
    redaction: {
      redactedFields: payloads.redactedFields,
      undescribedFields: payloads.undescribedFields,
      payloadWithheld: payloads.withheld,
    },
  };
}

// ---------------------------------------------------------------------------
// Recording the read
// ---------------------------------------------------------------------------

export const AUDIT_READ_LIST_OPERATION = "audit.entries_read";
export const AUDIT_READ_ENTRY_OPERATION = "audit.entry_read";
export const AUDIT_READ_DENIED_OPERATION = "audit.read_denied";

export interface AuditReadEvent {
  /** The tenant whose trail was read; null for a cross-tenant read, which names no single one. */
  readonly tenantId: string | null;
  /**
   * The reader's OWN tenant, which is not the same question as whose trail was read: a platform
   * operator reading across tenants leaves `tenantId` null and this set.
   *
   * **A cross-tenant read is still recorded against the reader's own tenant, and the reason has
   * changed** (ADR-0331). ADR-0313 gave a mechanical one — `meta.audit_log.tenant_id` was NOT NULL,
   * so there was nowhere else to put it — and that reason is gone: the column is nullable now and a
   * platform-scope row is expressible. The rule stays for the reason that was always the real one.
   *
   * This record is about a **person**, and that person belongs to a tenant. Filing it in their
   * tenant's trail is what makes the read accountable to the people whose data it touched: their
   * own `GET /v1/audit/entries` shows that somebody with a platform grant read across them. Moving
   * it to platform scope would put it behind `app.platform_audit` — readable only by the same
   * population that performed it — which removes the one reader the record exists for. A
   * platform-scope row is the right home for a fact about the *deployment* (an SLO page, a stalled
   * sweep); a privileged human's read is not one.
   *
   * So the fail-closed consequence stands too: a reader with no resolvable tenant still cannot
   * read, and must not be given a platform row instead. That would admit an **unattributable**
   * privileged read, which is worse than refusing one.
   */
  readonly readerTenantId: string | null;
  readonly principalId: string | null;
  readonly roles: readonly string[];
  readonly operation: string;
  readonly scopeKind: "tenant" | "all";
  readonly granted: boolean;
  /** The query that ran, so the record says WHAT was read and not merely that something was. */
  readonly filters: Readonly<Record<string, string | number | boolean>>;
  readonly at: string;
}

/** Required, not optional: these routes cannot be wired without a way to record what they serve. */
export type AuditReadRecorder = (event: AuditReadEvent) => Promise<void>;

export interface AuditReadRoutesContext {
  readonly source: AuditReadSourceLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles granted the cross-tenant view. Fail-closed: empty ⇒ nobody. */
  readonly platformRoles: ReadonlySet<string>;
  /** Roles granted their OWN tenant's trail. Fail-closed: empty ⇒ nobody. */
  readonly tenantRoles: ReadonlySet<string>;
  readonly classification: AuditClassificationContext;
  readonly recordRead: AuditReadRecorder;
  /** Caps the window a single query may span. Defaults to 92 days. */
  readonly maxRangeDays?: number;
  readonly clock?: () => Date;
  /** Observes a failure to record. Never handed a payload — only the failure and the scope. */
  readonly onRecordError?: (err: unknown, scopeKind: "tenant" | "all") => void;
}

export type AuditReadGrant =
  | { readonly kind: "platform" }
  | { readonly kind: "tenant"; readonly tenantId: string };

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(
  ctx: AuditReadRoutesContext,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function hasAnyRole(roles: readonly string[], allowed: ReadonlySet<string>): boolean {
  if (allowed.size === 0) return false;
  return roles.some((r) => allowed.has(r));
}

/**
 * Fail closed in three ways, each of which has been a real leak somewhere: no principal is refused
 * rather than treated as a system reader; a caller holding the tenant role but no resolvable tenant
 * id is refused rather than handed an unfiltered query; and an unknown role falls through to
 * refusal rather than to the narrower scope.
 */
export function resolveAuditReadGrant(
  ctx: AuditReadRoutesContext,
  principal: ResolvedPrincipal | null,
): AuditReadGrant | null {
  if (principal === null) return null;
  const roles = rolesOf(ctx, principal);
  if (hasAnyRole(roles, ctx.platformRoles)) return { kind: "platform" };
  if (!hasAnyRole(roles, ctx.tenantRoles)) return null;
  const tenantId = principal.tenantId ?? "";
  if (!UUID_RE.test(tenantId)) return null;
  return { kind: "tenant", tenantId };
}

/**
 * The scope a request asks for, narrowed to what the grant permits.
 *
 * A tenant grant naming another tenant is a 403, not a quietly-narrowed query: a reader who
 * believes they searched every tenant and found nothing has been misled about the one fact an audit
 * trail exists to establish.
 */
export function resolveAuditScope(
  grant: AuditReadGrant,
  requestedTenantId: string | undefined,
): AuditReadScopeLike | { readonly error: string; readonly detail: string } {
  if (requestedTenantId !== undefined && !UUID_RE.test(requestedTenantId)) {
    return { error: "invalid_request", detail: "tenantId must be a uuid" };
  }
  if (grant.kind === "tenant") {
    if (requestedTenantId !== undefined && requestedTenantId !== grant.tenantId) {
      return { error: "forbidden", detail: "cannot read another tenant's audit trail" };
    }
    return { kind: "tenant", tenantId: grant.tenantId };
  }
  if (requestedTenantId !== undefined) return { kind: "tenant", tenantId: requestedTenantId };
  return { kind: "all" };
}

function isRefusal(value: unknown): value is { readonly error: string; readonly detail: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

function statusFor(error: string): number {
  return error === "forbidden" ? 403 : 400;
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : (value as string);
}

function queryOf(input: Parameters<Handler>[0]): Record<string, string | string[]> {
  return (input.request as { query?: Record<string, string | string[]> } | undefined)?.query ?? {};
}

function presentValue(raw: string | undefined): string | undefined {
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

interface ReadRequest {
  readonly scope: AuditReadScopeLike;
  readonly query: AuditReadQueryLike;
  readonly filters: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Authorisation first, then scope, then the filters: a caller who may not read at all must never
 * see a validation message about a window they were never going to get.
 */
function readRequest(
  ctx: AuditReadRoutesContext,
  input: Parameters<Handler>[0],
  windowed: boolean,
): ReadRequest | HandlerOutput {
  const grant = resolveAuditReadGrant(ctx, input.principal);
  if (grant === null) {
    return input.principal === null
      ? json(401, { error: "authentication_required" })
      : json(403, { error: "forbidden", detail: "insufficient role" });
  }
  const query = queryOf(input);
  const scope = resolveAuditScope(grant, presentValue(firstQueryValue(query["tenantId"])));
  if (isRefusal(scope)) return json(statusFor(scope.error), scope);

  const filters: Record<string, string | number | boolean> = {
    scope: scope.kind,
    ...(scope.kind === "tenant" ? { tenantId: scope.tenantId } : {}),
  };
  const text = (name: string): string | undefined => {
    const value = presentValue(firstQueryValue(query[name]));
    if (value !== undefined) filters[name] = value;
    return value;
  };
  const entity = text("entity");
  const operation = text("operation");
  const entityId = text("entityId");
  const actorUserId = presentValue(firstQueryValue(query["actorUserId"]));
  if (actorUserId !== undefined) {
    if (!UUID_RE.test(actorUserId)) {
      return json(400, { error: "invalid_request", detail: "actorUserId must be a uuid" });
    }
    filters["actorUserId"] = actorUserId;
  }
  const anchoredOnly = presentValue(firstQueryValue(query["anchoredOnly"])) === "true";
  if (anchoredOnly) filters["anchoredOnly"] = true;
  const limitRaw = presentValue(firstQueryValue(query["limit"]));
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  if (limit !== undefined && !Number.isFinite(limit)) {
    return json(400, { error: "invalid_request", detail: "unparseable limit" });
  }
  if (limit !== undefined) filters["limit"] = limit;
  const cursor = presentValue(firstQueryValue(query["cursor"]));
  filters["paged"] = cursor !== undefined;

  let window: { readonly from: string; readonly to: string } | undefined;
  if (windowed) {
    const now = (ctx.clock ?? ((): Date => new Date()))();
    const resolved = resolveWindow(
      presentValue(firstQueryValue(query["from"])),
      presentValue(firstQueryValue(query["to"])),
      now,
      ctx.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS,
    );
    if (isRefusal(resolved)) return json(statusFor(resolved.error), resolved);
    window = resolved;
    filters["from"] = resolved.from;
    filters["to"] = resolved.to;
  }

  return {
    scope,
    filters,
    query: {
      scope,
      ...(window === undefined ? {} : { from: window.from, to: window.to }),
      ...(entity === undefined ? {} : { entity }),
      ...(operation === undefined ? {} : { operation }),
      ...(entityId === undefined ? {} : { entityId }),
      ...(actorUserId === undefined ? {} : { actorUserId }),
      ...(anchoredOnly ? { anchoredOnly: true } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    },
  };
}

function isHandlerOutput(value: ReadRequest | HandlerOutput): value is HandlerOutput {
  return "kind" in value;
}

function eventFor(
  ctx: AuditReadRoutesContext,
  input: Parameters<Handler>[0],
  operation: string,
  scopeKind: "tenant" | "all",
  tenantId: string | null,
  granted: boolean,
  filters: Readonly<Record<string, string | number | boolean>>,
): AuditReadEvent {
  return {
    tenantId,
    readerTenantId: input.principal?.tenantId ?? null,
    principalId: input.principal?.principalId ?? null,
    roles: rolesOf(ctx, input.principal),
    operation,
    scopeKind,
    granted,
    filters,
    at: (ctx.clock ?? ((): Date => new Date()))().toISOString(),
  };
}

/**
 * Records a granted read, or returns the refusal that stops it.
 *
 * Written BEFORE any data is served, and a failure refuses the read: an after-the-fact record can
 * be lost exactly when the read is one somebody later needs to account for, and "we served it but
 * cannot say who asked" is the state an audit trail exists to prevent.
 */
async function recordOrRefuse(
  ctx: AuditReadRoutesContext,
  event: AuditReadEvent,
): Promise<HandlerOutput | null> {
  try {
    await ctx.recordRead(event);
    return null;
  } catch (err) {
    ctx.onRecordError?.(err, event.scopeKind);
    return json(503, {
      error: "audit_unavailable",
      detail: "the audit trail cannot be read while the read cannot be recorded",
    });
  }
}

/**
 * A refused attempt is recorded too, best-effort: somebody probing for another tenant's trail is
 * worth knowing about. Unlike a granted read, a failure here changes nothing — the answer was
 * already no, and turning a 403 into a 503 would tell a prober that the recorder is down.
 */
async function recordDenial(ctx: AuditReadRoutesContext, event: AuditReadEvent): Promise<void> {
  try {
    await ctx.recordRead(event);
  } catch (err) {
    ctx.onRecordError?.(err, event.scopeKind);
  }
}

function deniedEvent(
  ctx: AuditReadRoutesContext,
  input: Parameters<Handler>[0],
  out: HandlerOutput,
): AuditReadEvent | null {
  // Only an authenticated caller who got far enough to be identified: an unauthenticated 401 has no
  // actor and no tenant, so there is nothing to record it against.
  const tenantId = input.principal?.tenantId ?? null;
  if (input.principal === null || tenantId === null || !UUID_RE.test(tenantId)) return null;
  const status = "status" in out ? out.status : 0;
  if (status !== 403) return null;
  return eventFor(ctx, input, AUDIT_READ_DENIED_OPERATION, "tenant", tenantId, false, {
    status,
  });
}

function tenantOfScope(scope: AuditReadScopeLike): string | null {
  return scope.kind === "tenant" ? scope.tenantId : null;
}

function buildListHandler(ctx: AuditReadRoutesContext): Handler {
  return async (input) => {
    const req = readRequest(ctx, input, true);
    if (isHandlerOutput(req)) {
      const denial = deniedEvent(ctx, input, req);
      if (denial !== null) await recordDenial(ctx, denial);
      return req;
    }
    const refusal = await recordOrRefuse(
      ctx,
      eventFor(
        ctx,
        input,
        AUDIT_READ_LIST_OPERATION,
        req.scope.kind,
        tenantOfScope(req.scope),
        true,
        req.filters,
      ),
    );
    if (refusal !== null) return refusal;
    let page: AuditReadPageLike;
    try {
      page = await ctx.source.list(req.query);
    } catch {
      // A rejected cursor and a row the contract no longer accepts arrive the same way, and neither
      // carries a detail into the response: an error message about an audit row can quote the row.
      return json(500, { error: "audit_page_unreadable" });
    }
    return json(200, {
      scope: req.scope,
      data: page.data.map((row) => toAuditEntryView(ctx, row, input.principal)),
      page: { nextCursor: page.nextCursor },
    });
  };
}

function buildGetHandler(ctx: AuditReadRoutesContext): Handler {
  return async (input) => {
    const req = readRequest(ctx, input, false);
    if (isHandlerOutput(req)) {
      const denial = deniedEvent(ctx, input, req);
      if (denial !== null) await recordDenial(ctx, denial);
      return req;
    }
    const id = input.params["id"] ?? "";
    if (!UUID_RE.test(id)) return json(404, { error: "audit_entry_not_found" });
    const refusal = await recordOrRefuse(
      ctx,
      eventFor(ctx, input, AUDIT_READ_ENTRY_OPERATION, req.scope.kind, tenantOfScope(req.scope), true, {
        ...req.filters,
        auditId: id,
      }),
    );
    if (refusal !== null) return refusal;
    let row: AnchoredAuditEntryLike | null;
    try {
      // Scoped, never by id alone: an audit id travels in links and logs, and a bare
      // `WHERE id = $1` would let a tenant read another tenant's record by naming it.
      row = await ctx.source.getById(id, req.scope);
    } catch {
      return json(500, { error: "audit_entry_unreadable" });
    }
    if (row === null) return json(404, { error: "audit_entry_not_found", detail: id });
    return json(200, { entry: toAuditEntryView(ctx, row, input.principal) });
  };
}

/**
 * The audit-trail read routes to inject via the gateway's `extraRoutes` hook. GET only, over a
 * source that has no write method: read-only by construction rather than by convention.
 */
export function buildAuditReadRoutes(ctx: AuditReadRoutesContext): readonly ExtraGatewayRoute[] {
  const v = (
    op: string,
    segs: ReadonlyArray<string | { param: string }>,
    handler: Handler,
  ): ExtraGatewayRoute => ({ route: route(op, "GET", segs), handler });
  return [
    v("audit.entries.list", ["v1", "audit", "entries"], buildListHandler(ctx)),
    v("audit.entries.get", ["v1", "audit", "entries", { param: "id" }], buildGetHandler(ctx)),
  ];
}

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string }>,
): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string"
      ? { kind: "literal", value: s }
      : { kind: "parameter", name: s.param, pattern: null },
  );
  return {
    id: `rt_${operationId.replace(/[^a-z0-9]+/gi, "_")}`,
    operationId,
    method,
    pathSegments,
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}
