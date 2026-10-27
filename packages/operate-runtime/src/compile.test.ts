import { readFileSync } from "node:fs";

import type { IncomingRequest, ResolvedPrincipal } from "@crossengin/api-gateway";
import {
  InMemoryPrincipalResolver,
  buildIncomingRequest,
  type OpaqueTokenLookup,
} from "@crossengin/api-gateway-runtime";
import { resolvedClassifiedFields } from "@crossengin/kernel/ddl";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { buildOperateGateway, compileOperateServer } from "./compile.js";
import { InMemoryEntityStore } from "./store.js";
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
      initial: "registered",
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

    // Options this function deliberately does not hand on, each with the reason it does not.
    const notForwarded: Readonly<Record<string, string>> = Object.freeze({
      // Consumed by the compile step itself rather than passed to the runtime.
      store: "the compiler builds handlers over it; the runtime never sees a store",
      allocator: "same: a handler dependency, not a runtime option",
      settingsStore: "same",
      operationsForEntity: "read by the redaction registry the compiler builds",
      sensitiveFieldPolicy: "same",
      abac: "same",
      manifestRoleDirectory: "same",
    });

    const dropped = accepted.filter(
      (f) => !new RegExp(`\\b${f}\\b`).test(literal) && !(f in notForwarded),
    );
    expect(
      dropped,
      `these options reach buildOperateGateway and are not forwarded to GatewayRuntime; either ` +
        `forward them or declare why in notForwarded above`,
    ).toEqual([]);
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
