import { readFileSync } from "node:fs";

import type { IncomingRequest, ResolvedPrincipal } from "@crossengin/api-gateway";
import type { RoleName } from "@crossengin/auth";
import {
  InMemoryPrincipalResolver,
  buildIncomingRequest,
  type OpaqueTokenLookup,
} from "@crossengin/api-gateway-runtime";
import { resolvedClassifiedFields, resolvedFields } from "@crossengin/kernel/ddl";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { buildOperateGateway, compileOperateServer, defaultEffectStamps } from "./compile.js";
import { isApproveClassTransition } from "./maker-checker.js";
import { InMemorySettingsStore, type FinanceSettings, type OperationalDefaults } from "./settings.js";
import { InMemoryEntityStore, type EntityRecord } from "./store.js";
import { TAX_REMITTANCE_REFUSALS, taxRemittanceWiring } from "./tax-remittance.js";
import { buildClassifiedFieldIndex } from "./write-mask.js";

// Classification redaction used to be keyed off `[<camel>.list, <camel>.read]`, so every write
// response returned every classified field in the clear: a credential with update permission read
// any record's `phi` fields by issuing a no-op PATCH, and the same held for `create`, `delete` and
// every lifecycle transition. The mapping now comes from the routes `compileOperateServer` actually
// derived, so a transition — whose operationId exists only in the manifest's workflow — is covered
// by construction. These tests pin the property on all three write shapes, and pin the coverage
// itself against the derived routes rather than against a list written out here.

const TENANT = "00000000-0000-4000-8000-000000000001";

// `clerk` may create/update/admit a Patient and may NOT read `mrn` or `given_name`; `clinician`
// may do both. The explicit field grant is what separates them — the two roles are otherwise
// identical, so any difference in a response body is redaction and nothing else.
const CLINIC = {
  meta: { name: "clinic", version: "1.0.0" },
  entities: [
    {
      name: "Patient",
      traits: ["auditable"],
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" },
        { name: "given_name", type: { kind: "text", maxLength: 100 }, classification: "pii" },
        { name: "status", type: { kind: "text", maxLength: 20 } },
      ],
    },
    {
      // A multi-word entity: the real operationId camel-cases (`workOrder.read`), while the
      // deleted default lower-cased the whole name (`workorder.read`) and so matched nothing.
      name: "WorkOrder",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "diagnosis_note", type: { kind: "text", maxLength: 200 }, classification: "phi" },
        { name: "status", type: { kind: "text", maxLength: 20 } },
      ],
    },
    {
      name: "Widget",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "label", type: { kind: "text", maxLength: 20 } },
      ],
    },
  ],
  // An m2m relation derives `GET /v1/widgets/{id}/patients`, whose response carries *Patient*
  // records — so its operationId belongs to Patient's index, not Widget's. (Neither retail nor
  // core declares a many_to_many, so nothing in the packs would exercise this.)
  relations: [{ kind: "many_to_many", left: "Widget", right: "Patient" }],
  workflows: {
    patient_lifecycle: {
      kind: "entityLifecycle",
      entity: "Patient",
      stateField: "status",
      initialState: "registered",
      transitions: [{ name: "admit", from: "registered", to: "admitted" }],
    },
  },
  roles: { clerk: { name: "clerk" }, clinician: { name: "clinician" } },
  permissions: {
    Patient: {
      list: { roles: ["clerk", "clinician"] },
      read: { roles: ["clerk", "clinician"] },
      create: { roles: ["clerk", "clinician"] },
      update: { roles: ["clerk", "clinician"] },
      delete: { roles: ["clinician"] },
      transitions: { admit: { roles: ["clerk", "clinician"] } },
      fields: {
        mrn: { read: { roles: ["clinician"] } },
        given_name: { read: { roles: ["clinician"] } },
      },
    },
    WorkOrder: {
      list: { roles: ["clerk", "clinician"] },
      read: { roles: ["clerk", "clinician"] },
      create: { roles: ["clerk", "clinician"] },
      update: { roles: ["clerk", "clinician"] },
      delete: { roles: ["clinician"] },
      fields: { diagnosis_note: { read: { roles: ["clinician"] } } },
    },
    Widget: {
      list: { roles: ["clerk", "clinician"] },
      read: { roles: ["clerk", "clinician"] },
      create: { roles: ["clerk", "clinician"] },
      update: { roles: ["clerk", "clinician"] },
      delete: { roles: ["clinician"] },
    },
  },
} as unknown as Manifest;

const KEYS: Record<string, string> = { "key-clerk": "clerk", "key-clinician": "clinician" };

function makeServer(manifest: Manifest = CLINIC) {
  const store = new InMemoryEntityStore();
  const principalResolver = new InMemoryPrincipalResolver();
  for (const role of Object.values(KEYS)) {
    principalResolver.register(role, {
      principalId: "00000000-0000-4000-8000-0000000000aa",
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "api_key_header",
      grantedScopes: [role],
      mfaProofAgeSeconds: null,
      resolvedAt: "2026-06-03T12:00:00.000Z",
    });
  }
  const opaqueTokenLookup: OpaqueTokenLookup = {
    async lookup(_req: IncomingRequest, token: string) {
      const role = KEYS[token];
      return role === undefined ? null : { principalRef: role, scopes: [role], tenantId: TENANT };
    },
  };
  const server = buildOperateGateway(manifest, {
    store,
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
    principalResolver,
    opaqueTokenLookup,
    clock: { now: () => new Date("2026-06-03T12:00:00.000Z") },
  });
  return { server, store };
}

function req(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  token: string,
  body?: Record<string, unknown>,
): IncomingRequest {
  return buildIncomingRequest({
    id: `req_${Math.random().toString(36).slice(2, 14)}`,
    receivedAt: "2026-06-03T12:00:00.000Z",
    method,
    path,
    headers:
      body === undefined
        ? { "x-api-key": token }
        : { "x-api-key": token, "content-type": "application/json" },
    host: "api.example.com",
    scheme: "https",
    bodyBytes: body === undefined ? null : new TextEncoder().encode(JSON.stringify(body)),
    clientIp: "203.0.113.1",
    edgeTrust: "untrusted",
  });
}

function bodyOf(bytes: Uint8Array | null): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as Record<string, unknown>;
}

const PATIENT = {
  id: "pat-1",
  mrn: "MRN-1",
  given_name: "Ada",
  status: "registered",
};

describe("compileOperateServer — write responses are redacted per caller", () => {
  it("redacts phi/pii from a create response for an ungranted writer and returns it for a granted one", async () => {
    const asClerk = await makeServer().server.runtime.handleRequest(
      req("POST", "/v1/patients", "key-clerk", { mrn: "MRN-9", given_name: "Grace", status: "registered" }),
    );
    expect(asClerk.response.status).toBe(201);
    expect(asClerk.execution.routeOperationId).toBe("patient.create");
    const clerkBody = bodyOf(asClerk.response.bodyBytes);
    expect(clerkBody).not.toHaveProperty("mrn");
    expect(clerkBody).not.toHaveProperty("given_name");
    expect(clerkBody).toHaveProperty("status", "registered");

    const asClinician = await makeServer().server.runtime.handleRequest(
      req("POST", "/v1/patients", "key-clinician", { mrn: "MRN-9", given_name: "Grace", status: "registered" }),
    );
    expect(asClinician.response.status).toBe(201);
    expect(bodyOf(asClinician.response.bodyBytes)).toMatchObject({ mrn: "MRN-9", given_name: "Grace" });
  });

  it("redacts phi/pii from an update response — the no-op PATCH that used to read any record's MRN", async () => {
    const clerkServer = makeServer();
    await clerkServer.store.create(TENANT, "Patient", PATIENT);
    const asClerk = await clerkServer.server.runtime.handleRequest(
      req("PATCH", "/v1/patients/pat-1", "key-clerk", { status: "registered" }),
    );
    expect(asClerk.response.status).toBe(200);
    expect(asClerk.execution.routeOperationId).toBe("patient.update");
    const clerkBody = bodyOf(asClerk.response.bodyBytes);
    // The PATCH body named only `status`; everything else here is a field the clerk never
    // supplied and cannot read through GET.
    expect(clerkBody).not.toHaveProperty("mrn");
    expect(clerkBody).not.toHaveProperty("given_name");
    // …and the read path still agrees, which is the invariant the write path used to break.
    const read = await clerkServer.server.runtime.handleRequest(req("GET", "/v1/patients/pat-1", "key-clerk"));
    expect(Object.keys(bodyOf(read.response.bodyBytes)).sort()).toEqual(
      Object.keys(clerkBody).sort(),
    );

    const clinicianServer = makeServer();
    await clinicianServer.store.create(TENANT, "Patient", PATIENT);
    const asClinician = await clinicianServer.server.runtime.handleRequest(
      req("PATCH", "/v1/patients/pat-1", "key-clinician", { status: "registered" }),
    );
    expect(bodyOf(asClinician.response.bodyBytes)).toMatchObject({ mrn: "MRN-1", given_name: "Ada" });
  });

  it("redacts phi/pii from a lifecycle transition response — the id no name-derived mapping can know", async () => {
    const clerkServer = makeServer();
    await clerkServer.store.create(TENANT, "Patient", PATIENT);
    const asClerk = await clerkServer.server.runtime.handleRequest(
      req("POST", "/v1/patients/pat-1/admit", "key-clerk", {}),
    );
    expect(asClerk.response.status).toBe(200);
    expect(asClerk.execution.routeOperationId).toBe("patient.admit");
    const clerkBody = bodyOf(asClerk.response.bodyBytes);
    expect(clerkBody).toHaveProperty("status", "admitted");
    expect(clerkBody).not.toHaveProperty("mrn");
    expect(clerkBody).not.toHaveProperty("given_name");

    const clinicianServer = makeServer();
    await clinicianServer.store.create(TENANT, "Patient", PATIENT);
    const asClinician = await clinicianServer.server.runtime.handleRequest(
      req("POST", "/v1/patients/pat-1/admit", "key-clinician", {}),
    );
    expect(bodyOf(asClinician.response.bodyBytes)).toMatchObject({
      mrn: "MRN-1",
      given_name: "Ada",
      status: "admitted",
    });
  });

  it("leaves a 204 delete alone (redaction is a no-op on a body with no such key)", async () => {
    const { server, store } = makeServer();
    await store.create(TENANT, "Patient", PATIENT);
    const deleted = await server.runtime.handleRequest(req("DELETE", "/v1/patients/pat-1", "key-clinician"));
    expect(deleted.response.status).toBe(204);
    expect(deleted.execution.routeOperationId).toBe("patient.delete");
  });
});

describe("compileOperateServer — the redaction index is derived from the routes", () => {
  const compiled = compileOperateServer(CLINIC, {
    store: new InMemoryEntityStore(),
    principalRoles: () => ({ primaryRole: "clerk" }),
  });

  it("registers a spec for every derived operation of every classified entity", () => {
    // Compared against the derived routes, not against a list written out here: a list would be
    // the same defect one level up — the test agreeing with the code about an incomplete set.
    const classified = new Set(
      (CLINIC.entities ?? [])
        .filter((e) => resolvedClassifiedFields(e, CLINIC.traits ?? []).length > 0)
        .map((e) => e.name),
    );
    expect(classified.size).toBeGreaterThan(0);
    const covered = compiled.routeSpecs.filter((s) => classified.has(s.entity));
    expect(covered.length).toBeGreaterThan(0);
    for (const spec of covered) {
      expect(compiled.redactionRegistry.specFor(spec.operationId), spec.operationId).not.toBeNull();
    }
    // And the transition is in there, which is the half a name-derived mapping cannot reach.
    expect(covered.some((s) => s.action === "transition")).toBe(true);
  });

  it("registers no operationId the route derivation does not emit", () => {
    // The phantom `<entity>.get`'s inverse. `MapRedactionRegistry` answers only `specFor`, so the
    // index itself is the thing to walk — every id in it must be one the handler registry serves.
    const served = new Set(compiled.handlers.operationIds());
    expect(served.size).toBeGreaterThan(0);
    for (const [entity, ops] of compiled.redactionOperationIds) {
      expect(ops.length, entity).toBeGreaterThan(0);
      for (const op of ops) {
        expect(served.has(op.operationId), `${entity}: ${op.operationId}`).toBe(true);
      }
    }
    // The two shapes the deleted default produced, named explicitly so neither can come back.
    expect(compiled.redactionRegistry.specFor("patient.get")).toBeNull();
    expect(compiled.redactionRegistry.specFor("workorder.read")).toBeNull();
  });

  it("registers a multi-word entity under its camel-cased id, never the lower-cased one", () => {
    const ids = (compiled.redactionOperationIds.get("WorkOrder") ?? []).map((o) => o.operationId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "workOrder.list",
        "workOrder.create",
        "workOrder.read",
        "workOrder.update",
        "workOrder.delete",
      ]),
    );
    expect(ids.every((id) => id.startsWith("workOrder."))).toBe(true);
    expect(compiled.redactionRegistry.specFor("workOrder.update")).not.toBeNull();
  });

  it("carries each operation's own record shape, derived from its action", () => {
    // The third direction ADR-0343 added to this index: not only "is every covered id one the
    // derivation emits", but "is each covered with the shape its own action produces". A list
    // registered as `record` would answer a per-field record policy against the page wrapper.
    const shapeOf = (entity: string, id: string): string | undefined =>
      (compiled.redactionOperationIds.get(entity) ?? []).find((o) => o.operationId === id)
        ?.recordShape;
    expect(shapeOf("WorkOrder", "workOrder.list")).toBe("page");
    expect(shapeOf("WorkOrder", "workOrder.read")).toBe("record");
    expect(shapeOf("WorkOrder", "workOrder.create")).toBe("record");
    expect(shapeOf("WorkOrder", "workOrder.update")).toBe("record");
    // A 204 with no body: there is no record to locate and nothing to redact.
    expect(shapeOf("WorkOrder", "workOrder.delete")).toBe("none");
    // And the registry was keyed with it, so the gateway reads the same answer.
    expect(compiled.redactionRegistry.specFor("workOrder.list")?.recordShape).toBe("page");
    expect(compiled.redactionRegistry.specFor("workOrder.read")?.recordShape).toBe("record");
  });

  it("attributes an association list route to the entity whose records it serves", () => {
    // `association.ts` says of this handler: "full records; the gateway redacts per-caller at the
    // edge, exactly like the list endpoint". It did not — the route was in no entity's mapping at
    // all. It is attributed by `relatedEntity`, because that is whose records come back.
    const idsFor = (entity: string): readonly string[] =>
      (compiled.redactionOperationIds.get(entity) ?? []).map((o) => o.operationId);
    expect(idsFor("Patient")).toContain("widget.patient.list");
    expect(compiled.redactionRegistry.specFor("widget.patient.list")).not.toBeNull();
    expect(compiled.redactionRegistry.specFor("widget.patient.count")).not.toBeNull();
    // The mirror route serves Widget records, which carry no classification, so no spec.
    expect(idsFor("Widget")).toContain("patient.widget.list");
    expect(compiled.redactionRegistry.specFor("patient.widget.list")).toBeNull();
    // link/unlink are the owner's own update, and return 204 — attributed to the owner.
    expect(idsFor("Patient")).toContain("patient.widget.link");
    // Attribution and shape are different questions (ADR-0343): the list serves the *related*
    // entity's records as a page, the count serves none of them, and link/unlink are attributed to
    // the owner while returning none of its records either. A route can be attributed to an entity
    // and carry none of it.
    expect(compiled.redactionRegistry.specFor("widget.patient.list")?.recordShape).toBe("page");
    expect(compiled.redactionRegistry.specFor("widget.patient.count")?.recordShape).toBe("none");
  });

  it("holds no entry for an entity with no classified field, and registers none", () => {
    // The index covers every entity (it is built from the routes); the *registry* is what skips
    // the unclassified ones, so a Widget route has an index entry and no spec.
    expect(compiled.redactionOperationIds.has("Widget")).toBe(true);
    expect(compiled.redactionRegistry.specFor("widget.update")).toBeNull();
    expect(compiled.redactionRegistry.specFor("widget.read")).toBeNull();
  });
});

const packRegistry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const resolved = await resolveManifest(buildErpRetailPack(), { registry: packRegistry });

describe("compileOperateServer — coverage over a real pack", () => {
  const compiled = compileOperateServer(resolved, {
    store: new InMemoryEntityStore(),
    principalRoles: () => ({ primaryRole: "cashier" }),
  });

  it("covers every derived operation of every classified entity in retail + core", () => {
    const classified = (resolved.entities ?? []).filter(
      (e) => resolvedClassifiedFields(e, resolved.traits ?? []).length > 0,
    );
    expect(classified.length).toBeGreaterThan(0);
    const names = new Set(classified.map((e) => e.name));
    const missing = compiled.routeSpecs
      .filter((s) => names.has(s.entity))
      .filter((s) => compiled.redactionRegistry.specFor(s.operationId) === null)
      .map((s) => s.operationId);
    expect(missing).toEqual([]);
  });

  it("covers the write operations specifically, which is what was missing", () => {
    const writes = compiled.routeSpecs.filter(
      (s) => s.entity === "Product" && s.action !== "list" && s.action !== "read",
    );
    expect(writes.map((s) => s.operationId).sort()).toEqual([
      "product.create",
      "product.delete",
      "product.update",
    ]);
    for (const spec of writes) {
      expect(compiled.redactionRegistry.specFor(spec.operationId), spec.operationId).not.toBeNull();
    }
    // SalesOrder carries `customer_email` (pii) and four lifecycle transitions.
    const transitions = compiled.routeSpecs.filter(
      (s) => s.entity === "SalesOrder" && s.action === "transition",
    );
    expect(transitions.length).toBe(4);
    for (const spec of transitions) {
      expect(compiled.redactionRegistry.specFor(spec.operationId), spec.operationId).not.toBeNull();
    }
  });

  it("every id in the index is served by the handler registry", () => {
    const served = new Set(compiled.handlers.operationIds());
    for (const [entity, ops] of compiled.redactionOperationIds) {
      for (const op of ops) {
        expect(served.has(op.operationId), `${entity}: ${op.operationId}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Field-level write authorization is wired from the compile, and derived from the same
// declaration as the response redaction.
//
// The live reproduction this models: `erp-government` declares `Citizen.national_id` as
// `regulated` with `update: {roles: ["gov_admin"]}`, and a `case_worker` PATCH rewrote it and got
// a 200 — `validateClassifiedWriteMask` existed, was per-class aware and tested, and was called by
// nothing on the request path.
// ---------------------------------------------------------------------------

const GOV = {
  meta: { name: "gov", version: "1.0.0" },
  entities: [
    {
      name: "Citizen",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "full_name", type: { kind: "text", maxLength: 100 }, required: true, classification: "pii" },
        { name: "national_id", type: { kind: "text", maxLength: 32 }, classification: "regulated" },
      ],
    },
  ],
  roles: { gov_admin: { name: "gov_admin" }, case_worker: { name: "case_worker" } },
  permissions: {
    Citizen: {
      list: { roles: ["gov_admin", "case_worker"] },
      read: { roles: ["gov_admin", "case_worker"] },
      create: { roles: ["gov_admin", "case_worker"] },
      update: { roles: ["gov_admin", "case_worker"] },
      delete: { roles: ["gov_admin"] },
      fields: {
        national_id: { read: { roles: ["gov_admin"] }, update: { roles: ["gov_admin"] } },
      },
    },
  },
} as unknown as Manifest;

function govServer(options: Partial<Parameters<typeof buildOperateGateway>[1]> = {}) {
  const store = new InMemoryEntityStore();
  const principalResolver = new InMemoryPrincipalResolver();
  const keys: Record<string, string> = { "key-gov": "gov_admin", "key-case": "case_worker" };
  for (const role of Object.values(keys)) {
    principalResolver.register(role, {
      principalId: "00000000-0000-4000-8000-0000000000aa",
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "api_key_header",
      grantedScopes: [role],
      mfaProofAgeSeconds: null,
      resolvedAt: "2026-06-03T12:00:00.000Z",
    });
  }
  const opaqueTokenLookup: OpaqueTokenLookup = {
    async lookup(_req: IncomingRequest, token: string) {
      const role = keys[token];
      return role === undefined ? null : { principalRef: role, scopes: [role], tenantId: TENANT };
    },
  };
  const server = buildOperateGateway(GOV, {
    store,
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
    principalResolver,
    opaqueTokenLookup,
    clock: { now: () => new Date("2026-06-03T12:00:00.000Z") },
    ...options,
  });
  return { server, store };
}

describe("compileOperateServer — the write mask is reached through the real gateway pipeline", () => {
  it("403s the PATCH that silently rewrote a regulated national identifier", async () => {
    const { server, store } = govServer();
    await store.create(TENANT, "Citizen", { id: "cit-1", full_name: "Ada", national_id: "NID-1" });
    const out = await server.runtime.handleRequest(
      req("PATCH", "/v1/citizens/cit-1", "key-case", { national_id: "NID-CHANGED-BY-CASE-WORKER" }),
    );
    expect(out.response.status).toBe(403);
    expect(out.execution.routeOperationId).toBe("citizen.update");
    const body = bodyOf(out.response.bodyBytes);
    expect(body["field"]).toBe("national_id");
    expect(body["rule"]).toBe("explicit_update_grant");
    // Never the value, on a surface that already redacts the field from this caller's reads.
    expect(JSON.stringify(body)).not.toContain("NID-CHANGED-BY-CASE-WORKER");
    // The stored value is untouched.
    expect((await store.get(TENANT, "Citizen", "cit-1"))?.["national_id"]).toBe("NID-1");
  });

  it("403s the POST that wrote a regulated field the caller can never read back", async () => {
    const { server, store } = govServer();
    const out = await server.runtime.handleRequest(
      req("POST", "/v1/citizens", "key-case", { full_name: "Grace", national_id: "NID-BY-CASE-WORKER" }),
    );
    expect(out.response.status).toBe(403);
    expect((await store.list(TENANT, "Citizen")).length).toBe(0);
  });

  it("lets the granted role write it, and still redacts it from the ungranted one's own writes", async () => {
    const { server } = govServer();
    const created = await server.runtime.handleRequest(
      req("POST", "/v1/citizens", "key-gov", { full_name: "Grace", national_id: "NID-2" }),
    );
    expect(created.response.status).toBe(201);
    expect(bodyOf(created.response.bodyBytes)["national_id"]).toBe("NID-2");

    // A case_worker may create a Citizen without naming the restricted field — `full_name` is
    // pii, required and governed only by the classification default, so the default mode permits
    // it. If it did not, Citizen would be uncreatable by this role in every deployment.
    const mine = await server.runtime.handleRequest(
      req("POST", "/v1/citizens", "key-case", { full_name: "Ada" }),
    );
    expect(mine.response.status).toBe(201);
    expect(bodyOf(mine.response.bodyBytes)).not.toHaveProperty("national_id");
  });

  it("refuses the pii field too once the symmetric rule is switched on", async () => {
    const { server } = govServer({ writeMaskMode: "classified" });
    const out = await server.runtime.handleRequest(
      req("POST", "/v1/citizens", "key-case", { full_name: "Ada" }),
    );
    expect(out.response.status).toBe(403);
    expect(bodyOf(out.response.bodyBytes)["rule"]).toBe("classification_default");
  });

  it("and admits it again for a role the deployment's policy privileges for that class", async () => {
    const { server } = govServer({
      writeMaskMode: "classified",
      policyForEntity: () => ({ privilegedRolesByClass: { pii: ["case_worker"] } }),
    });
    const out = await server.runtime.handleRequest(
      req("POST", "/v1/citizens", "key-case", { full_name: "Ada" }),
    );
    expect(out.response.status).toBe(201);
  });
});

describe("buildClassifiedFieldIndex — over the real packs", () => {
  const index = buildClassifiedFieldIndex(resolved);

  it("agrees with resolvedClassifiedFields in both directions", () => {
    // `resolvedClassifiedFields` and not `classifiedFields(entity.fields)`, which is the whole
    // point: the index is read by the write mask AND, through `classifiedFieldsForEntity`, by the
    // response-redaction registry, so a field a **trait** contributes has to be in it or the two
    // halves of ADR-0329 disagree. Asking the raw entity here would make this test agree with the
    // narrow read instead of with the served table. Compared against the manifest rather than a
    // list: a list would be the test agreeing with the code about an incomplete set.
    const expected = new Map<string, readonly string[]>();
    for (const entity of resolved.entities ?? []) {
      const classified = resolvedClassifiedFields(entity, resolved.traits ?? []);
      if (classified.length > 0) expected.set(entity.name, classified.map((c) => c.field));
    }
    expect(expected.size).toBeGreaterThan(0);
    expect([...index.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [name, fields] of expected) {
      expect((index.get(name) ?? []).map((f) => f.name)).toEqual(fields);
    }
  });

  it("carries the classification, not just the name", () => {
    const product = index.get("Product") ?? [];
    expect(product).toContainEqual({ name: "unit_cost", classification: "commercial_sensitive" });
  });

  it("names a field the retail pack deliberately restricts with an explicit update grant", () => {
    // `Product.unit_cost` is one of the 7 fields across the packs carrying a declared `update`
    // grant — the set `explicit_only` enforces and nothing more.
    expect(resolved.permissions?.["Product"]?.fields?.["unit_cost"]?.update?.roles).toEqual([
      "retail_admin",
      "store_manager",
    ]);
  });
});

/**
 * `buildOperateGateway` forwards its options to `GatewayRuntime` **one named field at a time**, and
 * that list is a maintained list — the shape CLAUDE.md records as having been wrong three times
 * (ADR-0288). It was wrong a fourth time here: ADR-0386 added `requiredJwtClaims`, the caller passed
 * it, and this function dropped it, so `--jwt-optional-claim` printed a relaxed boot line while the
 * verifier still required every claim.
 *
 * Nothing could have caught that except a live request. The drop is invisible three ways at once:
 * the caller passes its JWT options inside a conditional **spread**, which bypasses TypeScript's
 * excess-property check; the field is optional on `GatewayRuntimeOptions`; and its default is the
 * *strict* set, so the dropped declaration produced a safe wrong answer rather than a crash.
 *
 * So this fences the list rather than the field: every option this function accepts and the runtime
 * also accepts must appear in the forwarding literal. Read as text, because the question is about
 * *this function's source* and no type can ask it — a forwarded field is syntactically identical to
 * an absent one from the type system's point of view.
 */
describe("buildOperateGateway's option forwarding", () => {
  const source = readFileSync(new URL("./compile.ts", import.meta.url), "utf8");

  /** The field names declared on an interface, by name, from the source. */
  function interfaceFields(text: string, name: string): readonly string[] {
    const start = text.indexOf(`export interface ${name} `);
    expect(start, `interface ${name} not found`).toBeGreaterThan(-1);
    const open = text.indexOf("{", start);
    let depth = 0;
    let end = open;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = text.slice(open, end);
    return [...body.matchAll(/^\s{2}readonly (\w+)\??:/gm)].map((m) => m[1] as string);
  }

  it("forwards every option it shares with the runtime", () => {
    const accepted = interfaceFields(source, "OperateGatewayOptions");
    expect(accepted.length).toBeGreaterThan(8);

    // The `new GatewayRuntime({...})` argument, which is where a dropped field is dropped.
    const ctor = source.indexOf("new GatewayRuntime({");
    expect(ctor).toBeGreaterThan(-1);
    const literal = source.slice(ctor, source.indexOf("});", ctor));

    /*
     * Options this function deliberately does not hand on, each with the reason it does not.
     *
     * **Empty, and it was seven dead entries.** `OperateGatewayOptions extends
     * OperateRuntimeOptions` and `interfaceFields` reads an interface's **own braces**, so the
     * population here is the 12 fields this interface declares itself — and the seven entries that
     * used to sit in this map (`store`, `allocator`, `settingsStore`, `operationsForEntity`,
     * `sensitiveFieldPolicy`, `abac`, `manifestRoleDirectory`) are all **inherited**, so none of
     * them was ever in `accepted` and none exempted anything. An exemption list that exempts
     * nothing reads as coverage and provides none — ADR-0351's *documented the hazard and checked
     * nothing*, in the fence's own data.
     *
     * The narrow aperture is kept rather than widened, and the alternative is refused on
     * measurement: over the union of both interfaces, **19** fields never reach this literal
     * because the compile step consumes them, so the union form needs 19 entries where
     * `server.test.ts` refused 13 as ADR-0288's maintained list. All 12 own fields are also
     * `GatewayRuntimeOptions` fields, so the intersection form is byte-identical to this one.
     * The *inherited* fields are covered instead by the third check below, which asks whether
     * every accepted option is read anywhere in `compile.ts` — a question that needs no list.
     */
    const notForwarded: Readonly<Record<string, string>> = Object.freeze({});

    const dropped = accepted.filter(
      (f) => !new RegExp(`\\b${f}\\b`).test(literal) && !(f in notForwarded),
    );
    expect(
      dropped,
      `these options reach buildOperateGateway and are not forwarded to GatewayRuntime; either ` +
        `forward them or declare why in notForwarded above`,
    ).toEqual([]);

    // Both directions (`pg-record-retention.ts`'s rule), which is what was missing: an entry
    // naming a field outside the population excuses nothing, and the seven that were here failed
    // this the moment it was written.
    for (const f of Object.keys(notForwarded)) {
      expect(
        accepted,
        `notForwarded names ${f}, which is not in this fence's population — it exempts nothing`,
      ).toContain(f);
    }
  });

  /**
   * The **other direction**, and the one ADR-0386's fence could not see.
   *
   * That check reads the fields `OperateGatewayOptions` declares and asserts each reaches the
   * literal, so it finds a field *dropped from the literal* and is blind to one **never added to
   * this interface at all**: such a field is not in `accepted`, so there is nothing to compare and
   * the intersection the fence works over is empty for it.
   *
   * `mtlsClientLookup` is why this exists. It was added to `GatewayRuntimeOptions` and to
   * `BuildOperateHttpServerOptions` and left off `OperateGatewayOptions`, so the conditional spread
   * in `server.ts` dropped it in silence with `tsc` exiting 0 — ADR-0386's exact mechanism, third
   * occurrence, in the increment citing it. Every test passed; the symptom was two boot lines
   * disagreeing in one process, found by a live boot.
   *
   * Measured before writing: of `GatewayRuntimeOptions`' 18 fields, **6** are unreachable from
   * `buildOperateGateway`, and every one is either built by the compile step or a runtime default
   * nobody surfaces — so the declaration below is six lines rather than a list that will grow
   * faster than it is read.
   */
  it("exposes every runtime option it does not deliberately withhold", () => {
    // Read across the package boundary as text, the idiom `manifest-event-names.ts` uses for
    // kernel's grammar and `served-surface.test.ts` for `node.ts`: importing the type would give a
    // type and not its *field names*, which is the thing being compared.
    const runtimeSource = readFileSync(
      new URL("../../api-gateway-runtime/src/runtime.ts", import.meta.url),
      "utf8",
    );
    const runtimeAccepts = interfaceFields(runtimeSource, "GatewayRuntimeOptions");
    expect(runtimeAccepts.length).toBeGreaterThan(12);

    // Runtime options this compile step deliberately does not surface, each with its reason.
    const notExposed: Readonly<Record<string, string>> = Object.freeze({
      routes: "the compile step derives the route registry from the manifest",
      handlers: "same: the handlers are what compiling a manifest produces",
      redactionRegistry: "same, from the manifest's classifications",
      clockSkewSeconds: "a runtime default; no deployment has asked to set it",
      idempotencyTtlSeconds: "same",
      defaultApiVersion: "same",
    });

    const exposed = new Set([
      ...interfaceFields(source, "OperateGatewayOptions"),
      ...interfaceFields(source, "OperateRuntimeOptions"),
    ]);
    const unreachable = runtimeAccepts.filter((f) => !exposed.has(f) && !(f in notExposed));
    expect(
      unreachable,
      `these GatewayRuntime options cannot be set through buildOperateGateway; either declare them ` +
        `on OperateGatewayOptions and forward them, or add them to notExposed with a reason`,
    ).toEqual([]);

    // Non-vacuity in both directions: the declaration names only fields the runtime really has, and
    // the comparison is over a non-empty exposed set.
    for (const f of Object.keys(notExposed)) {
      expect(runtimeAccepts, `${f} is declared not-exposed and is not a runtime option`).toContain(
        f,
      );
    }
    expect(exposed.size).toBeGreaterThan(20);
    // And the field that occasioned this check is exposed, so the test would have failed before it.
    expect(exposed.has("mtlsClientLookup")).toBe(true);
  });

  /**
   * The **third** hop, and the one neither check above reaches.
   *
   * `buildOperateGateway` hands `compileOperateServer(manifest, options)` the whole object, so no
   * field can be dropped *there* — which is why the first check's narrow scope
   * (`OperateGatewayOptions` alone) is correct rather than an oversight, and why widening it to the
   * union would be checking a hop that has no drop-shaped hazard. What `OperateRuntimeOptions`'
   * fields do cross is `compileOperateServer`'s **own** literals, and those are ADR-0386's triple
   * again in two different spellings:
   *
   *   - a conditional spread into a handler context, which bypasses the excess-property check, so a
   *     drop is syntactically identical to an absent field (`userIdentity`);
   *   - a required read with a `??` default (`new Set(options.adminRoles ?? DEFAULT_ADMIN_ROLES)`),
   *     where a drop is **worse than silent**: the default always wins, which for `adminRoles` is
   *     exactly the hardcoded `["erp_admin"]` the flag exists to replace. No type and no boot line
   *     can see it; the symptom is a 403 for the role an operator declared.
   *
   * So the unit here is neither a literal nor an interface pair but *this function's own source*:
   * every option it accepts must be read somewhere in it. Weaker than naming the literal and
   * stronger than both checks above in the one way that matters — it does not depend on which
   * literal a field lands in, so it holds for a field added to a third one tomorrow.
   *
   * Measured before writing: **all 36** fields across the two interfaces are read, so the
   * declaration below is empty rather than a list that grows faster than it is read.
   */
  it("reads every option it accepts, so a field cannot be accepted and discarded", () => {
    const accepted = [
      ...interfaceFields(source, "OperateGatewayOptions"),
      ...interfaceFields(source, "OperateRuntimeOptions"),
    ];

    // Options this step accepts and deliberately never reads. Empty today, and an entry here is a
    // claim a reader can check rather than a silence (ADR-0331).
    const notRead: Readonly<Record<string, string>> = Object.freeze({});

    const discarded = accepted.filter(
      (f) => !new RegExp(`options\\.${f}\\b`).test(source) && !(f in notRead),
    );
    expect(
      discarded,
      `these options are accepted by buildOperateGateway/compileOperateServer and read nowhere in ` +
        `compile.ts, so a deployment can set them and nothing happens`,
    ).toEqual([]);

    // Non-vacuity on both sides: a reader that stopped matching would report zero discarded fields.
    expect(accepted.length, "the two option interfaces read as empty").toBeGreaterThan(30);
    for (const f of Object.keys(notRead)) {
      expect(accepted, `${f} is declared not-read and is not an accepted option`).toContain(f);
    }
    // And the two fields this check was written for are in the set it compares.
    expect(accepted).toContain("adminRoles");
    expect(accepted).toContain("userIdentity");
  });

  /**
   * The non-vacuity half: without it, a regex that stopped matching anything would report zero
   * dropped fields and pass. ADR-0351's lesson — a test that documents a hazard and checks nothing.
   */
  it("actually reads the forwarding literal, so the check above is not vacuous", () => {
    const ctor = source.indexOf("new GatewayRuntime({");
    const literal = source.slice(ctor, source.indexOf("});", ctor));
    expect(literal).toContain("jwtIssuer");
    expect(literal).toContain("jwtAudience");
    expect(literal).toContain("requiredJwtClaims");
    expect(interfaceFields(source, "OperateGatewayOptions")).toContain("requiredJwtClaims");
  });
});

// ---------------------------------------------------------------------------
// The settlement coverage guard is wired from the compile, and the defect it closes is a
// **divergence** rather than an overstated receivable.
//
// Measured on resolved `erp-core`, the shipped `--pack` default: three lifecycle transitions reach
// `paid` — `Invoice.mark_paid`, `Bill.mark_paid`, `TaxReturn.mark_paid` — and no write effect
// `compile.ts` wires triggers on `paid` at all (all four `triggerState` declarations are `sent` or
// `approved`; `settleableStates` are the states a document is settled *from*, and every settlement
// effect fires on the Payment's edge). So marking an invoice of 120 paid against 50 received leaves
// `computeAging` reporting nothing open — it drops a document whose state is not in `openStates` —
// while the GL control account still carries the residual, and nothing reconciles the two.
//
// These drive the real compiled handlers rather than the guard in isolation, because the thing
// under test is the **wiring**: a guard built and not reached is this repository's most-found shape.
// ---------------------------------------------------------------------------

const COVERAGE_TENANT = TENANT;

/**
 * An Invoice with everything the coverage guard needs — a `total`, a lifecycle reaching `paid` —
 * and no `Payment` entity. The gate's negative control: a guard built here would refuse the
 * `mark_paid` below, so the 200 is the evidence it was not built.
 */
const PAYMENTLESS = {
  meta: { name: "paymentless", version: "1.0.0" },
  entities: [
    {
      name: "Invoice",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "state", type: { kind: "enum", values: ["sent", "paid"] } },
        { name: "total", type: { kind: "decimal", precision: 12, scale: 2 } },
      ],
    },
  ],
  roles: { erp_admin: { name: "erp_admin" } },
  permissions: {
    Invoice: {
      read: { roles: ["erp_admin"] },
      list: { roles: ["erp_admin"] },
      create: { roles: ["erp_admin"] },
      update: { roles: ["erp_admin"] },
      transitions: { mark_paid: { roles: ["erp_admin"] } },
    },
  },
  workflows: {
    invoice_lifecycle: {
      kind: "entityLifecycle",
      entity: "Invoice",
      stateField: "state",
      initialState: "sent",
      states: [{ name: "sent" }, { name: "paid" }],
      transitions: [
        { name: "mark_paid", from: ["sent"], to: "paid", trigger: { kind: "userAction" } },
      ],
    },
  },
};

function coveragePrincipal(): ResolvedPrincipal {
  return {
    principalId: "00000000-0000-4000-8000-0000000000ab",
    tenantId: COVERAGE_TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: ["erp_admin"],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

function coverageServer(allowUncoveredSettlement?: boolean) {
  const store = new InMemoryEntityStore();
  const compiled = compileOperateServer(buildErpCorePack(), {
    store,
    principalRoles: () => ({ primaryRole: "erp_admin" }),
    ...(allowUncoveredSettlement !== undefined ? { allowUncoveredSettlement } : {}),
  });
  return { store, compiled };
}

async function callOperation(
  compiled: ReturnType<typeof compileOperateServer>,
  operationId: string,
  params: Record<string, string>,
  body: Record<string, unknown> | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = compiled.handlers.resolve(operationId);
  if (handler === null) throw new Error(`no handler for ${operationId}`);
  const out = await handler({
    request: req(body === null ? "POST" : "PATCH", "/x", "unused"),
    route: {} as never,
    principal: coveragePrincipal(),
    params,
    parsedBody: body,
  });
  if (out.kind !== "json") throw new Error("expected json");
  return { status: out.status, body: out.body as Record<string, unknown> };
}

async function seedInvoice(
  store: InMemoryEntityStore,
  opts: { readonly state: string; readonly total: number; readonly paid?: number },
): Promise<string> {
  const inv = await store.create(COVERAGE_TENANT, "Invoice", {
    invoice_number: "INV-1",
    state: opts.state,
    total: opts.total,
    currency: "USD",
  });
  const id = String(inv["id"]);
  if (opts.paid !== undefined) {
    await store.create(COVERAGE_TENANT, "Payment", {
      state: "completed",
      direction: "inbound",
      amount: opts.paid,
      invoice_id: id,
    });
  }
  return id;
}

describe("compileOperateServer — settlement coverage is wired for the real pack", () => {
  it("refuses invoice.mark_paid when completed payments fall short", async () => {
    const { store, compiled } = coverageServer();
    const id = await seedInvoice(store, { state: "sent", total: 120, paid: 50 });
    const r = await callOperation(compiled, "invoice.mark_paid", { id }, null);
    expect(r.status).toBe(422);
    expect(r.body["error"]).toBe("uncovered_settlement");
    expect(r.body["detail"]).toContain("70.00 of 120.00");
    // Nothing was written: the guard runs before `store.update`, so the document is still open and
    // the two views still agree.
    expect((await store.get(COVERAGE_TENANT, "Invoice", id))?.["state"]).toBe("sent");
  });

  it("allows invoice.mark_paid once the payments cover it", async () => {
    const { store, compiled } = coverageServer();
    const id = await seedInvoice(store, { state: "sent", total: 120, paid: 120 });
    const r = await callOperation(compiled, "invoice.mark_paid", { id }, null);
    expect(r.status).toBe(200);
    expect((await store.get(COVERAGE_TENANT, "Invoice", id))?.["state"]).toBe("paid");
  });

  it("refuses a plain PATCH that sets state=paid from draft, naming the transitions instead", async () => {
    // This test used to assert `uncovered_settlement` here, which pinned the defect it was written
    // about: the coverage guard was the only thing in front of a PATCH that skipped `send` and
    // `mark_paid` entirely, so a *covered* document went `draft → paid` with no recognition posting
    // and no transition grant consulted. The state field is read-only to an update now, and the
    // refusal names the route the manifest declares.
    const { store, compiled } = coverageServer();
    const id = await seedInvoice(store, { state: "draft", total: 120 });
    const r = await callOperation(compiled, "invoice.update", { id }, { state: "paid" });
    expect(r.status).toBe(422);
    expect(r.body["error"]).toBe("lifecycle_state_not_writable");
    expect(r.body["detail"]).toContain("from 'draft' fire 'send' then 'mark_paid'");
    expect((await store.get(COVERAGE_TENANT, "Invoice", id))?.["state"]).toBe("draft");
  });

  it("lets invoice_locked win over coverage when both refuse an edit of a paid invoice", async () => {
    // The guard order, and it is load-bearing rather than incidental: a document that satisfies
    // *both* guards is the only one that can observe which runs first. Measured live with the
    // coverage guard first, the answer was `uncovered_settlement`, whose remedy (record the payment)
    // would NOT let the edit through, because the locked guard would then refuse it — ADR-0334:
    // naming a fix that cannot work is worse than naming none.
    //
    // It used to be driven by `PATCH {"state":"paid"}` from `sent`, which the lifecycle guard now
    // answers before either of these runs. Raising the total of a paid invoice reaches both: `paid`
    // is a locked state, and the coverage guard refuses a settled document owing more than it did.
    const { store, compiled } = coverageServer();
    const id = await seedInvoice(store, { state: "paid", total: 120, paid: 120 });
    const r = await callOperation(compiled, "invoice.update", { id }, { total: 200 });
    expect(r.status).toBe(422);
    expect(r.body["error"]).toBe("invoice_locked");
  });

  it("still reaches coverage on the transition, which the locked guard lets through", async () => {
    // The complement of the test above, and together they are what says "last" costs nothing: the
    // locked guard returns null on `operation === "transition"` by design, so `mark_paid` — the
    // path this whole guard exists for — lands here from `sent` even though `sent` is locked.
    const { store, compiled } = coverageServer();
    const id = await seedInvoice(store, { state: "sent", total: 120, paid: 50 });
    const r = await callOperation(compiled, "invoice.mark_paid", { id }, null);
    expect(r.body["error"]).toBe("uncovered_settlement");
  });

  it("lets bill_locked win over coverage when both refuse an edit of a paid bill", async () => {
    // This test used to be titled "…which no locked-document guard covers" and asserted
    // `uncovered_settlement`: four `lockedStates` declarations existed — Invoice, TaxReturn,
    // SalesOrder, PurchaseOrder — and none for Bill, so the coverage guard was the only thing in front
    // of a paid bill's total. That absence was the defect, not the specification (ADR-0372's class):
    // with no lock an approved Bill could be deleted and created again under the same number, and
    // approving it again posted a second journal entry. `paid` is a locked state of Bill now, so the
    // edit reaches both guards and the locked one answers first — the invoice twin above, one entity
    // over, and for the reason given there.
    const { store, compiled } = coverageServer();
    const bill = await store.create(COVERAGE_TENANT, "Bill", {
      bill_number: "B-1",
      state: "paid",
      total: 90,
      currency: "USD",
    });
    await store.create(COVERAGE_TENANT, "Payment", { state: "completed", direction: "outbound", amount: 90, bill_id: String(bill["id"]) });
    const r = await callOperation(compiled, "bill.update", { id: String(bill["id"]) }, { total: 120 });
    expect(r.status).toBe(422);
    expect(r.body["error"]).toBe("bill_locked");
    expect(r.body["detail"]).toBe("a paid bill cannot be edited");
    expect((await store.get(COVERAGE_TENANT, "Bill", String(bill["id"])))?.["total"]).toBe(90);
  });

  it("still reaches coverage on bill.mark_paid, which the bill lock lets through", async () => {
    // The complement: the arm of the coverage guard that matters on a Bill is the transition, and the
    // lock returns null on a `transition` by design.
    const { store, compiled } = coverageServer();
    const bill = await store.create(COVERAGE_TENANT, "Bill", {
      bill_number: "B-2",
      state: "approved",
      total: 120,
      currency: "USD",
    });
    await store.create(COVERAGE_TENANT, "Payment", { state: "completed", direction: "outbound", amount: 90, bill_id: String(bill["id"]) });
    const r = await callOperation(compiled, "bill.mark_paid", { id: String(bill["id"]) }, null);
    expect(r.status).toBe(422);
    expect(r.body["error"]).toBe("uncovered_settlement");
    expect(r.body["detail"]).toContain("30.00 of 120.00");
  });

  it("lets an uncovered settlement through under allowUncoveredSettlement", async () => {
    const { store, compiled } = coverageServer(true);
    const id = await seedInvoice(store, { state: "sent", total: 120, paid: 50 });
    const r = await callOperation(compiled, "invoice.mark_paid", { id }, null);
    expect(r.status).toBe(200);
    expect((await store.get(COVERAGE_TENANT, "Invoice", id))?.["state"]).toBe("paid");
  });

  it("serves TaxReturn.mark_paid in the default manual_journal mode, and posts nothing", async () => {
    // `TaxReturn` declares no `total` and `Payment` carries no reference to it, so it is left out of
    // `SETTLEMENT_COVERAGE_DOCUMENTS`: it settles through its own posting (ADR-0467). With no settings
    // store every tenant reads as `manual_journal`, so the transition is a status change and the
    // remittance is the manual journal that has to accompany it — a posting here as well would
    // remit the return twice.
    const { store, compiled } = coverageServer();
    const tr = await store.create(COVERAGE_TENANT, "TaxReturn", {
      return_number: "TR-1",
      state: "filed",
      net_payable: 500,
      currency: "USD",
    });
    const r = await callOperation(compiled, "taxReturn.mark_paid", { id: String(tr["id"]) }, null);
    expect(r.status).toBe(200);
    const after = await store.get(COVERAGE_TENANT, "TaxReturn", String(tr["id"]));
    expect(after?.["state"]).toBe("paid");
    expect(after?.["remitted_at"]).toBeUndefined();
    expect(after?.["remittance_entry_number"]).toBeUndefined();
    const entries = await store.listPage(COVERAGE_TENANT, "JournalEntry", { limit: 10, cursor: null, sort: [], filters: [] });
    expect(entries.records).toEqual([]);
  });

  it("builds no coverage guard for a manifest with an Invoice and no Payment entity", async () => {
    // Gated on `Payment` as every settlement effect is: with nothing recording money arriving the
    // guard would drain an entity the manifest does not declare — harmless on the in-memory store
    // and a missing table on `--store pg-columns`.
    //
    // Asserted through the **behaviour** and not through the absence of an Invoice route, which
    // would have been a test of the fixture rather than of the gate: this manifest has everything
    // the guard needs except a Payment, so a guard built anyway would refuse the write below (zero
    // applied against a total of 120) and the 200 is what says it was not built.
    const noPayments = { ...PAYMENTLESS } as unknown as Manifest;
    const store = new InMemoryEntityStore();
    const compiled = compileOperateServer(noPayments, {
      store,
      principalRoles: () => ({ primaryRole: "erp_admin" }),
    });
    const inv = await store.create(COVERAGE_TENANT, "Invoice", {
      state: "sent",
      total: 120,
    });
    const r = await callOperation(compiled, "invoice.mark_paid", { id: String(inv["id"]) }, null);
    expect(r.status).toBe(200);
  });

  it("keys the guard on the lifecycle's own stateField, not on the `state` fallback", async () => {
    // The guard reads the state field BY NAME, and `SETTLEMENT_COVERAGE_DOCUMENTS` declares none,
    // so it fell back to `state`. On a manifest whose lifecycle drives `status` — which
    // `validateWorkflows` accepts since ADR-0359 because the field exists, and which is the normal
    // shape for `Opportunity.stage`, `WorkOrder.status` and `Enrollment.status` — the guard read
    // `after["state"]`, got `undefined`, and returned null for **every** write, while the boot
    // survey went on naming the entity as guarded: ADR-0337's falsely-true direction on the one
    // surface built to make this gap legible. Reachable from a tenant's own activated manifest.
    //
    // Asserted through the behaviour: this manifest has a Payment and an uncovered total, so a
    // guard that cannot read the state answers 200 and the 422 is what says the wiring took.
    const statusKeyed = JSON.parse(JSON.stringify(PAYMENTLESS)) as Record<string, never>;
    const m = statusKeyed as unknown as {
      entities: { name: string; fields: { name: string; type: unknown }[] }[];
      permissions: Record<string, unknown>;
      workflows: { invoice_lifecycle: { stateField: string } };
    };
    m.entities[0]!.fields[1]!.name = "status";
    m.workflows.invoice_lifecycle.stateField = "status";
    m.entities.push({
      name: "Payment",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "state", type: { kind: "enum", values: ["pending", "completed"] } },
        { name: "amount", type: { kind: "decimal", precision: 12, scale: 2 } },
        { name: "invoice_id", type: { kind: "uuid" } },
      ],
    });
    m.permissions["Payment"] = {
      read: { roles: ["erp_admin"] },
      list: { roles: ["erp_admin"] },
      create: { roles: ["erp_admin"] },
      update: { roles: ["erp_admin"] },
    };

    const store = new InMemoryEntityStore();
    const compiled = compileOperateServer(statusKeyed as unknown as Manifest, {
      store,
      principalRoles: () => ({ primaryRole: "erp_admin" }),
    });
    const inv = await store.create(COVERAGE_TENANT, "Invoice", { status: "sent", total: 120 });
    const r = await callOperation(compiled, "invoice.mark_paid", { id: String(inv["id"]) }, null);
    expect(r.status).toBe(422);
    expect(r.body["error"]).toBe("uncovered_settlement");
  });
});

describe("compileOperateServer — report surfaces are the handlers' own", () => {
  function reportServer(financeRoles?: readonly RoleName[]) {
    return compileOperateServer(buildErpCorePack(), {
      store: new InMemoryEntityStore(),
      principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
      ...(financeRoles !== undefined ? { financeRoles } : {}),
    });
  }

  async function statusAs(
    compiled: ReturnType<typeof compileOperateServer>,
    operationId: string,
    role: string,
  ): Promise<number> {
    const handler = compiled.handlers.resolve(operationId);
    if (handler === null) throw new Error(`no handler for ${operationId}`);
    const out = await handler({
      request: req("GET", "/x", "unused"),
      route: {} as never,
      principal: { ...coveragePrincipal(), grantedScopes: [role] },
      params: {},
      parsedBody: null,
    });
    if (out.kind !== "json") throw new Error("expected json");
    return out.status;
  }

  it("names both mounted reports on erp-core, with every entity each reads", () => {
    const surfaces = reportServer().reportSurfaces;
    expect(surfaces.map((s) => [s.operationId, s.reads])).toEqual([
      ["meta.aging.read", ["Invoice", "Bill", "Payment"]],
      ["meta.whtReconciliation.read", ["Invoice", "WhtCertificate"]],
    ]);
    expect([...(surfaces[0]?.viewerRoles ?? [])].sort()).toEqual(
      ["ap_clerk", "controller", "erp_accountant", "erp_admin"],
    );
  });

  it("says only what is registered: every surface is a route and a handler", () => {
    const compiled = reportServer();
    const routeIds = new Set(compiled.routes.list().map((r) => r.operationId));
    for (const s of compiled.reportSurfaces) {
      expect(routeIds.has(s.operationId)).toBe(true);
      expect(compiled.handlers.resolve(s.operationId)).not.toBeNull();
    }
  });

  it("carries the set each handler enforces: admitted exactly when the surface says so", async () => {
    // A test of agreement between the surface and the live handler, over roles inside and outside
    // the set — the property that a survey reading `reportSurfaces` describes what a request meets.
    const compiled = reportServer();
    for (const s of compiled.reportSurfaces) {
      for (const role of ["erp_admin", "controller", "ap_clerk", "erp_viewer", "tax_manager"]) {
        const status = await statusAs(compiled, s.operationId, role);
        expect(status === 403).toBe(!s.viewerRoles.has(role as RoleName));
      }
    }
  });

  it("follows the financeRoles option, so the surface cannot describe a default the handler dropped", async () => {
    const compiled = reportServer(["auditor" as RoleName]);
    for (const s of compiled.reportSurfaces) {
      expect([...s.viewerRoles]).toEqual(["auditor"]);
      expect(await statusAs(compiled, s.operationId, "auditor")).not.toBe(403);
      expect(await statusAs(compiled, s.operationId, "erp_admin")).toBe(403);
    }
  });

  it("is empty for a manifest that models none of a report's entities", () => {
    const compiled = compileOperateServer(PAYMENTLESS as unknown as Manifest, {
      store: new InMemoryEntityStore(),
      principalRoles: () => ({ primaryRole: "erp_admin" }),
    });
    expect(compiled.reportSurfaces).toEqual([]);
    expect(compiled.routes.list().some((r) => r.operationId.startsWith("meta.aging"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A line cannot leave a locked document (C-02). The child arm of `lockedDocumentGuard` read
// `after[parentField] ?? before[parentField]`, and `after` is the merged record on an update, so
// it checked only the parent a line was moving *to*: re-pointing a credit line of a posted entry at
// a draft one left the posted entry 500 debit / 0 credit. Driven through the real pack's wiring,
// over every child config `defaultWriteGuards` builds (retail's `OrderLine` below), so a fix on one child cannot pass here
// while another stays open.
// ---------------------------------------------------------------------------

const LOCKED_PARENTS = [
  { parent: "JournalEntry", child: "JournalLine", ref: "journal_entry_id", locked: "posted", error: "posted_entry_locked_lines" },
  { parent: "Invoice", child: "InvoiceLine", ref: "invoice_id", locked: "sent", error: "invoice_locked_lines" },
  { parent: "SalesOrder", child: "SalesOrderLine", ref: "sales_order_id", locked: "confirmed", error: "sales_order_locked_lines" },
  { parent: "PurchaseOrder", child: "PurchaseOrderLine", ref: "purchase_order_id", locked: "approved", error: "purchase_order_locked_lines" },
] as const;

function camelOf(entity: string): string {
  return entity[0]!.toLowerCase() + entity.slice(1);
}

describe("compileOperateServer — a line cannot be re-parented out of a locked document", () => {
  for (const c of LOCKED_PARENTS) {
    it(`refuses moving a ${c.child} out of a ${c.locked} ${c.parent}, and leaves it where it was`, async () => {
      const { store, compiled } = coverageServer();
      const locked = await store.create(COVERAGE_TENANT, c.parent, { state: c.locked });
      const draft = await store.create(COVERAGE_TENANT, c.parent, { state: "draft" });
      const line = await store.create(COVERAGE_TENANT, c.child, { [c.ref]: String(locked["id"]) });
      const r = await callOperation(
        compiled,
        `${camelOf(c.child)}.update`,
        { id: String(line["id"]) },
        { [c.ref]: String(draft["id"]) },
      );
      expect(r.status).toBe(422);
      expect(r.body["error"]).toBe(c.error);
      expect(r.body["detail"]).toContain("cannot move a line out of");
      expect((await store.get(COVERAGE_TENANT, c.child, String(line["id"])))?.[c.ref]).toBe(String(locked["id"]));
    });

    it(`still moves a ${c.child} between two unlocked ${c.parent}s`, async () => {
      const { store, compiled } = coverageServer();
      const a = await store.create(COVERAGE_TENANT, c.parent, { state: "draft" });
      const b = await store.create(COVERAGE_TENANT, c.parent, { state: "draft" });
      const line = await store.create(COVERAGE_TENANT, c.child, { [c.ref]: String(a["id"]) });
      const r = await callOperation(compiled, `${camelOf(c.child)}.update`, { id: String(line["id"]) }, { [c.ref]: String(b["id"]) });
      expect(r.status).toBe(200);
      expect(r.body[c.ref]).toBe(String(b["id"]));
    });
  }

  it("keeps a posted entry balanced: the L13 reproduction", async () => {
    const { store, compiled } = coverageServer();
    const posted = await store.create(COVERAGE_TENANT, "JournalEntry", { state: "posted" });
    const draft = await store.create(COVERAGE_TENANT, "JournalEntry", { state: "draft" });
    await store.create(COVERAGE_TENANT, "JournalLine", { journal_entry_id: String(posted["id"]), debit: 500, credit: 0 });
    const credit = await store.create(COVERAGE_TENANT, "JournalLine", {
      journal_entry_id: String(posted["id"]),
      debit: 0,
      credit: 500,
    });
    const r = await callOperation(
      compiled,
      "journalLine.update",
      { id: String(credit["id"]) },
      { journal_entry_id: String(draft["id"]) },
    );
    expect(r.status).toBe(422);
    const page = await store.listPage(COVERAGE_TENANT, "JournalLine", {
      sort: [],
      filters: [{ field: "journal_entry_id", op: "eq", value: String(posted["id"]) }],
      limit: 10,
      cursor: null,
    });
    const totals = page.records.reduce<{ debit: number; credit: number }>(
      (t, l) => ({ debit: t.debit + Number(l["debit"]), credit: t.credit + Number(l["credit"]) }),
      { debit: 0, credit: 0 },
    );
    expect(totals).toEqual({ debit: 500, credit: 500 });
  });

  it("locks retail's own OrderLine with a placed SalesOrder, beside core's SalesOrderLine", async () => {
    const store = new InMemoryEntityStore();
    const compiled = compileOperateServer(resolved, { store, principalRoles: () => ({ primaryRole: "cashier" }) });
    const placed = await store.create(COVERAGE_TENANT, "SalesOrder", { state: "placed" });
    const cart = await store.create(COVERAGE_TENANT, "SalesOrder", { state: "cart" });
    const line = await store.create(COVERAGE_TENANT, "OrderLine", { sales_order_id: String(placed["id"]), quantity: 2 });
    const moved = await callOperation(compiled, "orderLine.update", { id: String(line["id"]) }, { sales_order_id: String(cart["id"]) });
    expect(moved.status).toBe(422);
    expect(moved.body["error"]).toBe("sales_order_locked_lines");
    const edited = await callOperation(compiled, "orderLine.update", { id: String(line["id"]) }, { quantity: 9 });
    expect(edited.body["error"]).toBe("sales_order_locked_lines");
    // The control: a cart's lines stay editable.
    const cartLine = await store.create(COVERAGE_TENANT, "OrderLine", { sales_order_id: String(cart["id"]), quantity: 1 });
    expect((await callOperation(compiled, "orderLine.update", { id: String(cartLine["id"]) }, { quantity: 3 })).status).toBe(200);
    expect((await store.get(COVERAGE_TENANT, "OrderLine", String(line["id"])))?.["quantity"]).toBe(2);
  });

  it("keeps a reversed entry's lines where they are, since its mirror offsets exactly those", async () => {
    // `reversed` is the state a posted entry leaves `posted` for, and the reversal effect writes a
    // mirror entry negating the lines it found at that moment. Moving, editing or deleting one of the
    // original's lines afterwards — or deleting the original — breaks that pairing, so the line set
    // is as immutable after the reversal as before it.
    const { store, compiled } = coverageServer();
    const reversed = await store.create(COVERAGE_TENANT, "JournalEntry", { state: "reversed" });
    const draft = await store.create(COVERAGE_TENANT, "JournalEntry", { state: "draft" });
    const line = await store.create(COVERAGE_TENANT, "JournalLine", {
      journal_entry_id: String(reversed["id"]),
      debit: 0,
      credit: 500,
    });
    const moved = await callOperation(compiled, "journalLine.update", { id: String(line["id"]) }, { journal_entry_id: String(draft["id"]) });
    expect(moved.status).toBe(422);
    expect(moved.body["error"]).toBe("posted_entry_locked_lines");
    const edited = await callOperation(compiled, "journalLine.update", { id: String(line["id"]) }, { credit: 1 });
    expect(edited.body["error"]).toBe("posted_entry_locked_lines");
    const added = await callOperation(compiled, "journalLine.create", {}, {
      journal_entry_id: String(reversed["id"]),
      ledger_account_id: "00000000-0000-4000-8000-0000000000a1",
      debit: 1,
      credit: 0,
    });
    expect(added.body["error"]).toBe("posted_entry_locked_lines");
    const deleted = await callOperation(compiled, "journalEntry.delete", { id: String(reversed["id"]) }, null);
    expect(deleted.body["error"]).toBe("posted_entry_immutable");
    expect((await store.get(COVERAGE_TENANT, "JournalLine", String(line["id"])))?.["credit"]).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// A lifecycle state field moves only through its declared transitions (C-03). It is an ordinary
// `enum`, so a plain PATCH could set any state, skip the transition's grant and from-state check,
// and re-enter a posting state: Bill draft → approved → draft → approved posted to the GL once per
// arrival (L15). ADR-0391 guarded only the edge into `paid`.
// ---------------------------------------------------------------------------

const BILL_BODY = {
  bill_number: "B-L15",
  vendor_id: "00000000-0000-4000-8000-0000000000c1",
  bill_date: "2026-06-01",
  due_date: "2026-07-01",
  subtotal: "100.00",
  tax_total: "0.00",
  total: "100.00",
  currency: "USD",
};

async function journalEntryCount(store: InMemoryEntityStore): Promise<number> {
  const page = await store.listPage(COVERAGE_TENANT, "JournalEntry", { sort: [], filters: [], limit: 100, cursor: null });
  return page.records.length;
}

describe("compileOperateServer — lifecycle state moves only through transitions", () => {
  it("refuses the L15 loop: a Bill cannot be PATCHed into approved, so nothing posts", async () => {
    const { store, compiled } = coverageServer();
    const created = await callOperation(compiled, "bill.create", {}, BILL_BODY);
    expect(created.status).toBe(201);
    expect(created.body["state"]).toBe("draft");
    const id = String(created.body["id"]);

    const patched = await callOperation(compiled, "bill.update", { id }, { state: "approved" });
    expect(patched.status).toBe(422);
    expect(patched.body["error"]).toBe("lifecycle_state_not_writable");
    expect(patched.body["detail"]).toContain("from 'draft' fire 'approve'");
    expect(await journalEntryCount(store)).toBe(0);

    // The declared route still works, and posts exactly once.
    const approved = await callOperation(compiled, "bill.approve", { id }, null);
    expect(approved.status).toBe(200);
    expect(await journalEntryCount(store)).toBe(1);

    // And the way back that re-entered the posting state is closed.
    const back = await callOperation(compiled, "bill.update", { id }, { state: "draft" });
    expect(back.status).toBe(422);
    expect(back.body["detail"]).toContain("no declared transition leads from 'approved' to 'draft'");
    expect(await journalEntryCount(store)).toBe(1);
  });

  it("refuses a create that lands past the initial state, naming the route", async () => {
    const { store, compiled } = coverageServer();
    const r = await callOperation(compiled, "bill.create", {}, { ...BILL_BODY, state: "approved" });
    expect(r.status).toBe(422);
    expect(r.body["error"]).toBe("lifecycle_state_not_initial");
    expect(r.body["detail"]).toContain("created in 'draft'");
    expect(r.body["detail"]).toContain("fire 'approve'");
    expect(await journalEntryCount(store)).toBe(0);
  });

  it("admits a create naming the initial state, and an update re-sending the stored state", async () => {
    const { compiled } = coverageServer();
    const r = await callOperation(compiled, "bill.create", {}, { ...BILL_BODY, state: "draft" });
    expect(r.status).toBe(201);
    const id = String(r.body["id"]);
    const same = await callOperation(compiled, "bill.update", { id }, { state: "draft", total: "110.00", subtotal: "110.00" });
    expect(same.status).toBe(200);
    expect(same.body["total"]).toBe("110.00");
  });

  it("answers ahead of the coverage guard for a PATCH into paid, with the route that exists", async () => {
    // Before this guard the coverage guard answered `uncovered_settlement`, and for a *covered*
    // invoice it answered nothing: the state went `draft → paid` with no recognition posting.
    const { store, compiled } = coverageServer();
    const id = await seedInvoice(store, { state: "draft", total: 120, paid: 120 });
    const r = await callOperation(compiled, "invoice.update", { id }, { state: "paid" });
    expect(r.status).toBe(422);
    expect(r.body["error"]).toBe("lifecycle_state_not_writable");
    expect((await store.get(COVERAGE_TENANT, "Invoice", id))?.["state"]).toBe("draft");
  });

  it("runs ahead of invoice_locked, so a state PATCH on a sent invoice is told the transition", async () => {
    // Only a document that satisfies both guards observes the order. `sent` is locked, so with the
    // locked guard first this answered `invoice_locked … void it instead` — true, and not how the
    // state moves: `mark_paid` is the route, and it is what the caller asked for.
    const { store, compiled } = coverageServer();
    const id = await seedInvoice(store, { state: "sent", total: 120, paid: 120 });
    const r = await callOperation(compiled, "invoice.update", { id }, { state: "paid" });
    expect(r.body["error"]).toBe("lifecycle_state_not_writable");
    expect(r.body["detail"]).toContain("from 'sent' fire 'mark_paid'");
  });

  it("guards a lifecycle on a field other than `state`", async () => {
    const { store, compiled } = coverageServer();
    const opp = await store.create(COVERAGE_TENANT, "Opportunity", { stage: "prospecting" });
    const r = await callOperation(compiled, "opportunity.update", { id: String(opp["id"]) }, { stage: "won" });
    expect(r.status).toBe(422);
    expect(r.body["detail"]).toContain("'stage' on Opportunity");
    expect(r.body["detail"]).toContain(
      "from 'prospecting' fire 'advance_to_qualification' then 'advance_to_proposal' then 'advance_to_negotiation' then 'win'",
    );
  });

  it("posts and reverses a journal entry through its transitions, not by PATCH", async () => {
    const { store, compiled } = coverageServer();
    const entry = await store.create(COVERAGE_TENANT, "JournalEntry", { state: "draft", entry_number: "JE-1" });
    const id = String(entry["id"]);
    await store.create(COVERAGE_TENANT, "JournalLine", { journal_entry_id: id, debit: 10, credit: 0 });
    await store.create(COVERAGE_TENANT, "JournalLine", { journal_entry_id: id, debit: 0, credit: 10 });
    const patched = await callOperation(compiled, "journalEntry.update", { id }, { state: "posted" });
    expect(patched.status).toBe(422);
    expect(patched.body["detail"]).toContain("fire 'post'");
    expect((await callOperation(compiled, "journalEntry.post", { id }, null)).status).toBe(200);
    expect((await callOperation(compiled, "journalEntry.update", { id }, { state: "reversed" })).status).toBe(422);
    expect((await callOperation(compiled, "journalEntry.reverse", { id }, null)).status).toBe(200);
    expect(await journalEntryCount(store)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// A document whose state has caused a GL posting cannot be deleted, and its posting-relevant fields
// and lines cannot change. The documents are the ones `defaultWriteEffects` posts from — Invoice and
// JournalEntry were already locked; Bill (`approved`), Payment (`completed`) and WhtCertificate
// (`confirmed`) were not. Measured live before this lock on `--store pg`: approve a Bill (200),
// DELETE it (204), POST it again with the same `bill_number` (201), approve (200) — two journal
// entries for one bill number, and a BillLine could be moved out of the approved bill (200).
// ---------------------------------------------------------------------------

describe("compileOperateServer — a posted document is locked", () => {
  it("refuses deleting an approved Bill, which is what made delete-and-recreate double-post", async () => {
    const { store, compiled } = coverageServer();
    const created = await callOperation(compiled, "bill.create", {}, { ...BILL_BODY, bill_number: "B-DEL" });
    const id = String(created.body["id"]);
    expect((await callOperation(compiled, "bill.approve", { id }, null)).status).toBe(200);
    expect(await journalEntryCount(store)).toBe(1);

    const deleted = await callOperation(compiled, "bill.delete", { id }, null);
    expect(deleted.status).toBe(422);
    expect(deleted.body["error"]).toBe("bill_locked");
    // The remedy names a declared transition and says what it does: voiding an approved bill
    // reverses its posting (`postingReversalEffect`), so there is nothing else to reverse by hand.
    expect(deleted.body["detail"]).toBe(
      "an approved bill cannot be deleted; void it instead, which reverses its posting",
    );
    expect(await store.get(COVERAGE_TENANT, "Bill", id)).not.toBeNull();
    expect(await journalEntryCount(store)).toBe(1);
  });

  it("keeps a voided bill locked, so it cannot be deleted and recreated either", async () => {
    // A void bill's posting has been reversed, and the record is the evidence the pair belongs to.
    const { store, compiled } = coverageServer();
    const created = await callOperation(compiled, "bill.create", {}, { ...BILL_BODY, bill_number: "B-VOID" });
    const id = String(created.body["id"]);
    await callOperation(compiled, "bill.approve", { id }, null);
    expect((await callOperation(compiled, "bill.void", { id }, null)).status).toBe(200);
    const deleted = await callOperation(compiled, "bill.delete", { id }, null);
    expect(deleted.body["error"]).toBe("bill_locked");
    // No declared transition leaves `void`, so the refusal names no remedy rather than an impossible one.
    expect(deleted.body["detail"]).toBe("a void bill cannot be deleted");
    // Recognition and its reversal.
    expect(await journalEntryCount(store)).toBe(2);
  });

  it("locks an approved bill's lines, including moving one out", async () => {
    const { store, compiled } = coverageServer();
    const approved = await store.create(COVERAGE_TENANT, "Bill", { bill_number: "B-L1", state: "approved", total: 100 });
    const draft = await store.create(COVERAGE_TENANT, "Bill", { bill_number: "B-L2", state: "draft", total: 0 });
    const line = await store.create(COVERAGE_TENANT, "BillLine", { bill_id: String(approved["id"]), amount: 100 });
    const lineId = String(line["id"]);

    const moved = await callOperation(compiled, "billLine.update", { id: lineId }, { bill_id: String(draft["id"]) });
    expect(moved.status).toBe(422);
    expect(moved.body["error"]).toBe("bill_locked_lines");
    expect(moved.body["detail"]).toBe("cannot move a line out of an approved bill");
    const edited = await callOperation(compiled, "billLine.update", { id: lineId }, { amount: 1 });
    expect(edited.body["error"]).toBe("bill_locked_lines");
    expect((await callOperation(compiled, "billLine.delete", { id: lineId }, null)).body["error"]).toBe("bill_locked_lines");
    expect((await store.get(COVERAGE_TENANT, "BillLine", lineId))?.["bill_id"]).toBe(String(approved["id"]));

    // The control: a draft bill's line moves and edits freely.
    const draftLine = await store.create(COVERAGE_TENANT, "BillLine", { bill_id: String(draft["id"]), amount: 5 });
    expect((await callOperation(compiled, "billLine.update", { id: String(draftLine["id"]) }, { amount: 6 })).status).toBe(200);
  });

  it("leaves the whole ordinary flow open: approve, pay, the effect settles the locked bill, refund", async () => {
    // The control for every lock above. `paymentApplicationEffect` marks the bill paid through
    // `store.update` while the bill sits in a locked state, and `refund` fires from a locked one; a
    // lock that reached either would break the flow it exists to protect. Effects write through the
    // store, past the guards — this pins that rather than assuming it.
    const { store, compiled } = coverageServer();
    const bill = await callOperation(compiled, "bill.create", {}, { ...BILL_BODY, bill_number: "B-FLOW" });
    const billId = String(bill.body["id"]);
    expect((await callOperation(compiled, "bill.approve", { id: billId }, null)).status).toBe(200);
    const pay = await callOperation(compiled, "payment.create", {}, {
      direction: "outbound",
      amount: "100.00",
      bill_id: billId,
    });
    expect(pay.status).toBe(201);
    const payId = String(pay.body["id"]);
    expect((await callOperation(compiled, "payment.submit", { id: payId }, null)).status).toBe(200);
    expect((await callOperation(compiled, "payment.complete", { id: payId }, null)).status).toBe(200);
    expect((await store.get(COVERAGE_TENANT, "Bill", billId))?.["state"]).toBe("paid");
    expect((await callOperation(compiled, "payment.refund", { id: payId }, null)).status).toBe(200);
    // Recognition, settlement and the refund's reversal of the settlement — and the refund re-opens
    // the bill, since nothing is applied to it any more. Into `overdue` and not `approved`: this
    // server reads the real clock and BILL_BODY fell due on 2026-07-01, so the re-open follows the
    // due date (ADR-0475) — deterministic, since that date only recedes.
    expect(await journalEntryCount(store)).toBe(3);
    expect((await store.get(COVERAGE_TENANT, "Bill", billId))?.["state"]).toBe("overdue");
  });

  it("locks a completed payment, whose settlement has posted", async () => {
    const { store, compiled } = coverageServer();
    const paid = await store.create(COVERAGE_TENANT, "Payment", { payment_number: "P-1", state: "completed", amount: 50 });
    const id = String(paid["id"]);
    const edited = await callOperation(compiled, "payment.update", { id }, { amount: 500 });
    expect(edited.status).toBe(422);
    expect(edited.body["error"]).toBe("payment_locked");
    expect(edited.body["detail"]).toBe(
      "a completed payment cannot be edited; refund it if the money was returned, which reverses its settlement",
    );
    const deleted = await callOperation(compiled, "payment.delete", { id }, null);
    expect(deleted.body["error"]).toBe("payment_locked");
    expect((await store.get(COVERAGE_TENANT, "Payment", id))?.["amount"]).toBe(50);

    // The control: a pending payment has posted nothing, so it is still editable.
    const pending = await store.create(COVERAGE_TENANT, "Payment", { payment_number: "P-2", state: "pending", amount: 50 });
    expect((await callOperation(compiled, "payment.update", { id: String(pending["id"]) }, { amount: 60 })).status).toBe(200);
  });

  it("closes the WhtCertificate confirm loop, which re-posted the clearing entry on every arrival", async () => {
    // WhtCertificate has no lifecycle in any shipped pack, so `lifecycleStateGuard` never reaches it and
    // its state moves by a plain update. Before this lock confirmed → draft → confirmed posted the
    // clearing entry twice.
    const { store, compiled } = coverageServer();
    const cert = await store.create(COVERAGE_TENANT, "WhtCertificate", {
      certificate_number: "WHT-1",
      state: "draft",
      amount: 30,
      currency: "USD",
    });
    const id = String(cert["id"]);
    expect((await callOperation(compiled, "whtCertificate.update", { id }, { state: "confirmed" })).status).toBe(200);
    expect(await journalEntryCount(store)).toBe(1);

    const back = await callOperation(compiled, "whtCertificate.update", { id }, { state: "draft" });
    expect(back.status).toBe(422);
    expect(back.body["error"]).toBe("wht_certificate_locked");
    expect(back.body["detail"]).toContain("set its state to 'void' instead");
    expect(await journalEntryCount(store)).toBe(1);

    // The one move left open lands in a locked state and reverses the clearing — a void certificate
    // no longer evidences the credit — so it cannot be walked back, and posts once.
    expect((await callOperation(compiled, "whtCertificate.update", { id }, { state: "void" })).status).toBe(200);
    expect(await journalEntryCount(store)).toBe(2);
    const again = await callOperation(compiled, "whtCertificate.update", { id }, { state: "confirmed" });
    expect(again.body["error"]).toBe("wht_certificate_locked");
    expect(again.body["detail"]).toBe("a void WHT certificate cannot be edited");
    expect(await journalEntryCount(store)).toBe(2);
  });

  it("names a reversed entry's state and no impossible remedy, and a posted one's real remedy", async () => {
    const { store, compiled } = coverageServer();
    const posted = await store.create(COVERAGE_TENANT, "JournalEntry", { state: "posted", entry_number: "JE-P" });
    const reversed = await store.create(COVERAGE_TENANT, "JournalEntry", { state: "reversed", entry_number: "JE-R" });
    const p = await callOperation(compiled, "journalEntry.delete", { id: String(posted["id"]) }, null);
    expect(p.body["detail"]).toBe("a posted journal entry cannot be deleted; reverse it instead");
    const r = await callOperation(compiled, "journalEntry.delete", { id: String(reversed["id"]) }, null);
    expect(r.body["error"]).toBe("posted_entry_immutable");
    expect(r.body["detail"]).toBe("a reversed journal entry cannot be deleted");
    const line = await store.create(COVERAGE_TENANT, "JournalLine", { journal_entry_id: String(reversed["id"]), debit: 1, credit: 0 });
    const edited = await callOperation(compiled, "journalLine.update", { id: String(line["id"]) }, { debit: 2 });
    expect(edited.body["detail"]).toBe("cannot modify the lines of a reversed journal entry");
  });

  it("names a correction only from the states it fires from", async () => {
    // `void` fires from draft/sent/overdue, so a paid invoice's refusal used to name it anyway.
    const { store, compiled } = coverageServer();
    const sent = await seedInvoice(store, { state: "sent", total: 10 });
    const paid = await seedInvoice(store, { state: "paid", total: 10, paid: 10 });
    expect((await callOperation(compiled, "invoice.delete", { id: sent }, null)).body["detail"]).toBe(
      "an issued invoice cannot be deleted; void it instead",
    );
    expect((await callOperation(compiled, "invoice.delete", { id: paid }, null)).body["detail"]).toBe(
      "an issued invoice cannot be deleted",
    );
  });

  it("names the state a locked document is in, not the one its config was written for", async () => {
    // The noun was fixed per document, so a `submitted` purchase order — locked before approval — was
    // refused as "an approved purchase order", and an invoice voided straight from draft as "an issued
    // invoice": item 2's wrong-noun defect on the reversed journal entry, in two more documents.
    const { store, compiled } = coverageServer();
    const po = await store.create(COVERAGE_TENANT, "PurchaseOrder", { po_number: "PO-1", state: "submitted" });
    const poDeleted = await callOperation(compiled, "purchaseOrder.delete", { id: String(po["id"]) }, null);
    expect(poDeleted.body["error"]).toBe("purchase_order_locked");
    expect(String(poDeleted.body["detail"])).toMatch(/^a submitted purchase order cannot be deleted/);
    const voided = await seedInvoice(store, { state: "void", total: 10 });
    expect(String((await callOperation(compiled, "invoice.delete", { id: voided }, null)).body["detail"])).toMatch(
      /^a void invoice cannot be deleted/,
    );
  });
});

// ---------------------------------------------------------------------------
// A record with no stored state is in the lifecycle's initial state (C-03's latent half). The
// transition handler skipped its from-state check when the stored state was not a string, and the
// create guard admits an omitted state, so on a manifest whose state field is optional with no
// default a stateless record could fire any transition from anywhere. No shipped pack reaches it —
// all 137 resolved lifecycles have a required state field with a literal default — so this drives a
// synthetic manifest.
// ---------------------------------------------------------------------------

const STATELESS = {
  meta: { name: "stateless", version: "1.0.0" },
  entities: [
    {
      name: "Claim",
      fields: [
        { name: "title", type: { kind: "text" } },
        { name: "state", type: { kind: "enum", values: ["draft", "submitted", "approved"] } },
      ],
    },
  ],
  roles: { erp_admin: { name: "erp_admin" } },
  permissions: {
    Claim: {
      read: { roles: ["erp_admin"] },
      list: { roles: ["erp_admin"] },
      create: { roles: ["erp_admin"] },
      update: { roles: ["erp_admin"] },
      transitions: { submit: { roles: ["erp_admin"] }, approve: { roles: ["erp_admin"] } },
    },
  },
  workflows: {
    claim_lifecycle: {
      kind: "entityLifecycle",
      entity: "Claim",
      stateField: "state",
      initialState: "draft",
      states: [{ name: "draft" }, { name: "submitted" }, { name: "approved" }],
      transitions: [
        { name: "submit", from: ["draft"], to: "submitted", trigger: { kind: "userAction" } },
        { name: "approve", from: ["submitted"], to: "approved", trigger: { kind: "userAction" } },
      ],
    },
  },
};

describe("compileOperateServer — an unset lifecycle state is the initial state", () => {
  function statelessServer() {
    const store = new InMemoryEntityStore();
    const compiled = compileOperateServer(STATELESS as unknown as Manifest, {
      store,
      principalRoles: () => ({ primaryRole: "erp_admin" }),
    });
    return { store, compiled };
  }

  it("refuses skipping ahead from a record created with no state", async () => {
    const { store, compiled } = statelessServer();
    const created = await callOperation(compiled, "claim.create", {}, { title: "t" });
    expect(created.status).toBe(201);
    const id = String(created.body["id"]);
    expect((await store.get(COVERAGE_TENANT, "Claim", id))?.["state"]).toBeUndefined();

    const skipped = await callOperation(compiled, "claim.approve", { id }, null);
    expect(skipped.status).toBe(409);
    expect(skipped.body["detail"]).toBe("'approve' cannot fire from 'draft'");
    expect((await callOperation(compiled, "claim.submit", { id }, null)).status).toBe(200);
    expect((await callOperation(compiled, "claim.approve", { id }, null)).status).toBe(200);
  });

  it("refuses a stored state that is not a string, rather than reading it as any state", async () => {
    const { store, compiled } = statelessServer();
    const rec = await store.create(COVERAGE_TENANT, "Claim", { title: "t", state: 7 });
    const r = await callOperation(compiled, "claim.submit", { id: String(rec["id"]) }, null);
    expect(r.status).toBe(409);
    expect(r.body["detail"]).toContain("holds no state of this lifecycle");
  });

  it("admits an update re-sending the initial state to a record stored with none", async () => {
    // The update arm reads the unset stored state as `initialState` too, so the two agree.
    const { compiled } = statelessServer();
    const created = await callOperation(compiled, "claim.create", {}, { title: "t" });
    const id = String(created.body["id"]);
    expect((await callOperation(compiled, "claim.update", { id }, { state: "draft" })).status).toBe(200);
    expect((await callOperation(compiled, "claim.update", { id }, { state: "approved" })).status).toBe(422);
  });

  it("admits an ordinary edit of a record stored with no state", async () => {
    // The merged `after` carries no state either, so a guard reading only the stored side as
    // `initialState` refused this 422 — every edit of a stateless record, over a field it never named.
    const { compiled } = statelessServer();
    const created = await callOperation(compiled, "claim.create", {}, { title: "t" });
    const id = String(created.body["id"]);
    const edited = await callOperation(compiled, "claim.update", { id }, { title: "t2" });
    expect(edited.status).toBe(200);
    expect(edited.body["title"]).toBe("t2");
  });
});

describe("the withholding stamp is wired exactly where the document declares the field", () => {
  const CORE = buildErpCorePack();
  const withoutField = (entity: string): Manifest => ({
    ...CORE,
    entities: (CORE.entities ?? []).map((e) =>
      e.name === entity ? { ...e, fields: e.fields.filter((f) => f.name !== "withholding_total") } : e,
    ),
  });
  const stamped = (m: Manifest): readonly string[] =>
    defaultEffectStamps(m)
      .filter((s) => s.field === "withholding_total")
      .map((s) => s.entity)
      .sort();

  it("stamps both documents on erp-core, which declares the field on both", () => {
    expect(stamped(CORE)).toEqual(["Bill", "Invoice"]);
  });

  it("drops only the document that does not declare it", () => {
    // A stamp on an undeclared field is a JSONB key on `--store pg` and nothing on `--store
    // pg-columns`, so listing it would make the field read as a server fact it is not.
    expect(stamped(withoutField("Bill"))).toEqual(["Invoice"]);
    expect(stamped(withoutField("Invoice"))).toEqual(["Bill"]);
  });

  it("stamps no field an entity does not resolve to", () => {
    const entities = new Map((CORE.entities ?? []).map((e) => [e.name, e]));
    for (const s of defaultEffectStamps(CORE)) {
      const entity = entities.get(s.entity);
      expect(entity, s.entity).toBeDefined();
      const names = resolvedFields(entity!, CORE.traits ?? []).map((f) => f.name);
      expect(names, `${s.entity}.${s.field}`).toContain(s.field);
    }
  });
});

// ---- The tax remittance a TaxReturn posts on `mark_paid` (ADR-0467) -------------------------

const REMIT_CODES = { output: "2200", input: "1400", cash: "1000", wht: "2210" } as const;
type RemitRole = keyof typeof REMIT_CODES;
const JURISDICTION = "jur-1";

async function remittanceServer(
  opts: {
    readonly mode?: "manual_journal" | "on_mark_paid";
    readonly finance?: Partial<FinanceSettings>;
    readonly defaults?: OperationalDefaults;
    readonly manifest?: Manifest;
  } = {},
) {
  const store = new InMemoryEntityStore();
  const settingsStore = new InMemorySettingsStore();
  await settingsStore.put(COVERAGE_TENANT, {
    defaults: opts.defaults ?? { currency: "USD" },
    finance: {
      taxPayableAccountCode: REMIT_CODES.output,
      taxInputAccountCode: REMIT_CODES.input,
      cashAccountCode: REMIT_CODES.cash,
      whtPayableAccountCode: REMIT_CODES.wht,
      ...(opts.mode !== undefined ? { taxRemittancePosting: opts.mode } : {}),
      ...(opts.finance ?? {}),
    },
  });
  const compiled = compileOperateServer(opts.manifest ?? buildErpCorePack(), {
    store,
    settingsStore,
    principalRoles: () => ({ primaryRole: "erp_admin" }),
  });
  const accounts = {} as Record<RemitRole, string>;
  for (const role of Object.keys(REMIT_CODES) as RemitRole[]) {
    const a = await store.create(COVERAGE_TENANT, "LedgerAccount", { account_code: REMIT_CODES[role], name: role });
    accounts[role] = String(a["id"]);
  }
  await store.create(COVERAGE_TENANT, "TaxJurisdiction", { id: JURISDICTION, name: "Home" });
  // The tax the books already hold: 1000 of output tax and 300 of input tax, 200 withheld.
  const seed = await store.create(COVERAGE_TENANT, "JournalEntry", { entry_number: "SEED-1", state: "posted" });
  const seedLine = (account: string, debit: number, credit: number) =>
    store.create(COVERAGE_TENANT, "JournalLine", {
      journal_entry_id: String(seed["id"]),
      ledger_account_id: account,
      currency: "USD",
      debit,
      credit,
      functional_debit: debit,
      functional_credit: credit,
    });
  await seedLine(accounts.output, 0, 1000);
  await seedLine(accounts.input, 300, 0);
  await seedLine(accounts.wht, 0, 200);
  return { store, settingsStore, compiled, accounts };
}

async function seedReturn(store: InMemoryEntityStore, overrides: EntityRecord = {}): Promise<string> {
  const tr = await store.create(COVERAGE_TENANT, "TaxReturn", {
    return_number: "TR-1",
    state: "filed",
    return_type: "vat",
    jurisdiction_id: JURISDICTION,
    fiscal_period_id: "fp-1",
    period_start: "2026-01-01",
    period_end: "2026-03-31",
    output_tax: 1000,
    input_tax: 300,
    net_payable: 700,
    currency: "USD",
    ...overrides,
  });
  return String(tr["id"]);
}

async function all(store: InMemoryEntityStore, entity: string): Promise<readonly EntityRecord[]> {
  return (await store.listPage(COVERAGE_TENANT, entity, { limit: 500, cursor: null, sort: [], filters: [] })).records;
}

async function remittanceEntries(store: InMemoryEntityStore): Promise<readonly EntityRecord[]> {
  return (await all(store, "JournalEntry")).filter((e) => e["entry_number"] !== "SEED-1");
}

/** An entry's lines as `role side amount`, in posting order, with the functional amounts asserted equal. */
async function legsOf(
  store: InMemoryEntityStore,
  entryId: string,
  accounts: Record<RemitRole, string>,
): Promise<string[]> {
  const byId = new Map(Object.entries(accounts).map(([role, id]) => [id, role]));
  const lines = (await all(store, "JournalLine")).filter((l) => l["journal_entry_id"] === entryId);
  return lines.map((l) => {
    expect(Number(l["functional_debit"])).toBe(Number(l["debit"]));
    expect(Number(l["functional_credit"])).toBe(Number(l["credit"]));
    expect(Number(l["fx_rate"])).toBe(1);
    expect(l["currency"]).toBe("USD");
    const d = Number(l["debit"]);
    const c = Number(l["credit"]);
    return `${byId.get(String(l["ledger_account_id"])) ?? "?"} ${d > 0 ? `Dr ${d}` : `Cr ${c}`}`;
  });
}

describe("compileOperateServer — a tax return's remittance (ADR-0467)", () => {
  it("is wired for erp-core, whose TaxReturn carries every field and stamp the posting needs", () => {
    const wiring = taxRemittanceWiring(buildErpCorePack());
    expect(wiring).toEqual({ entity: "TaxReturn", stateField: "state", reverseTransition: "reverse_payment" });
    // `reverse_payment` undoes a recorded fact rather than committing the business to one, so it is
    // not approve-class: the person who marked the return paid in error may be the one who undoes it.
    expect(isApproveClassTransition("TaxReturn", "reverse_payment")).toBe(false);
    expect(isApproveClassTransition("TaxReturn", "mark_paid")).toBe(true);
  });

  it("posts nothing in manual_journal mode even with a settings store and every account set", async () => {
    const { store, compiled } = await remittanceServer({ mode: "manual_journal" });
    const id = await seedReturn(store);
    const r = await callOperation(compiled, "taxReturn.mark_paid", { id }, null);
    expect(r.status).toBe(200);
    expect(await remittanceEntries(store)).toEqual([]);
    expect((await store.get(COVERAGE_TENANT, "TaxReturn", id))?.["remitted_at"]).toBeUndefined();
  });

  it("posts a VAT return's remittance and stamps the return in on_mark_paid mode", async () => {
    const { store, compiled, accounts } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store);
    const r = await callOperation(compiled, "taxReturn.mark_paid", { id }, null);
    expect(r.status).toBe(200);
    const entries = await remittanceEntries(store);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry["entry_number"]).toBe("TR-1-REMIT-1");
    expect(entry["source"]).toBe("system");
    expect(entry["state"]).toBe("posted");
    // JournalEntry declares no currency: a header key the manifest does not declare is kept by the
    // document store and dropped by the column store, so it would differ between them.
    const declared = new Set(
      resolvedFields((buildErpCorePack().entities ?? []).find((e) => e.name === "JournalEntry")!, []).map((f) => f.name),
    );
    for (const key of Object.keys(entry)) {
      if (key === "id") continue;
      expect(declared.has(key), `JournalEntry.${key} is declared`).toBe(true);
    }
    expect(await legsOf(store, String(entry["id"]), accounts)).toEqual(["output Dr 1000", "input Cr 300", "cash Cr 700"]);
    const after = await store.get(COVERAGE_TENANT, "TaxReturn", id);
    expect(after?.["state"]).toBe("paid");
    expect(typeof after?.["remitted_at"]).toBe("string");
    expect(after?.["remittance_entry_number"]).toBe("TR-1-REMIT-1");
    expect(Number(after?.["remittance_count"])).toBe(1);
  });

  it.each([
    [
      "a refund received",
      { output_tax: 100, input_tax: 300, net_payable: -200, credit_disposition: "refund_received" },
      ["output Dr 100", "cash Dr 200", "input Cr 300"],
    ],
    [
      "a credit carried forward",
      { output_tax: 100, input_tax: 300, net_payable: -200, credit_disposition: "carried_forward" },
      ["output Dr 100", "input Cr 100"],
    ],
    ["a sales-tax return", { return_type: "sales_tax", output_tax: 500, input_tax: 0, net_payable: 500 }, ["output Dr 500", "cash Cr 500"]],
    [
      "a withholding return",
      { return_type: "withholding", output_tax: 0, input_tax: 0, net_payable: 150 },
      ["wht Dr 150", "cash Cr 150"],
    ],
  ])("posts %s", async (_name, figures, legs) => {
    const { store, compiled, accounts } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store, figures);
    const r = await callOperation(compiled, "taxReturn.mark_paid", { id }, null);
    expect(r.status).toBe(200);
    const [entry] = await remittanceEntries(store);
    expect(await legsOf(store, String(entry!["id"]), accounts)).toEqual(legs);
  });

  it("stamps a nil return without posting an entry, and reverses it without one", async () => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store, { output_tax: 0, input_tax: 0, net_payable: 0 });
    expect((await callOperation(compiled, "taxReturn.mark_paid", { id }, null)).status).toBe(200);
    expect(await remittanceEntries(store)).toEqual([]);
    const paid = await store.get(COVERAGE_TENANT, "TaxReturn", id);
    expect(typeof paid?.["remitted_at"]).toBe("string");
    expect(paid?.["remittance_entry_number"] ?? null).toBeNull();
    expect(paid?.["remittance_count"]).toBeUndefined();
    expect((await callOperation(compiled, "taxReturn.reverse_payment", { id }, null)).status).toBe(200);
    expect(await remittanceEntries(store)).toEqual([]);
    // A cleared stamp reads back absent: a null field is absent on every store (ADR-0443).
    expect((await store.get(COVERAGE_TENANT, "TaxReturn", id))?.["remitted_at"] ?? null).toBeNull();
  });

  it("reverses the remittance with reverse_payment and numbers the next one -REMIT-2", async () => {
    const { store, compiled, accounts } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store);
    expect((await callOperation(compiled, "taxReturn.mark_paid", { id }, null)).status).toBe(200);
    expect((await callOperation(compiled, "taxReturn.reverse_payment", { id }, null)).status).toBe(200);
    const byNumber = new Map((await remittanceEntries(store)).map((e) => [String(e["entry_number"]), e]));
    expect([...byNumber.keys()].sort()).toEqual(["TR-1-REMIT-1", "TR-1-REMIT-1-REV"]);
    expect(byNumber.get("TR-1-REMIT-1")?.["state"]).toBe("reversed");
    expect(await legsOf(store, String(byNumber.get("TR-1-REMIT-1-REV")!["id"]), accounts)).toEqual([
      "output Cr 1000",
      "input Dr 300",
      "cash Dr 700",
    ]);
    const filed = await store.get(COVERAGE_TENANT, "TaxReturn", id);
    expect(filed?.["state"]).toBe("filed");
    expect(filed?.["remitted_at"] ?? null).toBeNull();
    // The number names the current payment's entry and goes with it; the count stays, so the next
    // payment cannot reuse the reversed entry's number.
    expect(filed?.["remittance_entry_number"] ?? null).toBeNull();
    expect(Number(filed?.["remittance_count"])).toBe(1);

    expect((await callOperation(compiled, "taxReturn.mark_paid", { id }, null)).status).toBe(200);
    const again = await store.get(COVERAGE_TENANT, "TaxReturn", id);
    expect(again?.["remittance_entry_number"]).toBe("TR-1-REMIT-2");
    expect(Number(again?.["remittance_count"])).toBe(2);
    expect((await remittanceEntries(store)).map((e) => e["entry_number"]).sort()).toEqual([
      "TR-1-REMIT-1",
      "TR-1-REMIT-1-REV",
      "TR-1-REMIT-2",
    ]);
  });

  it("never strands a return in paid: a nil re-payment after a reversal can be reversed again", async () => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store);
    for (const op of ["mark_paid", "reverse_payment", "amend"]) {
      expect((await callOperation(compiled, `taxReturn.${op}`, { id }, null)).status, op).toBe(200);
    }
    const nil = await callOperation(compiled, "taxReturn.update", { id }, { output_tax: 0, input_tax: 0, net_payable: 0 });
    expect(nil.status).toBe(200);
    for (const op of ["refile", "mark_paid"]) {
      expect((await callOperation(compiled, `taxReturn.${op}`, { id }, null)).status, op).toBe(200);
    }
    expect((await store.get(COVERAGE_TENANT, "TaxReturn", id))?.["remittance_entry_number"] ?? null).toBeNull();
    const reversed = await callOperation(compiled, "taxReturn.reverse_payment", { id }, null);
    expect(reversed.status).toBe(200);
    expect((await store.get(COVERAGE_TENANT, "TaxReturn", id))?.["state"]).toBe("filed");
  });

  it("never strands a return in paid: a manual-mode re-payment after a reversal can be reversed again", async () => {
    const { store, settingsStore, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store);
    for (const op of ["mark_paid", "reverse_payment"]) {
      expect((await callOperation(compiled, `taxReturn.${op}`, { id }, null)).status, op).toBe(200);
    }
    const settings = await settingsStore.get(COVERAGE_TENANT);
    await settingsStore.put(COVERAGE_TENANT, { ...settings, finance: { ...settings.finance, taxRemittancePosting: "manual_journal" } });
    expect((await callOperation(compiled, "taxReturn.mark_paid", { id }, null)).status).toBe(200);
    const reversed = await callOperation(compiled, "taxReturn.reverse_payment", { id }, null);
    expect(reversed.status).toBe(200);
    expect((await store.get(COVERAGE_TENANT, "TaxReturn", id))?.["state"]).toBe("filed");
  });

  it("refuses reverse_payment, in on_mark_paid mode, on a return paid with nothing posted here", async () => {
    // Paid before the upgrade or in manual_journal mode: a manual journal remitted it, so a reversal
    // here undoes nothing and the next mark_paid would post the same period a second time.
    const { store, settingsStore, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store, { state: "paid" });
    const refused = await callOperation(compiled, "taxReturn.reverse_payment", { id }, null);
    expect(refused.status).toBe(409);
    expect(refused.body["error"]).toBe("tax_remittance_paid_outside_posting");
    expect((await store.get(COVERAGE_TENANT, "TaxReturn", id))?.["state"]).toBe("paid");
    expect(await remittanceEntries(store)).toEqual([]);
    // The named remedy works: in manual_journal mode the return reverses.
    const settings = await settingsStore.get(COVERAGE_TENANT);
    await settingsStore.put(COVERAGE_TENANT, { ...settings, finance: { ...settings.finance, taxRemittancePosting: "manual_journal" } });
    expect((await callOperation(compiled, "taxReturn.reverse_payment", { id }, null)).status).toBe(200);
  });

  it("refuses reversing a remittance's reversal, which would re-apply it with the return reading filed", async () => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store);
    for (const op of ["mark_paid", "reverse_payment"]) {
      expect((await callOperation(compiled, `taxReturn.${op}`, { id }, null)).status, op).toBe(200);
    }
    const rev = (await remittanceEntries(store)).find((e) => e["entry_number"] === "TR-1-REMIT-1-REV")!;
    const refused = await callOperation(compiled, "journalEntry.reverse", { id: String(rev["id"]) }, null);
    expect(refused.status).toBe(409);
    expect(refused.body["error"]).toBe("tax_remittance_reinstate_via_return");
    expect((await remittanceEntries(store)).map((e) => e["entry_number"]).sort()).toEqual([
      "TR-1-REMIT-1",
      "TR-1-REMIT-1-REV",
    ]);
    // Control: a -REV entry whose prefix names no tax return is an ordinary reversal.
    const other = await store.create(COVERAGE_TENANT, "JournalEntry", { entry_number: "TR-9-REMIT-1-REV", state: "posted" });
    expect((await callOperation(compiled, "journalEntry.reverse", { id: String(other["id"]) }, null)).status).toBe(200);
  });

  it("refuses reverse_payment when the remittance entry was already reversed elsewhere", async () => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store);
    expect((await callOperation(compiled, "taxReturn.mark_paid", { id }, null)).status).toBe(200);
    const [entry] = await remittanceEntries(store);
    await store.update(COVERAGE_TENANT, "JournalEntry", String(entry!["id"]), { state: "reversed" });
    const r = await callOperation(compiled, "taxReturn.reverse_payment", { id }, null);
    expect(r.status).toBe(409);
    expect(r.body["error"]).toBe("tax_remittance_already_reversed");
    expect((await store.get(COVERAGE_TENANT, "TaxReturn", id))?.["state"]).toBe("paid");
  });

  it("refuses reversing a paid return's remittance entry directly, and allows it once the return is not paid", async () => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store);
    expect((await callOperation(compiled, "taxReturn.mark_paid", { id }, null)).status).toBe(200);
    const [entry] = await remittanceEntries(store);
    const entryId = String(entry!["id"]);
    const refused = await callOperation(compiled, "journalEntry.reverse", { id: entryId }, null);
    expect(refused.status).toBe(409);
    expect(refused.body["error"]).toBe("tax_remittance_reverse_via_return");
    expect((await store.get(COVERAGE_TENANT, "JournalEntry", entryId))?.["state"]).toBe("posted");
    await store.update(COVERAGE_TENANT, "TaxReturn", id, { state: "filed" });
    const allowed = await callOperation(compiled, "journalEntry.reverse", { id: entryId }, null);
    expect(allowed.status).toBe(200);
  });

  it("names a paid return and its correction when an edit is refused", async () => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    const id = await seedReturn(store);
    expect((await callOperation(compiled, "taxReturn.mark_paid", { id }, null)).status).toBe(200);
    const r = await callOperation(compiled, "taxReturn.update", { id }, { output_tax: 900 });
    expect(r.status).toBe(422);
    expect(r.body["error"]).toBe("tax_return_locked");
    expect(r.body["detail"]).toContain("paid tax return");
    expect(r.body["detail"]).toContain("reverse the payment instead");
  });

  it("refuses a return whose declaration cannot post when it is filed, but only in on_mark_paid mode", async () => {
    for (const [mode, status] of [["on_mark_paid", 422], ["manual_journal", 200]] as const) {
      const { store, compiled } = await remittanceServer({ mode });
      const id = await seedReturn(store, { state: "ready", net_payable: 650 });
      const r = await callOperation(compiled, "taxReturn.file", { id }, null);
      expect(r.status, mode).toBe(status);
      if (status === 422) expect(r.body["error"]).toBe("tax_return_figures_disagree");
    }
  });

  it.each<[string, Parameters<typeof remittanceServer>[0], EntityRecord, string, number]>([
    ["figures that disagree", {}, { net_payable: 650 }, "tax_return_figures_disagree", 422],
    ["no functional currency", { defaults: {} }, {}, "functional_currency_undeclared", 409],
    ["a foreign-currency return", {}, { currency: "EUR" }, "tax_return_currency_not_functional", 409],
    ["an unset cash account", { finance: { cashAccountCode: "" } }, {}, "tax_remittance_account_unresolved", 409],
    ["tax routed by jurisdiction", { finance: { taxAccountsByJurisdiction: { home: "2201" } } }, {}, "tax_remittance_routing_unsupported", 409],
    ["more output tax than the books hold", {}, { output_tax: 2000, net_payable: 1700 }, "tax_remittance_exceeds_ledger", 409],
  ])("refuses %s and writes nothing", async (_name, server, figures, code, status) => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid", ...server });
    const id = await seedReturn(store, figures);
    const r = await callOperation(compiled, "taxReturn.mark_paid", { id }, null);
    expect(r.status).toBe(status);
    expect(r.body["error"]).toBe(code);
    expect(await remittanceEntries(store)).toEqual([]);
    const after = await store.get(COVERAGE_TENANT, "TaxReturn", id);
    expect(after?.["state"]).toBe("filed");
    expect(after?.["remitted_at"]).toBeUndefined();
  });

  it("names the setting an unresolved account comes from, and nothing the record carries", async () => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid", finance: { cashAccountCode: "9999" } });
    const id = await seedReturn(store);
    const r = await callOperation(compiled, "taxReturn.mark_paid", { id }, null);
    expect(r.body["detail"]).toBe(
      `${TAX_REMITTANCE_REFUSALS.tax_remittance_account_unresolved.detail}: set finance.cashAccountCode`,
    );
  });

  it("refuses when a tax code routes tax to an account of its own", async () => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    await store.create(COVERAGE_TENANT, "TaxCode", { code: "VAT20", kind: "standard", gl_account_code: "2299" });
    const id = await seedReturn(store);
    const r = await callOperation(compiled, "taxReturn.mark_paid", { id }, null);
    expect(r.status).toBe(409);
    expect(r.body["error"]).toBe("tax_remittance_routing_unsupported");
    expect(await remittanceEntries(store)).toEqual([]);
  });

  it("refuses a second return of the same type and jurisdiction whose period overlaps a paid one", async () => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    await seedReturn(store, { return_number: "TR-0", state: "paid", period_start: "2026-03-01", period_end: "2026-05-31" });
    const id = await seedReturn(store);
    const r = await callOperation(compiled, "taxReturn.mark_paid", { id }, null);
    expect(r.status).toBe(409);
    expect(r.body["error"]).toBe("tax_return_period_overlaps");
    // A return of another type holds its own period, so the same months are not an overlap.
    const other = await seedReturn(store, { return_number: "TR-2", return_type: "withholding", output_tax: 0, input_tax: 0, net_payable: 10 });
    expect((await callOperation(compiled, "taxReturn.mark_paid", { id: other }, null)).status).toBe(200);
  });

  it("refuses when a journal entry already carries the next remittance number", async () => {
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid" });
    await store.create(COVERAGE_TENANT, "JournalEntry", { entry_number: "TR-1-REMIT-1", state: "posted" });
    const id = await seedReturn(store);
    const r = await callOperation(compiled, "taxReturn.mark_paid", { id }, null);
    expect(r.status).toBe(409);
    expect(r.body["error"]).toBe("tax_remittance_number_taken");
  });

  it("is not wired, posts nothing and stamps nothing for a manifest whose TaxReturn lacks a stamp field", async () => {
    const core = buildErpCorePack();
    const manifest: Manifest = {
      ...core,
      entities: (core.entities ?? []).map((e) =>
        e.name === "TaxReturn" ? { ...e, fields: e.fields.filter((f) => f.name !== "remitted_at") } : e,
      ),
    };
    expect(taxRemittanceWiring(manifest)).toBeNull();
    expect(defaultEffectStamps(manifest).filter((s) => s.entity === "TaxReturn")).toEqual([]);
    const { store, compiled } = await remittanceServer({ mode: "on_mark_paid", manifest });
    const id = await seedReturn(store, { net_payable: 650 });
    expect((await callOperation(compiled, "taxReturn.mark_paid", { id }, null)).status).toBe(200);
    expect(await remittanceEntries(store)).toEqual([]);
  });
});
