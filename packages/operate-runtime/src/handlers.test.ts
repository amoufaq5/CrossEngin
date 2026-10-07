import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import type {
  AbacEvaluationInput,
  AbacEvaluator,
  AbacOutcome,
  PermissionMap,
  RoleDefinition,
  RoleName,
} from "@crossengin/auth";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { beforeEach, describe, expect, it } from "vitest";

import { compileOperateServer, type CompiledOperateServer } from "./compile.js";
import { buildSpecHandler, type HandlerContext } from "./handlers.js";
import { manifestRouteSpecs, routeFromSpec } from "./operations.js";
import { InMemoryEntityStore } from "./store.js";
import { buildValidationPlans } from "./validation.js";
import { buildClassifiedFieldIndex } from "./write-mask.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const resolved = await resolveManifest(buildErpRetailPack(), { registry });

const principalRoles = (p: ResolvedPrincipal | null) => ({
  primaryRole: p?.grantedScopes[0] ?? "anonymous",
});

function principal(role: string | null): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    // Resolved-but-empty, which is the shape a deployment with an attribute directory produces for
    // a member carrying none. Since ADR-0341 an *absent* record refuses an obligation before any
    // evaluator runs, so a fixture without this would make every policy test below pass for the
    // wrong reason; the absent case is pinned on its own below.
    abacAttributes: {},
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

let server: CompiledOperateServer;
beforeEach(() => {
  server = compileOperateServer(resolved, { store: new InMemoryEntityStore(), principalRoles });
});

async function invoke(
  opId: string,
  opts: { role: string | null; params?: Record<string, string>; body?: Record<string, unknown> },
): Promise<HandlerOutput> {
  const spec = server.routeSpecs.find((s) => s.operationId === opId);
  if (spec === undefined) throw new Error(`no route for ${opId}`);
  const handler = server.handlers.resolve(opId)!;
  const request = buildIncomingRequest({
    id: "req_op000000001",
    receivedAt: "2026-06-03T12:00:00.000Z",
    method: spec.method,
    path: "/v1/x",
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
  });
  return handler({
    request,
    route: routeFromSpec(spec),
    principal: principal(opts.role),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  });
}

function bodyOf(out: HandlerOutput): Record<string, unknown> {
  if (out.kind !== "json") throw new Error("expected json output");
  return out.body as Record<string, unknown>;
}

describe("operate handlers — RBAC", () => {
  it("rejects an anonymous request with 401", async () => {
    expect((await invoke("product.list", { role: null })).status).toBe(401);
  });

  it("403s a cashier creating a product (create is managers-only)", async () => {
    const out = await invoke("product.create", { role: "cashier", body: { sku: "X" } });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["error"]).toBe("forbidden");
  });

  it("lets a store manager create a product", async () => {
    const out = await invoke("product.create", {
      role: "store_manager",
      body: { sku: "SKU-1", name: "Milk", unit_price: 2, unit_cost: 1, status: "active", category: "grocery" },
    });
    expect(out.status).toBe(201);
    expect(typeof bodyOf(out)["id"]).toBe("string");
  });
});

describe("operate handlers — CRUD", () => {
  it("creates, reads, lists, updates, deletes a product", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "S1", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;

    expect((await invoke("product.read", { role: "retail_admin", params: { id } })).status).toBe(200);

    const list = bodyOf(await invoke("product.list", { role: "retail_admin" }));
    expect((list["data"] as unknown[]).length).toBe(1);

    const updated = bodyOf(await invoke("product.update", { role: "retail_admin", params: { id }, body: { name: "B" } }));
    expect(updated["name"]).toBe("B");

    expect((await invoke("product.delete", { role: "retail_admin", params: { id } })).status).toBe(204);
    expect((await invoke("product.read", { role: "retail_admin", params: { id } })).status).toBe(404);
  });

  it("stamps created_at + updated_at on create and bumps updated_at on update", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "TS", name: "A", unit_price: 1, unit_cost: 1 } }));
    expect(typeof created["created_at"]).toBe("string");
    expect(created["updated_at"]).toBe(created["created_at"]);
    const id = created["id"] as string;
    const updated = bodyOf(await invoke("product.update", { role: "retail_admin", params: { id }, body: { name: "B" } }));
    expect(updated["created_at"]).toBe(created["created_at"]);
    expect(typeof updated["updated_at"]).toBe("string");
  });

  it("404s reading a missing record", async () => {
    expect((await invoke("product.read", { role: "retail_admin", params: { id: "nope" } })).status).toBe(404);
  });

  it("optimistic concurrency: a matching expectedUpdatedAt updates; a stale one 409s", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "OC", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;
    const version = created["updated_at"] as string;

    // Stale token → 409 conflict, record untouched.
    const stale = await invoke("product.update", {
      role: "retail_admin",
      params: { id },
      body: { name: "B", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(stale.status).toBe(409);
    expect(bodyOf(stale)["error"]).toBe("conflict");
    expect((bodyOf(await invoke("product.read", { role: "retail_admin", params: { id } })))["name"]).toBe("A");

    // Matching token → update succeeds, and the token field is never stored.
    const ok = await invoke("product.update", {
      role: "retail_admin",
      params: { id },
      body: { name: "B", expectedUpdatedAt: version },
    });
    expect(ok.status).toBe(200);
    expect(bodyOf(ok)["name"]).toBe("B");
    expect(bodyOf(ok)).not.toHaveProperty("expectedUpdatedAt");
  });

  it("update without expectedUpdatedAt is unconditional (backward compatible)", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "UN", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;
    const out = await invoke("product.update", { role: "retail_admin", params: { id }, body: { name: "B" } });
    expect(out.status).toBe(200);
    expect(bodyOf(out)["name"]).toBe("B");
  });

  it("a conditional update on a missing record 404s", async () => {
    const out = await invoke("product.update", {
      role: "retail_admin",
      params: { id: "nope" },
      body: { name: "B", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(out.status).toBe(404);
  });

  it("422s a create missing a required field (unit_price/unit_cost)", async () => {
    const out = await invoke("product.create", { role: "retail_admin", body: { sku: "V1", name: "A" } });
    expect(out.status).toBe(422);
    const fields = bodyOf(out)["fields"] as Array<{ field: string; code: string }>;
    expect(fields.map((f) => f.field).sort()).toEqual(["unit_cost", "unit_price"]);
  });

  it("422s a create with an invalid enum value", async () => {
    const out = await invoke("product.create", {
      role: "retail_admin",
      body: { sku: "V2", name: "A", unit_price: 1, unit_cost: 1, status: "bogus" },
    });
    expect(out.status).toBe(422);
    expect((bodyOf(out)["fields"] as Array<{ code: string }>)[0]?.code).toBe("enum");
  });

  it("422s an update that empties a required field", async () => {
    const created = bodyOf(await invoke("product.create", { role: "retail_admin", body: { sku: "V3", name: "A", unit_price: 1, unit_cost: 1 } }));
    const id = created["id"] as string;
    const out = await invoke("product.update", { role: "retail_admin", params: { id }, body: { name: "" } });
    expect(out.status).toBe(422);
  });
});

describe("operate handlers — lifecycle transitions", () => {
  it("advances a sales order cart -> placed and rejects an invalid transition", async () => {
    const order = bodyOf(
      await invoke("salesOrder.create", {
        role: "store_manager",
        body: { store_id: "st1", order_number: "SO-1", state: "cart", channel: "in_store", currency: "USD", total: 0 },
      }),
    );
    const id = order["id"] as string;

    const placed = bodyOf(await invoke("salesOrder.place", { role: "store_manager", params: { id } }));
    expect(placed["state"]).toBe("placed");

    // place again: now in 'placed', not in the transition's fromStates ('cart')
    const again = await invoke("salesOrder.place", { role: "store_manager", params: { id } });
    expect(again.status).toBe(409);
  });
});

describe("operate handlers — transactional effects", () => {
  it("rolls back the primary write when a post-write effect fails (transactional store)", async () => {
    const store = new InMemoryEntityStore();
    const failing = compileOperateServer(resolved, {
      store,
      principalRoles,
      writeEffects: [
        async () => {
          throw new Error("effect boom");
        },
      ],
    });
    const spec = failing.routeSpecs.find((s) => s.operationId === "product.create")!;
    const out = await failing.handlers.resolve("product.create")!({
      request: buildIncomingRequest({
        id: "req_tx0000000001",
        receivedAt: "2026-06-03T12:00:00.000Z",
        method: spec.method,
        path: "/v1/x",
        headers: {},
        host: "api.example.com",
        scheme: "https",
        bodyBytes: null,
        clientIp: "203.0.113.1",
      }),
      route: routeFromSpec(spec),
      principal: principal("retail_admin"),
      params: {},
      parsedBody: { sku: "ROLL", name: "RolledBack", unit_price: 1, unit_cost: 1 },
    });
    expect(out.status).toBe(500);
    // The create was rolled back: nothing persisted for Product.
    expect((await store.list(TENANT, "Product")).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Field-level write authorization (the write mask).
//
// `validateClassifiedWriteMask` was implemented, per-class aware and tested, and called by
// nothing on the request path — so a role that could not *read* a field could silently
// *overwrite* it. Two reproductions on a real cluster: a `front_desk` POST wrote a PHI `mrn` it
// could never read back, and a `case_worker` PATCH rewrote `Citizen.national_id`, which
// `erp-government` declares `regulated` with `update: {roles: ["gov_admin"]}` — a pack author's
// explicit restriction on a national identifier, ignored.
// ---------------------------------------------------------------------------

const WARD = {
  meta: { name: "ward", version: "1.0.0" },
  entities: [
    {
      name: "Patient",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        // required + pii + NO update grant: the 12-field case. Under `explicit_only` every role
        // that may create a Patient must be able to write it, or the entity is uncreatable.
        { name: "family_name", type: { kind: "text", maxLength: 100 }, required: true, classification: "pii" },
        // phi + an explicit update grant: the 7-field case this mode exists for.
        { name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" },
        // pii, no grant: refused only under `classified`.
        { name: "given_name", type: { kind: "text", maxLength: 100 }, classification: "pii" },
        // pii + an explicit grant + a literal default: the server fills it, which must not refuse.
        { name: "sex", type: { kind: "text", maxLength: 10 }, classification: "pii", default: { kind: "literal", value: "unknown" } },
        // unclassified + an explicit grant: an ordinary field under a deliberate restriction.
        { name: "nickname", type: { kind: "text", maxLength: 40 } },
        { name: "status", type: { kind: "text", maxLength: 20 }, default: { kind: "literal", value: "registered" } },
      ],
    },
    {
      // The lifecycle state field is itself classified *and* grant-restricted, so a transition
      // would be refused for everyone if the mask ran on the server-chosen patch.
      name: "Episode",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "phase", type: { kind: "text", maxLength: 20 }, classification: "pii", default: { kind: "literal", value: "open" } },
      ],
    },
  ],
  workflows: {
    patient_lifecycle: {
      kind: "entityLifecycle",
      entity: "Patient",
      stateField: "status",
      initial: "registered",
      transitions: [{ name: "admit", from: "registered", to: "admitted" }],
    },
    episode_lifecycle: {
      kind: "entityLifecycle",
      entity: "Episode",
      stateField: "phase",
      initial: "open",
      transitions: [{ name: "close", from: "open", to: "closed" }],
    },
  },
  roles: { clerk: { name: "clerk" }, clinician: { name: "clinician" }, compliance: { name: "compliance" } },
  permissions: {
    Patient: {
      list: { roles: ["clerk", "clinician", "compliance"] },
      read: { roles: ["clerk", "clinician", "compliance"] },
      create: { roles: ["clerk", "clinician", "compliance"] },
      update: { roles: ["clerk", "clinician", "compliance"] },
      delete: { roles: ["clinician"] },
      transitions: { admit: { roles: ["clerk", "clinician"] } },
      fields: {
        mrn: { read: { roles: ["clinician"] }, update: { roles: ["clinician"] } },
        sex: { update: { roles: ["clinician"] } },
        nickname: { update: { roles: ["clinician"] } },
        given_name: { read: { roles: ["clinician"] } },
      },
    },
    Episode: {
      list: { roles: ["clerk", "clinician"] },
      read: { roles: ["clerk", "clinician"] },
      create: { roles: ["clerk", "clinician"] },
      update: { roles: ["clerk", "clinician"] },
      delete: { roles: ["clinician"] },
      transitions: { close: { roles: ["clerk", "clinician"] } },
      fields: { phase: { update: { roles: ["clinician"] } } },
    },
  },
} as unknown as Manifest;

function wardServer(options: Partial<Parameters<typeof compileOperateServer>[1]> = {}): CompiledOperateServer {
  return compileOperateServer(WARD, {
    store: new InMemoryEntityStore(),
    principalRoles,
    ...options,
  });
}

async function call(
  srv: CompiledOperateServer,
  opId: string,
  opts: { role: string; params?: Record<string, string>; body?: Record<string, unknown> },
): Promise<HandlerOutput> {
  const spec = srv.routeSpecs.find((s) => s.operationId === opId);
  if (spec === undefined) throw new Error(`no route for ${opId}`);
  return srv.handlers.resolve(opId)!({
    request: buildIncomingRequest({
      id: "req_wm0000000001",
      receivedAt: "2026-06-03T12:00:00.000Z",
      method: spec.method,
      path: "/v1/x",
      headers: {},
      host: "api.example.com",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.1",
    }),
    route: routeFromSpec(spec),
    principal: principal(opts.role),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  });
}

describe("operate handlers — write mask (explicit_only, the default)", () => {
  it("403s a create naming a field whose declared update grant the role lacks", async () => {
    const out = await call(wardServer(), "patient.create", {
      role: "clerk",
      body: { family_name: "Lovelace", mrn: "MRN-WRITTEN-BY-CLERK" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["error"]).toBe("forbidden");
    expect(bodyOf(out)["field"]).toBe("mrn");
    expect(bodyOf(out)["rule"]).toBe("explicit_update_grant");
  });

  it("403s an update naming it — the blind PATCH overwrite of PHI the role cannot read", async () => {
    const srv = wardServer();
    const created = bodyOf(
      await call(srv, "patient.create", { role: "clinician", body: { family_name: "Hopper", mrn: "MRN-1" } }),
    );
    const id = created["id"] as string;
    const out = await call(srv, "patient.update", {
      role: "clerk",
      params: { id },
      body: { mrn: "MRN-SILENTLY-REPLACED" },
    });
    expect(out.status).toBe(403);
    // …and the stored value is untouched.
    const read = bodyOf(await call(srv, "patient.read", { role: "clinician", params: { id } }));
    expect(read["mrn"]).toBe("MRN-1");
  });

  it("permits the granted role on both create and update", async () => {
    const srv = wardServer();
    const created = await call(srv, "patient.create", {
      role: "clinician",
      body: { family_name: "Noether", mrn: "MRN-2" },
    });
    expect(created.status).toBe(201);
    const id = bodyOf(created)["id"] as string;
    const updated = await call(srv, "patient.update", { role: "clinician", params: { id }, body: { mrn: "MRN-3" } });
    expect(updated.status).toBe(200);
    expect(bodyOf(updated)["mrn"]).toBe("MRN-3");
  });

  it("permits a sensitive field with no update grant — which is what keeps required ones writable", async () => {
    // `family_name` is pii, `required: true` and governed only by the classification default. 12 of
    // the 46 sensitive fields across the packs are in exactly this position (`Patient.mrn`,
    // `Lead.full_name`, `Opportunity.amount`, `Permit.fee_amount`, …), so a mask that refused them
    // would make seven entities uncreatable in every deployment. Asserted explicitly so nobody
    // "tightens" the default mode: the symmetric rule is the separate, opt-in `classified` mode.
    const out = await call(wardServer(), "patient.create", {
      role: "clerk",
      body: { family_name: "Lovelace", given_name: "Ada" },
    });
    expect(out.status).toBe(201);
    expect(bodyOf(out)["given_name"]).toBe("Ada");
  });

  it("enforces a declared grant on an unclassified field too", async () => {
    const out = await call(wardServer(), "patient.create", {
      role: "clerk",
      body: { family_name: "Lovelace", nickname: "Addy" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["field"]).toBe("nickname");
  });

  it("does not mask a server-filled default on a classified, grant-restricted field", async () => {
    // `sex` is pii with `update: {roles: ["clinician"]}` and a literal default. A clerk that never
    // names it must still be able to create: the mask runs on the caller's keys, before
    // applySettingsDefaults / applyLiteralDefaults / applyEntitySequences and before the
    // created_at/updated_at merge — a server default is not a caller writing a field.
    const out = await call(wardServer(), "patient.create", { role: "clerk", body: { family_name: "Curie" } });
    expect(out.status).toBe(201);
    expect(bodyOf(out)["sex"]).toBe("unknown");
    expect(bodyOf(out)["status"]).toBe("registered");
    expect(typeof bodyOf(out)["created_at"]).toBe("string");
    // Naming it explicitly is still refused — the default is the only reason it was writable.
    const named = await call(wardServer(), "patient.create", {
      role: "clerk",
      body: { family_name: "Curie", sex: "female" },
    });
    expect(named.status).toBe(403);
    expect(bodyOf(named)["field"]).toBe("sex");
  });

  it("answers 403 before 422 when the body is both unauthorized and invalid", async () => {
    // `family_name` is required and absent, so validation would 422 and enumerate it. The
    // authorization answer comes first: a 422 would hand an unauthorized caller a map of what to
    // send next.
    const out = await call(wardServer(), "patient.create", { role: "clerk", body: { mrn: "MRN-X" } });
    expect(out.status).toBe(403);
    expect(bodyOf(out)).not.toHaveProperty("fields");
    // The same body from the granted role gets the 422 the validator owes it.
    const granted = await call(wardServer(), "patient.create", { role: "clinician", body: { mrn: "MRN-X" } });
    expect(granted.status).toBe(422);
  });

  it("names the field and the rule and never a value", async () => {
    const out = await call(wardServer(), "patient.update", {
      role: "clerk",
      params: { id: "pat-1" },
      body: { mrn: "MRN-SECRET-VALUE" },
    });
    expect(out.status).toBe(403);
    const serialized = JSON.stringify(bodyOf(out));
    expect(serialized).toContain("mrn");
    expect(serialized).toContain("Patient");
    expect(serialized).not.toContain("MRN-SECRET-VALUE");
  });

  it("ignores the reserved expectedUpdatedAt token, which is not a field", async () => {
    const srv = wardServer();
    const created = bodyOf(await call(srv, "patient.create", { role: "clerk", body: { family_name: "Franklin" } }));
    const id = created["id"] as string;
    const out = await call(srv, "patient.update", {
      role: "clerk",
      params: { id },
      body: { family_name: "Franklin-K", expectedUpdatedAt: created["updated_at"] as string },
    });
    expect(out.status).toBe(200);
  });

  it("a transition is never masked, even when its state field is classified and restricted", async () => {
    // A transition takes no body and writes `{[stateField]: toState, updated_at}`, both chosen by
    // the manifest's workflow and the clock. `Episode.phase` is pii with `update:
    // {roles:["clinician"]}`; a clerk may still fire `close`, because nothing the caller sent is
    // being written.
    const srv = wardServer();
    const created = bodyOf(await call(srv, "episode.create", { role: "clerk", body: {} }));
    const id = created["id"] as string;
    const out = await call(srv, "episode.close", { role: "clerk", params: { id } });
    expect(out.status).toBe(200);
    expect(bodyOf(out)["phase"]).toBe("closed");
    // And Patient, whose classified fields the clerk cannot write, still transitions.
    const patient = bodyOf(await call(srv, "patient.create", { role: "clerk", body: { family_name: "Meitner" } }));
    const admitted = await call(srv, "patient.admit", { role: "clerk", params: { id: patient["id"] as string } });
    expect(admitted.status).toBe(200);
    expect(bodyOf(admitted)["status"]).toBe("admitted");
  });

  it("a delete is never masked (no body)", async () => {
    const srv = wardServer();
    const created = bodyOf(await call(srv, "patient.create", { role: "clerk", body: { family_name: "Bell" } }));
    const out = await call(srv, "patient.delete", { role: "clinician", params: { id: created["id"] as string } });
    expect(out.status).toBe(204);
  });

  it("entity RBAC still answers first: an ungranted entity op 403s on the entity, not the field", async () => {
    const out = await call(wardServer(), "patient.delete", { role: "clerk", params: { id: "pat-1" } });
    expect(out.status).toBe(403);
    expect(bodyOf(out)).not.toHaveProperty("field");
  });
});

describe("operate handlers — write mask (classified, opt-in)", () => {
  it("refuses a sensitive field with no update grant", async () => {
    const out = await call(wardServer({ writeMaskMode: "classified" }), "patient.create", {
      role: "clerk",
      body: { family_name: "Lovelace", given_name: "Ada" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["field"]).toBe("family_name");
    expect(bodyOf(out)["rule"]).toBe("classification_default");
  });

  it("permits it for a role privileged for that class", async () => {
    const out = await call(
      wardServer({
        writeMaskMode: "classified",
        policyForEntity: () => ({ privilegedRolesByClass: { pii: ["compliance"] } }),
      }),
      "patient.create",
      { role: "compliance", body: { family_name: "Lovelace", given_name: "Ada" } },
    );
    expect(out.status).toBe(201);
  });

  it("{phi: []} refuses even a wholesale privilegedRoles holder", async () => {
    // ADR-0329: a class with an entry is authoritative for that class, so an explicit empty list
    // is a refusal and not a fall-through — otherwise a wholesale grantee could never be withheld
    // from phi. `mrn` carries its own grant, so the phi field under test is the state of `Episode`.
    const srv = wardServer({
      writeMaskMode: "classified",
      policyForEntity: () => ({
        privilegedRoles: ["compliance"],
        privilegedRolesByClass: { phi: [], pii: ["compliance"] },
      }),
    });
    // pii has an entry naming compliance, so the pii fields pass.
    const created = await call(srv, "patient.create", {
      role: "compliance",
      body: { family_name: "Lovelace", given_name: "Ada" },
    });
    expect(created.status).toBe(201);
    // phi's entry is empty, so the wholesale grant does not reach it.
    const phi = await call(srv, "patient.update", {
      role: "compliance",
      params: { id: bodyOf(created)["id"] as string },
      body: { mrn: "MRN-9" },
    });
    expect(phi.status).toBe(403);
    expect(bodyOf(phi)["rule"]).toBe("explicit_update_grant");
  });

  it("a server-filled default is still not masked under the symmetric rule", async () => {
    const out = await call(
      wardServer({
        writeMaskMode: "classified",
        policyForEntity: () => ({ privilegedRolesByClass: { pii: ["compliance"] } }),
      }),
      "episode.create",
      { role: "clinician", body: {} },
    );
    // `Episode.phase` is pii with a literal default and an update grant naming clinician.
    expect(out.status).toBe(201);
    expect(bodyOf(out)["phase"]).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// ABAC obligations (ADR-0339's open end #3).
//
// `rbacCheck` attached the obligation to an *allowed* decision and no caller read it, so an
// abac-qualified grant granted unconditionally — the inverse of the "fail closed" invariant. The
// evaluator is a single `HandlerContext` seam feeding both the entity check and the write mask, and
// the 403 names the obligation so an operator can tell "your attributes do not match" (`denied`)
// from "this deployment cannot evaluate this policy" (`undischargeable`).
//
// These build handlers directly from `buildSpecHandler` rather than through
// `compileOperateServer`, so what is under test is the `HandlerContext` seam itself and not
// `compile.ts`'s threading of it.
// ---------------------------------------------------------------------------

const ABAC_KEY = "patient.in_care_team";

const CLINIC = {
  meta: { name: "clinic", version: "1.0.0" },
  entities: [
    {
      name: "Patient",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        // required, unclassified, no grant: always writable, so its absence is the 422 the
        // ordering test needs.
        { name: "family_name", type: { kind: "text", maxLength: 100 }, required: true },
        // phi with a grant naming clinician *and* an obligation: the field-level case.
        { name: "mrn", type: { kind: "text", maxLength: 32 }, classification: "phi" },
      ],
    },
    {
      // Entity-level: the `update` grant itself carries the obligation.
      name: "Vault",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "label", type: { kind: "text", maxLength: 40 } },
      ],
    },
    {
      // Entity-level on **every** operation, so one entity exercises all five positions: the three
      // that can go and load the record and the two that structurally cannot.
      name: "Ward",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "label", type: { kind: "text", maxLength: 40 } },
      ],
    },
    {
      // The transition position: the record is already loaded unconditionally, so what is under
      // test is *where* the obligation is asked relative to the from-state 409.
      name: "Chart",
      fields: [
        { name: "id", type: { kind: "uuid" } },
        { name: "phase", type: { kind: "text", maxLength: 20 } },
      ],
    },
  ],
  workflows: {
    chart_lifecycle: {
      kind: "entityLifecycle",
      entity: "Chart",
      stateField: "phase",
      initial: "open",
      transitions: [{ name: "seal", from: "open", to: "sealed" }],
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
      fields: { mrn: { read: { roles: ["clinician"] }, update: { roles: ["clinician"], abac: ABAC_KEY } } },
    },
    Vault: {
      list: { roles: ["clerk", "clinician"] },
      read: { roles: ["clerk", "clinician"] },
      create: { roles: ["clerk", "clinician"] },
      update: { roles: ["clinician"], abac: ABAC_KEY },
      delete: { roles: ["clinician"] },
    },
    Ward: {
      list: { roles: ["clinician"], abac: ABAC_KEY },
      read: { roles: ["clinician"], abac: ABAC_KEY },
      create: { roles: ["clinician"], abac: ABAC_KEY },
      update: { roles: ["clinician"], abac: ABAC_KEY },
      delete: { roles: ["clinician"], abac: ABAC_KEY },
    },
    Chart: {
      list: { roles: ["clinician"] },
      read: { roles: ["clinician"] },
      create: { roles: ["clinician"] },
      update: { roles: ["clinician"] },
      delete: { roles: ["clinician"] },
      transitions: { seal: { roles: ["clinician"], abac: ABAC_KEY } },
    },
  },
} as unknown as Manifest;

const CLINIC_SPECS = manifestRouteSpecs(CLINIC);

const CLINIC_ROLES = new Map<RoleName, RoleDefinition>([
  ["clerk", { name: "clerk" }],
  ["clinician", { name: "clinician" }],
]);

function clinicCtx(
  store: InMemoryEntityStore,
  abacEvaluator?: AbacEvaluator,
): HandlerContext {
  return {
    store,
    permissions: (CLINIC.permissions ?? {}) as PermissionMap,
    roles: CLINIC_ROLES,
    principalRoles,
    validationPlans: buildValidationPlans(CLINIC),
    classifiedFields: buildClassifiedFieldIndex(CLINIC),
    ...(abacEvaluator !== undefined ? { abacEvaluator } : {}),
  };
}

function evaluator(outcome: AbacOutcome, seen?: AbacEvaluationInput[]): AbacEvaluator {
  return (input) => {
    seen?.push(input);
    return outcome;
  };
}

async function hit(
  ctx: HandlerContext,
  opId: string,
  opts: {
    role: string;
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    /** Rewrites the resolved principal — used to drop the attributes the fixture resolves. */
    principal?: (p: ResolvedPrincipal | null) => ResolvedPrincipal | null;
  },
): Promise<HandlerOutput> {
  const spec = CLINIC_SPECS.find((s) => s.operationId === opId);
  if (spec === undefined) throw new Error(`no route for ${opId}`);
  return buildSpecHandler(spec, ctx)({
    request: buildIncomingRequest({
      id: "req_ab0000000001",
      receivedAt: "2026-06-03T12:00:00.000Z",
      method: spec.method,
      path: "/v1/x",
      headers: {},
      host: "api.example.com",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.1",
    }),
    route: routeFromSpec(spec),
    principal: (opts.principal ?? ((p) => p))(principal(opts.role)),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  });
}

describe("operate handlers — abac obligation on an entity grant", () => {
  it("403s undischargeable when the grant carries abac and no evaluator is configured", async () => {
    const store = new InMemoryEntityStore();
    const created = bodyOf(await hit(clinicCtx(store), "vault.create", { role: "clerk", body: { label: "A" } }));
    const out = await hit(clinicCtx(store), "vault.update", {
      role: "clinician",
      params: { id: created["id"] as string },
      body: { label: "B" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["error"]).toBe("forbidden");
    expect(bodyOf(out)["abacPolicyKey"]).toBe(ABAC_KEY);
    expect(bodyOf(out)["abacOutcome"]).toBe("undischargeable");
    // The write never happened: the record still holds its original label.
    const still = bodyOf(await hit(clinicCtx(store), "vault.read", { role: "clerk", params: { id: created["id"] as string } }));
    expect(still["label"]).toBe("A");
  });

  it("proceeds to the store when the evaluator answers satisfied", async () => {
    const store = new InMemoryEntityStore();
    const created = bodyOf(await hit(clinicCtx(store), "vault.create", { role: "clerk", body: { label: "A" } }));
    const id = created["id"] as string;
    const out = await hit(clinicCtx(store, evaluator("satisfied")), "vault.update", {
      role: "clinician",
      params: { id },
      body: { label: "B" },
    });
    expect(out.status).toBe(200);
    // The store was really called, not merely the status allowed.
    const stored = await store.get(TENANT, "Vault", id);
    expect(stored?.["label"]).toBe("B");
  });

  it("refuses an obligated grant when attributes were never resolved, even on satisfied", async () => {
    // ADR-0341: `dischargeAbac` refuses `null` attributes before the evaluator runs, so a
    // deployment that declared a policy but no attribute directory denies rather than answering
    // from an input nobody gathered. The spy proving zero calls is the point — a `satisfied`
    // evaluator is present and is never asked.
    const store = new InMemoryEntityStore();
    const created = bodyOf(await hit(clinicCtx(store), "vault.create", { role: "clerk", body: { label: "A" } }));
    const id = created["id"] as string;
    let calls = 0;
    const spy = (): "satisfied" => {
      calls += 1;
      return "satisfied";
    };
    const unresolved = (p: ResolvedPrincipal | null): ResolvedPrincipal | null =>
      p === null ? null : { ...p, abacAttributes: undefined };
    const out = await hit(clinicCtx(store, spy), "vault.update", {
      role: "clinician",
      params: { id },
      body: { label: "B" },
      principal: unresolved,
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["abacOutcome"]).toBe("undischargeable");
    expect(calls).toBe(0);
    // And the write did not land.
    expect((await store.get(TENANT, "Vault", id))?.["label"]).toBe("A");
  });

  it("403s denied, distinguishably from undischargeable, when the attributes do not match", async () => {
    const store = new InMemoryEntityStore();
    const created = bodyOf(await hit(clinicCtx(store), "vault.create", { role: "clerk", body: { label: "A" } }));
    const out = await hit(clinicCtx(store, evaluator("denied")), "vault.update", {
      role: "clinician",
      params: { id: created["id"] as string },
      body: { label: "B" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["abacOutcome"]).toBe("denied");
    expect(bodyOf(out)["abacPolicyKey"]).toBe(ABAC_KEY);
  });

  it("hands the evaluator the policy key, entity and operation", async () => {
    const seen: AbacEvaluationInput[] = [];
    const store = new InMemoryEntityStore();
    const created = bodyOf(await hit(clinicCtx(store), "vault.create", { role: "clerk", body: { label: "A" } }));
    await hit(clinicCtx(store, evaluator("satisfied", seen)), "vault.update", {
      role: "clinician",
      params: { id: created["id"] as string },
      body: { label: "B" },
    });
    expect(seen.map((i) => [i.policyKey, i.entity, i.operation])).toEqual([[ABAC_KEY, "Vault", "update"]]);
  });

  it("an ordinary role refusal carries neither new field, so an existing client sees no change", async () => {
    // `Patient.delete` is clinician-only and its grant carries no `abac`. An existing client
    // parsing this body must see exactly `{error, detail}` as before.
    const out = await hit(clinicCtx(new InMemoryEntityStore()), "patient.delete", {
      role: "clerk",
      params: { id: "pat-1" },
    });
    expect(out.status).toBe(403);
    expect(Object.keys(bodyOf(out)).sort()).toEqual(["detail", "error"]);
  });

  it("a grant with no abac is unaffected by a denied evaluator", async () => {
    // Configuring an evaluator must not narrow every unqualified grant in the manifest.
    const out = await hit(clinicCtx(new InMemoryEntityStore(), evaluator("denied")), "vault.create", {
      role: "clerk",
      body: { label: "A" },
    });
    expect(out.status).toBe(201);
  });
});

describe("operate handlers — abac obligation on a field grant (the write mask)", () => {
  it("403s undischargeable on create for the granted role with no evaluator", async () => {
    const store = new InMemoryEntityStore();
    const out = await hit(clinicCtx(store), "patient.create", {
      role: "clinician",
      body: { family_name: "Hopper", mrn: "MRN-1" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["field"]).toBe("mrn");
    expect(bodyOf(out)["rule"]).toBe("abac_obligation");
    expect(bodyOf(out)["abacPolicyKey"]).toBe(ABAC_KEY);
    expect(bodyOf(out)["abacOutcome"]).toBe("undischargeable");
    expect((await store.list(TENANT, "Patient")).length).toBe(0);
  });

  it("writes through when the evaluator answers satisfied", async () => {
    const store = new InMemoryEntityStore();
    const out = await hit(clinicCtx(store, evaluator("satisfied")), "patient.create", {
      role: "clinician",
      body: { family_name: "Hopper", mrn: "MRN-1" },
    });
    expect(out.status).toBe(201);
    const stored = await store.list(TENANT, "Patient");
    expect(stored.length).toBe(1);
    expect(stored[0]?.["mrn"]).toBe("MRN-1");
  });

  it("403s denied on update, leaving the stored value untouched", async () => {
    const store = new InMemoryEntityStore();
    const created = bodyOf(
      await hit(clinicCtx(store, evaluator("satisfied")), "patient.create", {
        role: "clinician",
        body: { family_name: "Hopper", mrn: "MRN-1" },
      }),
    );
    const id = created["id"] as string;
    const out = await hit(clinicCtx(store, evaluator("denied")), "patient.update", {
      role: "clinician",
      params: { id },
      body: { mrn: "MRN-REPLACED" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["abacOutcome"]).toBe("denied");
    expect((await store.get(TENANT, "Patient", id))?.["mrn"]).toBe("MRN-1");
  });

  it("names the field, the rule and the policy key, and never a value", async () => {
    const out = await hit(clinicCtx(new InMemoryEntityStore()), "patient.update", {
      role: "clinician",
      params: { id: "pat-1" },
      body: { mrn: "MRN-SECRET-VALUE" },
    });
    const serialized = JSON.stringify(bodyOf(out));
    expect(serialized).toContain(ABAC_KEY);
    expect(serialized).not.toContain("MRN-SECRET-VALUE");
  });

  it("the 403 precedes the 422 with a third refusal in the ordering", async () => {
    // `family_name` is required and absent, so validation would 422 and enumerate it. An
    // undischargeable obligation on `mrn` answers first: a 422 would hand a caller who may not
    // write the field a map of what to send next.
    const store = new InMemoryEntityStore();
    const refused = await hit(clinicCtx(store), "patient.create", { role: "clinician", body: { mrn: "MRN-X" } });
    expect(refused.status).toBe(403);
    expect(bodyOf(refused)["rule"]).toBe("abac_obligation");
    expect(bodyOf(refused)).not.toHaveProperty("fields");
    // Discharge the obligation and the same body gets the 422 the validator owes it.
    const validated = await hit(clinicCtx(store, evaluator("satisfied")), "patient.create", {
      role: "clinician",
      body: { mrn: "MRN-X" },
    });
    expect(validated.status).toBe(422);
    expect((bodyOf(validated)["fields"] as Array<{ field: string }>).map((f) => f.field)).toEqual(["family_name"]);
  });

  it("a role the field grant does not name is still refused by the role rule", async () => {
    // The three refusals stay distinct end to end: a `clerk` never reaches the obligation.
    const out = await hit(clinicCtx(new InMemoryEntityStore(), evaluator("satisfied")), "patient.create", {
      role: "clerk",
      body: { family_name: "Lovelace", mrn: "MRN-1" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["rule"]).toBe("explicit_update_grant");
    expect(bodyOf(out)).not.toHaveProperty("abacPolicyKey");
  });

  it("a body naming no obligated field is unaffected", async () => {
    const out = await hit(clinicCtx(new InMemoryEntityStore(), evaluator("denied")), "patient.create", {
      role: "clerk",
      body: { family_name: "Lovelace" },
    });
    expect(out.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// A record-bearing obligation (ADR-0341's open end #1).
//
// `AbacEvaluationInput` carried no record, so "owns this row" was inexpressible by any evaluator —
// and the reason was structural rather than an omission: `rbacCheck` runs before any store call in
// every handler, so a record-bearing obligation could not be answered where the decision was made.
// A `deferred` outcome is the refusal that says so, and the invariant below is what the handlers
// now hold: **nothing is written before the obligation is discharged.** The only step permitted
// between the deferral and the re-ask is loading the record.
// ---------------------------------------------------------------------------

/**
 * An evaluator whose policy needs the stored record: `deferred` while it is absent, `whenPresent`
 * once it arrives. Every input is captured, so a test asserts the count *and* the order — two
 * calls, record absent then present, is the whole shape of the re-ask, and one call means either
 * the obligation was never re-asked (so a `deferred` admitted a write) or never asked at all.
 */
function recordBearing(whenPresent: AbacOutcome, seen: AbacEvaluationInput[]): AbacEvaluator {
  return (input) => {
    seen.push(input);
    return input.record === undefined ? "deferred" : whenPresent;
  };
}

/** Records every store call, so "the refusal preceded the store" is asserted and not assumed. */
class CountingStore extends InMemoryEntityStore {
  readonly calls: string[] = [];

  override get(...args: Parameters<InMemoryEntityStore["get"]>): ReturnType<InMemoryEntityStore["get"]> {
    this.calls.push("get");
    return super.get(...args);
  }

  override listPage(
    ...args: Parameters<InMemoryEntityStore["listPage"]>
  ): ReturnType<InMemoryEntityStore["listPage"]> {
    this.calls.push("listPage");
    return super.listPage(...args);
  }

  override create(
    ...args: Parameters<InMemoryEntityStore["create"]>
  ): ReturnType<InMemoryEntityStore["create"]> {
    this.calls.push("create");
    return super.create(...args);
  }

  override update(
    ...args: Parameters<InMemoryEntityStore["update"]>
  ): ReturnType<InMemoryEntityStore["update"]> {
    this.calls.push("update");
    return super.update(...args);
  }

  override remove(
    ...args: Parameters<InMemoryEntityStore["remove"]>
  ): ReturnType<InMemoryEntityStore["remove"]> {
    this.calls.push("remove");
    return super.remove(...args);
  }
}

const WARD_ID = "ward-1";
const CHART_ID = "chart-1";

interface ReAskCase {
  readonly name: string;
  readonly opId: string;
  readonly entity: string;
  readonly seed: Record<string, unknown>;
  readonly body?: Record<string, unknown>;
  readonly ok: number;
}

/** The four actions `ABAC_RECORD_AVAILABILITY` calls `always`: each one can load and re-ask. */
const RE_ASK_CASES: readonly ReAskCase[] = [
  { name: "read", opId: "ward.read", entity: "Ward", seed: { id: WARD_ID, label: "A" }, ok: 200 },
  {
    name: "update",
    opId: "ward.update",
    entity: "Ward",
    seed: { id: WARD_ID, label: "A" },
    body: { label: "B" },
    ok: 200,
  },
  { name: "delete", opId: "ward.delete", entity: "Ward", seed: { id: WARD_ID, label: "A" }, ok: 204 },
  { name: "transition", opId: "chart.seal", entity: "Chart", seed: { id: CHART_ID, phase: "open" }, ok: 200 },
];

async function seeded(entity: string, seed: Record<string, unknown>): Promise<InMemoryEntityStore> {
  const store = new InMemoryEntityStore();
  await store.create(TENANT, entity, seed);
  return store;
}

describe("operate handlers — an entity obligation deferred for want of a record is re-asked", () => {
  for (const c of RE_ASK_CASES) {
    it(`${c.name}: defers with no record, admits with it, and asks exactly twice`, async () => {
      const store = await seeded(c.entity, c.seed);
      const seen: AbacEvaluationInput[] = [];
      const out = await hit(clinicCtx(store, recordBearing("satisfied", seen)), c.opId, {
        role: "clinician",
        params: { id: c.seed["id"] as string },
        ...(c.body !== undefined ? { body: c.body } : {}),
      });
      expect(out.status).toBe(c.ok);
      expect(seen.length).toBe(2);
      expect(seen[0]?.record).toBeUndefined();
      expect(seen[1]?.record).toMatchObject({ id: c.seed["id"] });
      // The same policy key both times: the re-ask differs in nothing but the record.
      expect(seen.map((i) => i.policyKey)).toEqual([ABAC_KEY, ABAC_KEY]);
    });

    it(`${c.name}: 403s when the policy denies with the record in hand`, async () => {
      const store = await seeded(c.entity, c.seed);
      const seen: AbacEvaluationInput[] = [];
      const out = await hit(clinicCtx(store, recordBearing("denied", seen)), c.opId, {
        role: "clinician",
        params: { id: c.seed["id"] as string },
        ...(c.body !== undefined ? { body: c.body } : {}),
      });
      expect(out.status).toBe(403);
      expect(bodyOf(out)["abacOutcome"]).toBe("denied");
      expect(bodyOf(out)["abacPolicyKey"]).toBe(ABAC_KEY);
      // The record **did** reach the evaluator, so the refusal is the policy's answer about this
      // row and not a restatement of the missing input that deferred.
      expect(seen.length).toBe(2);
      expect(seen[1]?.record).toMatchObject({ id: c.seed["id"] });
      // And nothing was written: the seeded record is intact and still there.
      expect(await store.get(TENANT, c.entity, c.seed["id"] as string)).toMatchObject(c.seed);
    });
  }

  it("read: a deferred-then-denied obligation is a 403 and never a 404", async () => {
    // Answering 404 for a record that exists would make a record-predicate refusal
    // indistinguishable from a missing record, so an operator could not tell "not yours" from
    // "not there". The contrast is the assertion: the same route 404s for an id that is absent.
    const store = await seeded("Ward", { id: WARD_ID, label: "A" });
    const seen: AbacEvaluationInput[] = [];
    const ctx = clinicCtx(store, recordBearing("denied", seen));
    expect((await hit(ctx, "ward.read", { role: "clinician", params: { id: WARD_ID } })).status).toBe(403);
    expect((await hit(ctx, "ward.read", { role: "clinician", params: { id: "nope" } })).status).toBe(404);
  });

  it("update: the record is loaded even with no guards, effects or expectedUpdatedAt", async () => {
    // `needsBefore` had three reasons and an outstanding obligation is a fourth. Without it the
    // record is never fetched for a plain patch, and the obligation could only ever refuse.
    const store = new CountingStore();
    await store.create(TENANT, "Ward", { id: WARD_ID, label: "A" });
    store.calls.length = 0;
    const seen: AbacEvaluationInput[] = [];
    const out = await hit(clinicCtx(store, recordBearing("satisfied", seen)), "ward.update", {
      role: "clinician",
      params: { id: WARD_ID },
      body: { label: "B" },
    });
    expect(out.status).toBe(200);
    expect(store.calls).toEqual(["get", "update"]);
  });

  it("update: the obligation is re-asked before the 409, not after", async () => {
    // A stale `expectedUpdatedAt` *and* a denying record obligation. A 409 is a lost-update report
    // about a record this caller may turn out not to be allowed to touch at all, so authorization
    // answers first — reversing the two would disclose that the record had been modified.
    const store = await seeded("Ward", { id: WARD_ID, label: "A", updated_at: "2026-06-03T12:00:00.000Z" });
    const seen: AbacEvaluationInput[] = [];
    const out = await hit(clinicCtx(store, recordBearing("denied", seen)), "ward.update", {
      role: "clinician",
      params: { id: WARD_ID },
      body: { label: "B", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["abacOutcome"]).toBe("denied");
    // The same request with the obligation satisfied gets the 409 it is otherwise owed, so the
    // 403 is an ordering result and not a conflict the obligation happened to mask.
    const conflicted = await hit(clinicCtx(store, recordBearing("satisfied", [])), "ward.update", {
      role: "clinician",
      params: { id: WARD_ID },
      body: { label: "B", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(conflicted.status).toBe(409);
  });

  it("transition: a denying obligation on a wrong from-state answers 403, not 409", async () => {
    // Authorization precedes business logic. The 409 names the state the record is in, which is a
    // fact about a record this caller may not be allowed to move.
    const store = await seeded("Chart", { id: CHART_ID, phase: "sealed" });
    const out = await hit(clinicCtx(store, recordBearing("denied", [])), "chart.seal", {
      role: "clinician",
      params: { id: CHART_ID },
    });
    expect(out.status).toBe(403);
    // Satisfied, and the same record in the same wrong state gets the 409.
    const conflicted = await hit(clinicCtx(store, recordBearing("satisfied", [])), "chart.seal", {
      role: "clinician",
      params: { id: CHART_ID },
    });
    expect(conflicted.status).toBe(409);
    expect(bodyOf(conflicted)["error"]).toBe("invalid_transition");
  });

  it("delete: a denying obligation does not call remove", async () => {
    const store = new CountingStore();
    await store.create(TENANT, "Ward", { id: WARD_ID, label: "A" });
    store.calls.length = 0;
    const out = await hit(clinicCtx(store, recordBearing("denied", [])), "ward.delete", {
      role: "clinician",
      params: { id: WARD_ID },
    });
    expect(out.status).toBe(403);
    expect(store.calls).toEqual(["get"]);
    expect(await store.get(TENANT, "Ward", WARD_ID)).not.toBeNull();
  });
});

describe("operate handlers — a deferred obligation is final where no record can ever arrive", () => {
  it("create: 403s, names the structural reason, and reaches no store call", async () => {
    const store = new CountingStore();
    const seen: AbacEvaluationInput[] = [];
    const out = await hit(clinicCtx(store, recordBearing("satisfied", seen)), "ward.create", {
      role: "clinician",
      body: { label: "A" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["abacOutcome"]).toBe("deferred");
    expect(bodyOf(out)["abacPolicyKey"]).toBe(ABAC_KEY);
    // The reason, not merely the outcome: `deferred` on its own reads like a retry, and a create
    // has nothing to retry with.
    expect(bodyOf(out)["detail"]).toContain("does not exist until the write commits");
    expect(store.calls).toEqual([]);
    // Asked exactly once — there is no second question to ask.
    expect(seen.length).toBe(1);
    expect(seen[0]?.record).toBeUndefined();
  });

  it("list: 403s, names the structural reason, and reaches no store call", async () => {
    const store = new CountingStore();
    const seen: AbacEvaluationInput[] = [];
    const out = await hit(clinicCtx(store, recordBearing("satisfied", seen)), "ward.list", {
      role: "clinician",
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["abacOutcome"]).toBe("deferred");
    expect(bodyOf(out)["detail"]).toContain("a per-record answer is a filter");
    expect(store.calls).toEqual([]);
    expect(seen.length).toBe(1);
  });

  it("a non-deferred refusal carries no structural reason, so the existing detail is unchanged", async () => {
    // `undischargeable` is a deployment gap at every position, so appending "a create has no
    // stored record" to it would name the wrong remedy.
    const out = await hit(clinicCtx(new InMemoryEntityStore()), "ward.create", {
      role: "clinician",
      body: { label: "A" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["abacOutcome"]).toBe("undischargeable");
    expect(bodyOf(out)["detail"]).not.toContain("does not exist until the write commits");
  });
});

describe("operate handlers — a record-bearing obligation on a field grant", () => {
  const PATIENT_ID = "pat-1";

  async function withPatient(): Promise<InMemoryEntityStore> {
    return seeded("Patient", { id: PATIENT_ID, family_name: "Hopper", mrn: "MRN-1" });
  }

  it("update: deferred before the transaction, re-run with `before`, and 200 when it admits", async () => {
    const store = await withPatient();
    const seen: AbacEvaluationInput[] = [];
    const out = await hit(clinicCtx(store, recordBearing("satisfied", seen)), "patient.update", {
      role: "clinician",
      params: { id: PATIENT_ID },
      body: { mrn: "MRN-2" },
    });
    expect(out.status).toBe(200);
    expect(bodyOf(out)["mrn"]).toBe("MRN-2");
    // Twice, and both about the *field*: `Patient`'s entity grants carry no obligation, so every
    // call here comes from the mask.
    expect(seen.length).toBe(2);
    expect(seen.map((i) => i.field)).toEqual(["mrn", "mrn"]);
    expect(seen[0]?.record).toBeUndefined();
    expect(seen[1]?.record).toMatchObject({ id: PATIENT_ID, mrn: "MRN-1" });
  });

  it("update: 403s when the record denies, leaving the stored value untouched", async () => {
    const store = await withPatient();
    const seen: AbacEvaluationInput[] = [];
    const out = await hit(clinicCtx(store, recordBearing("denied", seen)), "patient.update", {
      role: "clinician",
      params: { id: PATIENT_ID },
      body: { mrn: "MRN-REPLACED" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["field"]).toBe("mrn");
    expect(bodyOf(out)["rule"]).toBe("abac_obligation");
    expect(bodyOf(out)["abacOutcome"]).toBe("denied");
    expect(seen[1]?.record).toMatchObject({ mrn: "MRN-1" });
    expect((await store.get(TENANT, "Patient", PATIENT_ID))?.["mrn"]).toBe("MRN-1");
  });

  it("update: the record is loaded for the mask's sake alone", async () => {
    const store = new CountingStore();
    await store.create(TENANT, "Patient", { id: PATIENT_ID, family_name: "Hopper", mrn: "MRN-1" });
    store.calls.length = 0;
    await hit(clinicCtx(store, recordBearing("satisfied", [])), "patient.update", {
      role: "clinician",
      params: { id: PATIENT_ID },
      body: { mrn: "MRN-2" },
    });
    expect(store.calls).toEqual(["get", "update"]);
  });

  it("create: the same grant refuses deferred and final, naming the field position's reason", async () => {
    const store = new CountingStore();
    const out = await hit(clinicCtx(store, recordBearing("satisfied", [])), "patient.create", {
      role: "clinician",
      body: { family_name: "Hopper", mrn: "MRN-1" },
    });
    expect(out.status).toBe(403);
    expect(bodyOf(out)["field"]).toBe("mrn");
    expect(bodyOf(out)["rule"]).toBe("abac_obligation");
    expect(bodyOf(out)["abacOutcome"]).toBe("deferred");
    expect(bodyOf(out)["detail"]).toContain("the create path cannot");
    expect(store.calls).toEqual([]);
  });

  it("the ordering cost: a deferring field obligation plus an invalid body answers 422", async () => {
    // Pinned deliberately, because it is the one behavioural cost of the re-ask. The mask
    // short-circuits on the *first* refusing field and a deferral is a refusal — but a deferral is
    // no longer a *return*, so the handler falls through to validation and the 422 answers first.
    //
    // Bounded, on ADR-0339's own ordering argument: the 403-before-422 rule exists so an
    // *unauthorized* caller cannot harvest the entity's shape from a 422, and this caller has
    // already passed the entity-level `update` role check — they could learn the same shape from a
    // valid write on a record they do own.
    const store = await withPatient();
    const deferring = await hit(clinicCtx(store, recordBearing("satisfied", [])), "patient.update", {
      role: "clinician",
      params: { id: PATIENT_ID },
      body: { mrn: "MRN-2", family_name: "" },
    });
    expect(deferring.status).toBe(422);
    // The contrast is what makes it a pin rather than a coincidence: an `undischargeable`
    // obligation is a refusal with nothing to re-ask, so it still answers 403 first.
    const undischargeable = await hit(clinicCtx(store), "patient.update", {
      role: "clinician",
      params: { id: PATIENT_ID },
      body: { mrn: "MRN-2", family_name: "" },
    });
    expect(undischargeable.status).toBe(403);
    expect(bodyOf(undischargeable)["abacOutcome"]).toBe("undischargeable");
  });
});
