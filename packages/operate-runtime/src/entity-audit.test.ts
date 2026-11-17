import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { PermissionMap, RoleDefinition, RoleName } from "@crossengin/auth";
import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  buildAssociationWriteHandler,
  manifestAssociationWriteRoutes,
  type AssociationHandlerContext,
} from "./association.js";
import { compileOperateServer, type CompiledOperateServer } from "./compile.js";
import {
  ENTITY_AUDIT_ACTIONS,
  EntityAuditUnrecorded,
  REDACTED_VALUE_KEY,
  auditUnavailable,
  auditValuesEqual,
  auditWithholdsClass,
  entityAuditPayloads,
  type EntityWriteAuditEvent,
  type EntityWriteAuditor,
} from "./entity-audit.js";
import { routeFromSpec } from "./operations.js";
import { InMemoryEntityStore, type EntityStore } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const ACTOR = "00000000-0000-4000-8000-0000000000aa";

describe("entityAuditPayloads", () => {
  const classified = [
    { name: "mrn", classification: "phi" as const },
    { name: "email", classification: "pii" as const },
    { name: "cost", classification: "commercial_sensitive" as const },
    { name: "ward", classification: "internal" as const },
    { name: "name" },
  ];

  it("withholds every sensitive class's value and keeps the rest", () => {
    const p = entityAuditPayloads(
      null,
      { id: "p1", name: "Ada", mrn: "MRN-1", email: "a@x.test", cost: 9, ward: "W1" },
      classified,
    );
    expect(p.after).toEqual({
      id: "p1",
      name: "Ada",
      mrn: { [REDACTED_VALUE_KEY]: "phi" },
      email: { [REDACTED_VALUE_KEY]: "pii" },
      cost: { [REDACTED_VALUE_KEY]: "commercial_sensitive" },
      ward: "W1",
    });
    expect(p.before).toBeNull();
    expect(p.diff).toBeNull();
    expect(JSON.stringify(p)).not.toContain("MRN-1");
    expect(JSON.stringify(p)).not.toContain("a@x.test");
  });

  it("puts a changed sensitive field in the diff as the marker, and an unchanged one nowhere", () => {
    const before = { id: "p1", name: "Ada", mrn: "MRN-1", email: "a@x.test" };
    const after = { id: "p1", name: "Ada L", mrn: "MRN-2", email: "a@x.test" };
    const p = entityAuditPayloads(before, after, classified);
    expect(p.diff).toEqual({
      name: { from: "Ada", to: "Ada L" },
      mrn: { [REDACTED_VALUE_KEY]: "phi" },
    });
    expect(JSON.stringify(p)).not.toMatch(/MRN-[12]/);
  });

  it("reports a key that appears or disappears with null on the missing side", () => {
    const p = entityAuditPayloads({ id: "x", a: 1 }, { id: "x", b: 2 }, []);
    expect(p.diff).toEqual({ a: { from: 1, to: null }, b: { from: null, to: 2 } });
  });

  it("does not report a structurally equal value as changed, whatever its key order", () => {
    const p = entityAuditPayloads({ id: "x", meta: { a: 1, b: [1, 2] } }, { id: "x", meta: { b: [1, 2], a: 1 } }, []);
    expect(p.diff).toEqual({});
    expect(auditValuesEqual([1, { a: 1 }], [1, { a: 1 }])).toBe(true);
    expect(auditValuesEqual([1, 2], [2, 1])).toBe(false);
    expect(auditValuesEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(auditValuesEqual(null, {})).toBe(false);
  });

  it("withholds exactly the sensitive classes", () => {
    expect(auditWithholdsClass("phi")).toBe(true);
    expect(auditWithholdsClass("regulated")).toBe(true);
    expect(auditWithholdsClass("pii")).toBe(true);
    expect(auditWithholdsClass("commercial_sensitive")).toBe(true);
    expect(auditWithholdsClass("internal")).toBe(false);
    expect(auditWithholdsClass("public")).toBe(false);
  });

  it("answers the two 503s with opposite sentences", () => {
    const rolled = auditUnavailable(true);
    const stands = auditUnavailable(false);
    expect(rolled.status).toBe(503);
    expect(stands.status).toBe(503);
    expect(JSON.stringify(rolled)).toContain("was not made");
    expect(JSON.stringify(stands)).toContain("was made");
    expect(ENTITY_AUDIT_ACTIONS).toEqual(["create", "update", "delete", "transition", "link", "unlink"]);
  });
});

const CLINIC = {
  manifestVersion: "1.0",
  meta: { name: "clinic", slug: "clinic", version: "0.0.1" },
  entities: [
    {
      name: "Patient",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "family_name", type: { kind: "text", maxLength: 100 } },
        { name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" },
        { name: "status", type: { kind: "text", maxLength: 20 }, default: { kind: "literal", value: "registered" } },
      ],
    },
  ],
  workflows: {
    patient_lifecycle: {
      kind: "entityLifecycle",
      entity: "Patient",
      stateField: "status",
      initialState: "registered",
      transitions: [{ name: "admit", from: "registered", to: "admitted" }],
    },
  },
  roles: { clinician: { name: "clinician" }, viewer: { name: "viewer" } },
  permissions: {
    Patient: {
      list: { roles: ["clinician", "viewer"] },
      read: { roles: ["clinician", "viewer"] },
      create: { roles: ["clinician"] },
      update: { roles: ["clinician"] },
      delete: { roles: ["clinician"] },
      transitions: { admit: { roles: ["clinician"] } },
    },
  },
} as unknown as Manifest;

const principalRoles = (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" });

function principal(role: string): ResolvedPrincipal {
  return {
    principalId: ACTOR,
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    abacAttributes: {},
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

class CapturingAuditor implements EntityWriteAuditor {
  readonly events: EntityWriteAuditEvent[] = [];
  constructor(private readonly refuse: unknown = null) {}
  async record(event: EntityWriteAuditEvent): Promise<void> {
    if (this.refuse !== null) throw this.refuse;
    this.events.push(event);
  }
}

function serverWith(store: InMemoryEntityStore, auditor?: EntityWriteAuditor): CompiledOperateServer {
  return compileOperateServer(CLINIC, {
    store,
    principalRoles,
    // No guard, so the audit is the only reason an update or a delete loads the stored record —
    // which is what makes "before is recorded" a test of that reason rather than of a guard's.
    writeGuards: [],
    ...(auditor !== undefined ? { entityAudit: auditor } : {}),
  });
}

async function call(
  srv: CompiledOperateServer,
  opId: string,
  opts: { role?: string; params?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<HandlerOutput> {
  const spec = srv.routeSpecs.find((s) => s.operationId === opId);
  if (spec === undefined) throw new Error(`no route for ${opId}`);
  return srv.handlers.resolve(opId)!({
    request: buildIncomingRequest({
      id: "req_audit0000001",
      receivedAt: "2026-06-03T12:00:00.000Z",
      method: spec.method,
      path: "/v1/x",
      headers: {},
      host: "api.example.com",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.1",
      edgeTrust: "untrusted",
    }),
    route: routeFromSpec(spec),
    principal: principal(opts.role ?? "clinician"),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  });
}

function body(out: HandlerOutput): Record<string, unknown> {
  if (out.kind !== "json") throw new Error("expected json");
  return out.body as Record<string, unknown>;
}

async function seededPatient(store: InMemoryEntityStore): Promise<string> {
  const created = await store.create(TENANT, "Patient", {
    family_name: "Lovelace",
    mrn: "MRN-SEED",
    status: "registered",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  return created["id"] as string;
}

describe("entity writes are recorded", () => {
  it("records a create inside its transaction, attributed, with the PHI value withheld", async () => {
    const auditor = new CapturingAuditor();
    const out = await call(serverWith(new InMemoryEntityStore(), auditor), "patient.create", {
      body: { family_name: "Ada", mrn: "MRN-CREATE" },
    });
    expect(out.status).toBe(201);
    expect(auditor.events).toHaveLength(1);
    const e = auditor.events[0]!;
    expect(e).toMatchObject({
      requestId: "req_audit0000001",
      operationId: "patient.create",
      action: "create",
      entity: "Patient",
      tenantId: TENANT,
      recordId: body(out)["id"],
      actorUserId: ACTOR,
      detail: null,
      before: null,
      diff: null,
      inTransaction: true,
    });
    expect(e.after!["mrn"]).toEqual({ [REDACTED_VALUE_KEY]: "phi" });
    expect(e.after!["family_name"]).toBe("Ada");
    expect(JSON.stringify(e)).not.toContain("MRN-CREATE");
  });

  it("records an update with the stored record as before, even with no guard or effect to load it", async () => {
    const store = new InMemoryEntityStore();
    const id = await seededPatient(store);
    const auditor = new CapturingAuditor();
    const out = await call(serverWith(store, auditor), "patient.update", {
      params: { id },
      body: { family_name: "King", mrn: "MRN-NEW" },
    });
    expect(out.status).toBe(200);
    const e = auditor.events[0]!;
    expect(e.action).toBe("update");
    expect(e.recordId).toBe(id);
    expect(e.before!["family_name"]).toBe("Lovelace");
    expect(e.diff!["family_name"]).toEqual({ from: "Lovelace", to: "King" });
    expect(e.diff!["mrn"]).toEqual({ [REDACTED_VALUE_KEY]: "phi" });
    expect(JSON.stringify(e)).not.toMatch(/MRN-(SEED|NEW)/);
  });

  it("records a delete holding what was deleted", async () => {
    const store = new InMemoryEntityStore();
    const id = await seededPatient(store);
    const auditor = new CapturingAuditor();
    expect((await call(serverWith(store, auditor), "patient.delete", { params: { id } })).status).toBe(204);
    const e = auditor.events[0]!;
    expect(e).toMatchObject({ action: "delete", recordId: id, after: null, diff: null });
    expect(e.before!["family_name"]).toBe("Lovelace");
  });

  it("records a transition with its name and the state change", async () => {
    const store = new InMemoryEntityStore();
    const id = await seededPatient(store);
    const auditor = new CapturingAuditor();
    expect((await call(serverWith(store, auditor), "patient.admit", { params: { id } })).status).toBe(200);
    const e = auditor.events[0]!;
    expect(e).toMatchObject({ action: "transition", detail: "admit", operationId: "patient.admit" });
    expect(e.diff!["status"]).toEqual({ from: "registered", to: "admitted" });
  });

  it("records what an effect left on the record, not the handler's copy from before it ran", async () => {
    // The shape of the withholding and booking-rate stamps: an effect writing back onto the record
    // that triggered it, inside the same unit. The response is the handler's copy; the trail must be
    // what is stored.
    const store = new InMemoryEntityStore();
    const id = await seededPatient(store);
    const auditor = new CapturingAuditor();
    const srv = compileOperateServer(CLINIC, {
      store,
      principalRoles,
      writeGuards: [],
      writeEffects: [
        async (input) => {
          if (input.operation === "transition" && input.id !== null) {
            await input.store.update(input.tenantId, input.entity, input.id, { family_name: "Stamped" });
          }
        },
      ],
      entityAudit: auditor,
    });
    expect((await call(srv, "patient.admit", { params: { id } })).status).toBe(200);
    const e = auditor.events[0]!;
    expect(e.after!["family_name"]).toBe("Stamped");
    expect(e.diff!["family_name"]).toEqual({ from: "Lovelace", to: "Stamped" });
    expect(e.diff!["status"]).toEqual({ from: "registered", to: "admitted" });
  });

  it("records nothing for a write that was refused", async () => {
    const auditor = new CapturingAuditor();
    const srv = serverWith(new InMemoryEntityStore(), auditor);
    expect((await call(srv, "patient.create", { role: "viewer", body: { family_name: "x" } })).status).toBe(403);
    expect((await call(srv, "patient.update", { params: { id: "missing" }, body: { family_name: "x" } })).status).toBe(404);
    expect(auditor.events).toHaveLength(0);
  });

  it("refuses with 503 and rolls the write back when the record cannot be made", async () => {
    const store = new InMemoryEntityStore();
    const auditor = new CapturingAuditor(new EntityAuditUnrecorded("emitter down"));
    const out = await call(serverWith(store, auditor), "patient.create", { body: { family_name: "Ada" } });
    expect(out.status).toBe(503);
    expect(body(out)["error"]).toBe("audit_unavailable");
    expect(JSON.stringify(body(out))).toContain("was not made");
    expect(await store.list(TENANT, "Patient")).toHaveLength(0);
  });

  it("rolls back an update and a transition the same way, leaving the stored record as it was", async () => {
    const store = new InMemoryEntityStore();
    const id = await seededPatient(store);
    const srv = serverWith(store, new CapturingAuditor(new EntityAuditUnrecorded("emitter down")));
    expect((await call(srv, "patient.update", { params: { id }, body: { family_name: "King" } })).status).toBe(503);
    expect((await call(srv, "patient.admit", { params: { id } })).status).toBe(503);
    const stored = (await store.get(TENANT, "Patient", id))!;
    expect(stored["family_name"]).toBe("Lovelace");
    expect(stored["status"]).toBe("registered");
  });

  it("treats any other recorder failure as a failed write, still rolled back", async () => {
    const store = new InMemoryEntityStore();
    const out = await call(serverWith(store, new CapturingAuditor(new Error("boom"))), "patient.create", {
      body: { family_name: "Ada" },
    });
    expect(out.status).toBe(500);
    expect(await store.list(TENANT, "Patient")).toHaveLength(0);
  });

  it("says a write on a store with no transaction stands when its record fails", async () => {
    const inner = new InMemoryEntityStore();
    // Every method but `withTransaction`, so `isTransactional` answers false.
    const bare: EntityStore = {
      list: (t, e) => inner.list(t, e),
      listPage: (t, e, q) => inner.listPage(t, e, q),
      get: (t, e, i) => inner.get(t, e, i),
      create: (t, e, r) => inner.create(t, e, r),
      update: (t, e, i, p) => inner.update(t, e, i, p),
      updateIf: (t, e, i, p, x) => inner.updateIf(t, e, i, p, x),
      remove: (t, e, i) => inner.remove(t, e, i),
      removeIf: (t, e, i, x) => inner.removeIf(t, e, i, x),
      getLocked: (t, e, i, l) => inner.getLocked(t, e, i, l),
    };
    const auditor = new CapturingAuditor(new EntityAuditUnrecorded("down"));
    const srv = compileOperateServer(CLINIC, { store: bare, principalRoles, entityAudit: auditor });
    const out = await call(srv, "patient.create", { body: { family_name: "Ada" } });
    expect(out.status).toBe(503);
    expect(JSON.stringify(body(out))).toContain("was made");
    expect(await inner.list(TENANT, "Patient")).toHaveLength(1);
  });
});

describe("association writes are recorded", () => {
  const m2m = {
    relations: [{ kind: "many_to_many", left: "Tag", right: "Product" }],
  } as unknown as Manifest;
  const spec = manifestAssociationWriteRoutes(m2m).find((r) => r.operationId === "tag.product.link")!;
  const permissions = { Tag: { update: { roles: ["editor"] } } } as unknown as PermissionMap;
  const roles = new Map<RoleName, RoleDefinition>([["editor" as RoleName, { name: "editor" } as RoleDefinition]]);
  const linked: string[] = [];
  const store = {
    link: async (_t: string, _l: string, _r: string, leftId: string, rightId: string) => {
      linked.push(`${leftId}->${rightId}`);
    },
    unlink: async () => true,
  } as unknown as EntityStore;

  function invoke(auditor: EntityWriteAuditor): Promise<HandlerOutput> {
    const ctx: AssociationHandlerContext = { store, permissions, roles, principalRoles, entityAudit: auditor };
    return Promise.resolve(
      buildAssociationWriteHandler(spec, ctx)({
        request: { id: "req_assoc0000001" } as never,
        route: {} as never,
        principal: principal("editor"),
        params: { id: "tag-1", relatedId: "prod-a" },
        parsedBody: null,
      }),
    );
  }

  it("records a link after the store call, outside any transaction", async () => {
    const auditor = new CapturingAuditor();
    expect((await invoke(auditor)).status).toBe(204);
    expect(auditor.events[0]).toMatchObject({
      action: "link",
      entity: "Tag",
      recordId: "tag-1",
      detail: "Product",
      after: { relatedEntity: "Product", relatedId: "prod-a" },
      inTransaction: false,
    });
  });

  it("answers 503 saying the link stands when its record fails", async () => {
    const before = linked.length;
    const out = await invoke(new CapturingAuditor(new EntityAuditUnrecorded("down")));
    expect(out.status).toBe(503);
    expect(JSON.stringify((out as { body: unknown }).body)).toContain("was made");
    expect(linked.length).toBe(before + 1);
  });
});
