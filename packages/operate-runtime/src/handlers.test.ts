import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { beforeEach, describe, expect, it } from "vitest";

import { compileOperateServer, type CompiledOperateServer } from "./compile.js";
import { routeFromSpec } from "./operations.js";
import { InMemoryEntityStore } from "./store.js";

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
