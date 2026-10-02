import type { PathSegment, ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { AuditLogEntry, ClassifiedField, RoleDefinition, RoleName } from "@crossengin/auth";
import { describe, expect, it } from "vitest";

import {
  AUDIT_READ_DENIED_OPERATION,
  AUDIT_READ_ENTRY_OPERATION,
  AUDIT_READ_LIST_OPERATION,
  buildAuditReadRoutes,
  entityFieldLookupFrom,
  redactAuditPayloads,
  resolveAuditReadGrant,
  resolveAuditScope,
  type AnchoredAuditEntryLike,
  type AuditReadEvent,
  type AuditReadPageLike,
  type AuditReadQueryLike,
  type AuditReadRoutesContext,
  type AuditReadScopeLike,
  type AuditReadSourceLike,
} from "./audit-read-routes.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const READER = "00000000-0000-4000-8000-0000000000a1";
const ACTOR = "00000000-0000-4000-8000-0000000000a2";

const ENTRY_1 = "00000000-0000-4000-8000-0000000000e1";
const ENTRY_2 = "00000000-0000-4000-8000-0000000000e2";

const TENANT_ROLE = "compliance_officer";
const PLATFORM_ROLE = "platform_auditor";
const PHI_ROLE = "phi_reader";

const NOW = new Date("2026-10-01T00:00:00.000Z");

const MRN = "MRN-000123";
const TRACE = "allow because role=clinician input.mrn=MRN-000123";

const ROLES: ReadonlyMap<RoleName, RoleDefinition> = new Map([
  [TENANT_ROLE, { name: TENANT_ROLE }],
  [PLATFORM_ROLE, { name: PLATFORM_ROLE }],
  [PHI_ROLE, { name: PHI_ROLE }],
]);

const PATIENT_FIELDS: readonly ClassifiedField[] = [
  { name: "mrn", classification: "phi" },
  { name: "given_name", classification: "pii" },
  { name: "status" },
];

function entryFor(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: ENTRY_1,
    tenantId: TENANT as AuditLogEntry["tenantId"],
    occurredAt: "2026-09-20T00:00:00.000Z",
    actor: {
      kind: "user",
      userId: ACTOR as AuditLogEntry["actor"]["userId"],
      sessionId: "sess-1",
      ip: "203.0.113.9",
      userAgent: "curl/8",
    },
    operation: "patient.update",
    entity: "Patient",
    entityId: "pat-1",
    before: { mrn: MRN, status: "active" },
    after: { mrn: "MRN-000999", status: "active" },
    diff: { mrn: { from: MRN, to: "MRN-000999" } },
    reason: "correction",
    regoDecisionTrace: TRACE,
    ...overrides,
  };
}

/** A source that applies the scope it was handed, so a leak shows up as visible data. */
class FakeAuditSource implements AuditReadSourceLike {
  readonly rows: AnchoredAuditEntryLike[] = [];
  readonly listCalls: AuditReadQueryLike[] = [];
  throwOnRead: Error | null = null;
  constructor(private readonly log: string[] = []) {}

  seed(entry: AuditLogEntry, anchored = true): AnchoredAuditEntryLike {
    const row: AnchoredAuditEntryLike = {
      entry,
      anchor: anchored ? { sequenceNumber: 12, entryHash: "f".repeat(64) } : null,
    };
    this.rows.push(row);
    return row;
  }

  private inScope(scope: AuditReadScopeLike): AnchoredAuditEntryLike[] {
    return scope.kind === "all"
      ? [...this.rows]
      : this.rows.filter((r) => r.entry.tenantId === scope.tenantId);
  }

  async list(query: AuditReadQueryLike): Promise<AuditReadPageLike> {
    this.log.push("read");
    this.listCalls.push(query);
    if (this.throwOnRead !== null) throw this.throwOnRead;
    return { data: this.inScope(query.scope), nextCursor: null };
  }

  async getById(id: string, scope: AuditReadScopeLike): Promise<AnchoredAuditEntryLike | null> {
    this.log.push("read");
    if (this.throwOnRead !== null) throw this.throwOnRead;
    return this.inScope(scope).find((r) => r.entry.id === id) ?? null;
  }
}

interface Harness {
  readonly ctx: AuditReadRoutesContext;
  readonly source: FakeAuditSource;
  readonly recorded: AuditReadEvent[];
  readonly log: string[];
}

function makeCtx(overrides: Partial<AuditReadRoutesContext> = {}): Harness {
  const log: string[] = [];
  const source = new FakeAuditSource(log);
  const recorded: AuditReadEvent[] = [];
  const ctx: AuditReadRoutesContext = {
    source,
    principalRoles: (p: ResolvedPrincipal | null) => {
      const scopes = p?.grantedScopes ?? [];
      return { primaryRole: scopes[0] ?? "anon", secondaryRoles: scopes.slice(1) };
    },
    platformRoles: new Set([PLATFORM_ROLE]),
    tenantRoles: new Set([TENANT_ROLE]),
    classification: {
      fieldsFor: (entity: string) => (entity === "Patient" ? PATIENT_FIELDS : null),
      roles: ROLES,
      policy: { privilegedRoles: [PHI_ROLE] },
    },
    recordRead: async (event): Promise<void> => {
      log.push("record");
      recorded.push(event);
    },
    clock: () => NOW,
    ...overrides,
  };
  return { ctx, source, recorded, log };
}

function principal(
  roles: readonly string[] | null,
  opts: { tenantId?: string | null; principalId?: string } = {},
): ResolvedPrincipal | null {
  if (roles === null) return null;
  return {
    principalId: opts.principalId ?? READER,
    tenantId: opts.tenantId === undefined ? TENANT : opts.tenantId,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: roles,
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-09-01T00:00:00.000Z",
  } as ResolvedPrincipal;
}

function input(
  p: ResolvedPrincipal | null,
  opts: { query?: Record<string, string>; params?: Record<string, string> } = {},
): HandlerInput {
  return {
    request: { query: opts.query ?? {} } as never,
    route: {} as never,
    principal: p,
    params: opts.params ?? {},
    parsedBody: null,
  };
}

function findHandler(ctx: AuditReadRoutesContext, op: string): Handler {
  const found = buildAuditReadRoutes(ctx).find((r) => r.route.operationId === op);
  if (found === undefined) throw new Error(`no route ${op}`);
  return found.handler;
}

type JsonOut = HandlerOutput & { status: number; body: Record<string, unknown> };

async function call(
  ctx: AuditReadRoutesContext,
  op: string,
  p: ResolvedPrincipal | null = principal([TENANT_ROLE]),
  opts: Parameters<typeof input>[1] = {},
): Promise<JsonOut> {
  return (await findHandler(ctx, op)(input(p, opts))) as JsonOut;
}

function pathOf(segments: readonly PathSegment[]): string {
  return segments
    .map((s) =>
      s.kind === "literal" ? s.value : s.kind === "parameter" ? `:${s.name}` : "*",
    )
    .join("/");
}

function firstEntry(out: JsonOut): Record<string, unknown> {
  const data = out.body["data"] as readonly Record<string, unknown>[];
  return data[0] ?? {};
}

function redactionOf(view: Record<string, unknown>): Record<string, unknown> {
  return view["redaction"] as Record<string, unknown>;
}

describe("buildAuditReadRoutes", () => {
  it("is read-only: two GET routes and nothing else", () => {
    const { ctx } = makeCtx();
    const routes = buildAuditReadRoutes(ctx);
    expect(routes.map((r) => r.route.operationId)).toEqual([
      "audit.entries.list",
      "audit.entries.get",
    ]);
    for (const r of routes) {
      expect(r.route.method).toBe("GET");
      expect(r.route.idempotencyRequired).toBe(false);
    }
    expect(pathOf(routes[1]?.route.pathSegments ?? [])).toBe("v1/audit/entries/:id");
  });

  it("refuses an unauthenticated caller and records nothing", async () => {
    const { ctx, recorded, log } = makeCtx();
    const out = await call(ctx, "audit.entries.list", null);
    expect(out.status).toBe(401);
    expect(recorded).toEqual([]);
    expect(log).toEqual([]);
  });

  it("refuses an unknown role, and configures nobody by default", async () => {
    const { ctx } = makeCtx({ platformRoles: new Set(), tenantRoles: new Set() });
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]));
    expect(out.status).toBe(403);
  });

  it("records a refused attempt, but never turns the refusal into an outage", async () => {
    const { ctx, recorded } = makeCtx();
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]), {
      query: { tenantId: OTHER_TENANT },
    });
    expect(out.status).toBe(403);
    expect(recorded[0]?.operation).toBe(AUDIT_READ_DENIED_OPERATION);
    expect(recorded[0]?.granted).toBe(false);

    const failing = makeCtx({
      recordRead: async (): Promise<void> => {
        throw new Error("audit log down");
      },
    });
    const still = await call(failing.ctx, "audit.entries.list", principal([TENANT_ROLE]), {
      query: { tenantId: OTHER_TENANT },
    });
    expect(still.status).toBe(403);
  });
});

describe("grant and scope resolution", () => {
  it("resolves a platform grant from the role and a tenant grant from the principal", () => {
    const { ctx } = makeCtx();
    expect(resolveAuditReadGrant(ctx, principal([PLATFORM_ROLE]))).toEqual({ kind: "platform" });
    expect(resolveAuditReadGrant(ctx, principal([TENANT_ROLE]))).toEqual({
      kind: "tenant",
      tenantId: TENANT,
    });
    expect(resolveAuditReadGrant(ctx, principal([TENANT_ROLE], { tenantId: null }))).toBeNull();
    expect(resolveAuditReadGrant(ctx, null)).toBeNull();
  });

  it("refuses a tenant naming another tenant instead of narrowing it silently", () => {
    expect(resolveAuditScope({ kind: "tenant", tenantId: TENANT }, OTHER_TENANT)).toEqual({
      error: "forbidden",
      detail: "cannot read another tenant's audit trail",
    });
    expect(resolveAuditScope({ kind: "tenant", tenantId: TENANT }, undefined)).toEqual({
      kind: "tenant",
      tenantId: TENANT,
    });
    expect(resolveAuditScope({ kind: "platform" }, undefined)).toEqual({ kind: "all" });
    expect(resolveAuditScope({ kind: "platform" }, OTHER_TENANT)).toEqual({
      kind: "tenant",
      tenantId: OTHER_TENANT,
    });
    expect(resolveAuditScope({ kind: "platform" }, "not-a-uuid")).toEqual({
      error: "invalid_request",
      detail: "tenantId must be a uuid",
    });
  });

  it("serves a tenant only its own entries, and a platform reader every tenant's", async () => {
    const { ctx, source } = makeCtx();
    source.seed(entryFor());
    source.seed(entryFor({ id: ENTRY_2, tenantId: OTHER_TENANT as AuditLogEntry["tenantId"] }));
    const own = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]));
    expect((own.body["data"] as readonly unknown[]).length).toBe(1);
    const all = await call(ctx, "audit.entries.list", principal([PLATFORM_ROLE]));
    expect((all.body["data"] as readonly unknown[]).length).toBe(2);
    expect(all.body["scope"]).toEqual({ kind: "all" });
  });
});

describe("classification-aware redaction on the read path", () => {
  it("drops a phi field from before, after AND diff for an unprivileged reader", async () => {
    const { ctx, source } = makeCtx();
    source.seed(entryFor());
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]));
    const view = firstEntry(out);
    expect(view["before"]).toEqual({ status: "active" });
    expect(view["after"]).toEqual({ status: "active" });
    // The diff is keyed by field name, so the whole pair goes with the field.
    expect(view["diff"]).toEqual({});
    expect(redactionOf(view)["redactedFields"]).toEqual(["mrn"]);
    // The strongest assertion: the value is nowhere in the response at all.
    expect(JSON.stringify(out.body)).not.toContain(MRN);
  });

  it("serves it to a reader whose role the policy privileges", async () => {
    const { ctx, source } = makeCtx();
    source.seed(entryFor());
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE, PHI_ROLE]));
    const view = firstEntry(out);
    expect(view["before"]).toEqual({ mrn: MRN, status: "active" });
    expect(redactionOf(view)["redactedFields"]).toEqual([]);
  });

  it("withholds the payloads whole for an entity nothing classifies", async () => {
    const { ctx, source } = makeCtx();
    source.seed(entryFor({ entity: "Prescription", after: { drug: "warfarin", dose: "5mg" } }));
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE, PHI_ROLE]));
    const view = firstEntry(out);
    expect(view["before"]).toBeNull();
    expect(view["after"]).toBeNull();
    expect(view["diff"]).toBeNull();
    expect(redactionOf(view)["payloadWithheld"]).toBe("unclassified_entity");
    expect(JSON.stringify(out.body)).not.toContain("warfarin");
    // The record itself is still readable: who did what to which entity, just not with what values.
    expect(view["operation"]).toBe("patient.update");
    expect(view["entity"]).toBe("Prescription");
  });

  it("withholds them when the classification source cannot answer", async () => {
    const { ctx, source } = makeCtx({
      classification: {
        fieldsFor: (): never => {
          throw new Error("manifest unavailable");
        },
        roles: ROLES,
        policy: { privilegedRoles: [PHI_ROLE] },
      },
    });
    source.seed(entryFor());
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE, PHI_ROLE]));
    expect(redactionOf(firstEntry(out))["payloadWithheld"]).toBe("classification_unavailable");
    expect(JSON.stringify(out.body)).not.toContain(MRN);
  });

  it("drops a payload key the entity does not describe, because nothing classifies it", async () => {
    const { ctx, source } = makeCtx();
    source.seed(entryFor({ after: { status: "active", undeclared_note: "transplant candidate" } }));
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE, PHI_ROLE]));
    const view = firstEntry(out);
    expect(view["after"]).toEqual({ status: "active" });
    expect(redactionOf(view)["undescribedFields"]).toEqual(["undeclared_note"]);
    expect(JSON.stringify(out.body)).not.toContain("transplant candidate");
  });

  it("treats the actor's ip and user agent as the personal data they are", async () => {
    const { ctx, source } = makeCtx();
    source.seed(entryFor());
    const plain = firstEntry(await call(ctx, "audit.entries.list", principal([TENANT_ROLE])));
    const actor = plain["actor"] as Record<string, unknown>;
    expect(actor["userId"]).toBe(ACTOR);
    expect(actor).not.toHaveProperty("ip");
    expect(actor).not.toHaveProperty("userAgent");
    expect(actor["redactedFields"]).toEqual(["ip", "userAgent"]);

    const privileged = firstEntry(
      await call(ctx, "audit.entries.list", principal([TENANT_ROLE, PHI_ROLE])),
    );
    expect((privileged["actor"] as Record<string, unknown>)["ip"]).toBe("203.0.113.9");
  });

  it("never ships the policy decision trace, only that there is one", async () => {
    const { ctx, source } = makeCtx();
    source.seed(entryFor());
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE, PHI_ROLE]));
    expect(firstEntry(out)["hasDecisionTrace"]).toBe(true);
    expect(firstEntry(out)).not.toHaveProperty("regoDecisionTrace");
    expect(JSON.stringify(out.body)).not.toContain(TRACE);
  });

  it("reports whether each row is anchored, rather than leaving it to be inferred", async () => {
    const { ctx, source } = makeCtx();
    source.seed(entryFor(), false);
    const view = firstEntry(await call(ctx, "audit.entries.list", principal([TENANT_ROLE])));
    expect(view["anchored"]).toBe(false);
    expect(view["anchor"]).toBeNull();
  });

  it("redacts a payload with no principal at all the same way", () => {
    const { ctx } = makeCtx();
    const payloads = redactAuditPayloads(ctx, entryFor(), null);
    expect(payloads.before).toEqual({ status: "active" });
    expect(payloads.redactedFields).toEqual(["mrn"]);
  });
});

describe("entityFieldLookupFrom", () => {
  it("carries every declared field, with the classification where there is one", () => {
    const lookup = entityFieldLookupFrom({
      entities: [
        {
          name: "Patient",
          fields: [
            { name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" },
            { name: "status", type: { kind: "text", maxLength: 20 } },
          ],
        },
      ],
    });
    expect(lookup("Patient")).toEqual([
      { name: "mrn", classification: "phi" },
      { name: "status" },
    ]);
    // An entity the manifest does not have is unknown, which is not "has nothing sensitive".
    expect(lookup("Ledger")).toBeNull();
  });
});

describe("recording the read before serving it", () => {
  it("writes the record FIRST, then reads", async () => {
    const { ctx, source, recorded, log } = makeCtx();
    source.seed(entryFor());
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]));
    expect(out.status).toBe(200);
    expect(log).toEqual(["record", "read"]);
    expect(recorded[0]?.operation).toBe(AUDIT_READ_LIST_OPERATION);
    expect(recorded[0]?.granted).toBe(true);
    expect(recorded[0]?.tenantId).toBe(TENANT);
    expect(recorded[0]?.principalId).toBe(READER);
    expect(recorded[0]?.roles).toEqual([TENANT_ROLE]);
  });

  it("refuses the read when it cannot be recorded, and never reaches the source", async () => {
    const { ctx, source, log } = makeCtx({
      recordRead: async (): Promise<void> => {
        throw new Error("chain unavailable");
      },
    });
    source.seed(entryFor());
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]));
    expect(out.status).toBe(503);
    expect(out.body["error"]).toBe("audit_unavailable");
    expect(log).toEqual([]);
    expect(JSON.stringify(out.body)).not.toContain("chain unavailable");
  });

  it("hands the failure to the observer without a payload", async () => {
    const seen: { scope: string }[] = [];
    const { ctx, source } = makeCtx({
      recordRead: async (): Promise<void> => {
        throw new Error("down");
      },
      onRecordError: (_err, scopeKind) => seen.push({ scope: scopeKind }),
    });
    source.seed(entryFor());
    await call(ctx, "audit.entries.list", principal([TENANT_ROLE]));
    expect(seen).toEqual([{ scope: "tenant" }]);
  });

  it("records what was read, not merely that something was", async () => {
    const { ctx, recorded } = makeCtx();
    await call(ctx, "audit.entries.list", principal([PLATFORM_ROLE]), {
      query: {
        entity: "Patient",
        operation: "patient.update",
        entityId: "pat-1",
        actorUserId: ACTOR,
        anchoredOnly: "true",
        limit: "10",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-30T00:00:00.000Z",
      },
    });
    expect(recorded[0]?.filters).toEqual({
      scope: "all",
      entity: "Patient",
      operation: "patient.update",
      entityId: "pat-1",
      actorUserId: ACTOR,
      anchoredOnly: true,
      limit: 10,
      paged: false,
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-30T00:00:00.000Z",
    });
    // A cross-tenant read names no single tenant, so there is none to attribute the row to.
    expect(recorded[0]?.tenantId).toBeNull();
    expect(recorded[0]?.scopeKind).toBe("all");
  });

  it("records the single-entry read with the entry it was for", async () => {
    const { ctx, source, recorded } = makeCtx();
    source.seed(entryFor());
    const out = await call(ctx, "audit.entries.get", principal([TENANT_ROLE]), {
      params: { id: ENTRY_1 },
    });
    expect(out.status).toBe(200);
    expect(recorded[0]?.operation).toBe(AUDIT_READ_ENTRY_OPERATION);
    expect(recorded[0]?.filters["auditId"]).toBe(ENTRY_1);
  });
});

describe("filters, window and failure modes", () => {
  it("defaults to a bounded window and caps the range", async () => {
    const { ctx, source } = makeCtx();
    source.seed(entryFor());
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]));
    const query = source.listCalls[0];
    expect(query?.to).toBe(NOW.toISOString());
    expect(query?.from).not.toBeUndefined();
    expect(out.status).toBe(200);

    const tooWide = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]), {
      query: { from: "2020-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
    });
    expect(tooWide.status).toBe(400);
    expect(String(tooWide.body["detail"])).toContain("range exceeds");
  });

  it("refuses an unparseable window and a non-uuid actor filter", async () => {
    const { ctx } = makeCtx();
    const badWindow = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]), {
      query: { from: "yesterday" },
    });
    expect(badWindow.status).toBe(400);
    const badActor = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]), {
      query: { actorUserId: "someone" },
    });
    expect(badActor.status).toBe(400);
  });

  it("does not window the single-entry read, which is not a search", async () => {
    const { ctx, source } = makeCtx();
    source.seed(entryFor());
    const out = await call(ctx, "audit.entries.get", principal([TENANT_ROLE]), {
      params: { id: ENTRY_1 },
      query: { from: "2000-01-01T00:00:00.000Z" },
    });
    expect(out.status).toBe(200);
  });

  it("404s an id that cannot be one, and one that is not there", async () => {
    const { ctx } = makeCtx();
    const bad = await call(ctx, "audit.entries.get", principal([TENANT_ROLE]), {
      params: { id: "../../etc/passwd" },
    });
    expect(bad.status).toBe(404);
    const missing = await call(ctx, "audit.entries.get", principal([TENANT_ROLE]), {
      params: { id: ENTRY_2 },
    });
    expect(missing.status).toBe(404);
  });

  it("refuses the page when a stored row cannot be read, and leaks no error text", async () => {
    const { ctx, source } = makeCtx();
    source.throwOnRead = new Error(`stored audit entry invalid: mrn=${MRN}`);
    const out = await call(ctx, "audit.entries.list", principal([TENANT_ROLE]));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "audit_page_unreadable" });
    expect(JSON.stringify(out.body)).not.toContain(MRN);

    const single = await call(ctx, "audit.entries.get", principal([TENANT_ROLE]), {
      params: { id: ENTRY_1 },
    });
    expect(single.status).toBe(500);
    expect(single.body).toEqual({ error: "audit_entry_unreadable" });
  });
});
