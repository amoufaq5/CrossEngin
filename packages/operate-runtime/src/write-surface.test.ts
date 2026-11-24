import { readFileSync } from "node:fs";

import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { compileOperateServer, defaultEffectStamps, type CompiledOperateServer } from "./compile.js";
import type { ChildRemovalQuery, ChildRemovers, EntityWriteAuditEvent, EntityWriteAuditor } from "./entity-audit.js";
import {
  APPROVE_CLASS_QUALIFIED_TRANSITIONS,
  APPROVE_CLASS_TRANSITION_NAMES,
  MAKER_CHECKER_ERRORS,
  approvalContentFromManifest,
  approveClassTransitions,
  formatSegregationOfDuties,
  isApproveClassTransition,
  makerCheckerRefusal,
} from "./maker-checker.js";
import { routeFromSpec } from "./operations.js";
import { InMemorySequenceAllocator } from "./sequences.js";
import { InMemoryEntityStore } from "./store.js";
import { buildUiSchema } from "./ui-schema.js";
import {
  CALLER_RECORD_ID_PATTERN,
  SERVER_OWNED_ADMITTED,
  SERVER_OWNED_REASONS,
  buildWriteSurfaces,
  writeSurfaceRefusal,
} from "./write-surface.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const SHARED_KEY = "00000000-0000-4000-8000-0000000000aa";
const CORE = buildErpCorePack();

interface Caller {
  readonly id: string;
  readonly kind: ResolvedPrincipal["principalKind"];
}
const alice: Caller = { id: ALICE, kind: "user" };
const bob: Caller = { id: BOB, kind: "user" };
const serviceKey: Caller = { id: SHARED_KEY, kind: "service_account" };

function principalFor(caller: Caller): ResolvedPrincipal {
  return {
    principalId: caller.id,
    tenantId: TENANT,
    principalKind: caller.kind,
    authScheme: "api_key_header",
    grantedScopes: ["erp_admin"],
    abacAttributes: {},
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

interface Rig {
  readonly server: CompiledOperateServer;
  readonly store: InMemoryEntityStore;
  readonly allocator: InMemorySequenceAllocator;
  invoke(
    match: (s: CompiledOperateServer["routeSpecs"][number]) => boolean,
    opts: { caller?: Caller; params?: Record<string, string>; body?: Record<string, unknown> },
  ): Promise<HandlerOutput>;
}

function rig(options: { segregationOfDuties?: boolean; entityAudit?: EntityWriteAuditor } = {}): Rig {
  const store = new InMemoryEntityStore();
  const allocator = new InMemorySequenceAllocator();
  const server = compileOperateServer(CORE, {
    store,
    allocator,
    principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
    clock: { now: () => new Date("2026-06-03T12:00:00.000Z") },
    ...(options.segregationOfDuties !== undefined ? { segregationOfDuties: options.segregationOfDuties } : {}),
    ...(options.entityAudit !== undefined ? { entityAudit: options.entityAudit } : {}),
  });
  return {
    server,
    store,
    allocator,
    async invoke(match, opts) {
      const spec = server.routeSpecs.find(match);
      if (spec === undefined) throw new Error("no such route");
      const handler = server.handlers.resolve(spec.operationId)!;
      const request = buildIncomingRequest({
        id: "req_ws00000001",
        receivedAt: "2026-06-03T12:00:00.000Z",
        method: spec.method,
        path: "/v1/x",
        headers: {},
        host: "api.example.com",
        scheme: "https",
        bodyBytes: null,
        clientIp: "203.0.113.1",
        edgeTrust: "untrusted",
      });
      return handler({
        request,
        route: routeFromSpec(spec),
        principal: principalFor(opts.caller ?? alice),
        params: opts.params ?? {},
        parsedBody: opts.body ?? null,
      });
    },
  };
}

const op = (entity: string, action: string) => (s: CompiledOperateServer["routeSpecs"][number]) =>
  s.entity === entity && s.action === action;
const transition = (entity: string, name: string) => (s: CompiledOperateServer["routeSpecs"][number]) =>
  s.entity === entity && s.action === "transition" && s.transition?.name === name;

function body(out: HandlerOutput): Record<string, unknown> {
  if (out.kind !== "json") throw new Error("expected json");
  return out.body as Record<string, unknown>;
}

const VENDOR = { name: "Acme", vendor_code: "ACME" };

async function vendor(r: Rig, caller: Caller = alice): Promise<string> {
  const out = await r.invoke(op("Vendor", "create"), { caller, body: VENDOR });
  expect(out.status).toBe(201);
  return body(out)["id"] as string;
}

async function bill(r: Rig, caller: Caller = alice): Promise<string> {
  const vendorId = await vendor(r, caller);
  const out = await r.invoke(op("Bill", "create"), {
    caller,
    body: { vendor_id: vendorId, bill_date: "2026-06-01", due_date: "2026-07-01" },
  });
  expect(out.status).toBe(201);
  return body(out)["id"] as string;
}

describe("the write surface over resolved erp-core", () => {
  const surfaces = buildWriteSurfaces(CORE, defaultEffectStamps(CORE));

  it("covers every entity and reads the resolved fields, trait fields included", () => {
    expect(surfaces.size).toBe(CORE.entities?.length);
    const vendor = surfaces.get("Vendor")!;
    expect(vendor.declared.has("created_by")).toBe(true);
    expect(vendor.stampsActor).toBe(true);
  });

  it("derives the effect-stamped fields from the effects compile wires, and nothing else", () => {
    // Measured, not chosen: ten stamps. Six are three fields on each of the two documents, each
    // one an `input.store.update` an effect issues against the document that triggered it; the
    // seventh is the one a goods receipt advances on the order line it receives, which both the
    // receipt and the three-way match read back; and three are the tax remittance's on the return
    // it posts for (ADR-0467). `credit_disposition` is the caller's and is not among them.
    const stamps = defaultEffectStamps(CORE)
      .map((s) => `${s.entity}.${s.field}`)
      .sort();
    expect(stamps).toEqual([
      "Bill.booking_rate",
      "Bill.paid_at",
      "Bill.withholding_total",
      "Invoice.booking_rate",
      "Invoice.paid_at",
      "Invoice.withholding_total",
      "PurchaseOrderLine.received_quantity",
      "TaxReturn.remittance_count",
      "TaxReturn.remittance_entry_number",
      "TaxReturn.remitted_at",
    ]);
  });

  it("refuses the remittance stamps on a tax return's create and update, and admits its disposition", () => {
    const taxReturn = surfaces.get("TaxReturn")!;
    for (const field of ["remitted_at", "remittance_entry_number", "remittance_count"]) {
      for (const op of ["create", "update"] as const) {
        expect(writeSurfaceRefusal(taxReturn, ["output_tax", field], op), `${field} ${op}`).toEqual({
          kind: "server_owned",
          field,
          reason: "effect_stamp",
        });
      }
    }
    expect(writeSurfaceRefusal(taxReturn, ["credit_disposition", "net_payable"], "create")).toBeNull();
    expect(writeSurfaceRefusal(taxReturn, ["credit_disposition"], "update")).toBeNull();
  });

  it("answers both operations for every class, admitting only the two import paths on create", () => {
    for (const r of SERVER_OWNED_REASONS) expect(SERVER_OWNED_ADMITTED[r].update, r).toBe(false);
    const createAdmitted = SERVER_OWNED_REASONS.filter((r) => SERVER_OWNED_ADMITTED[r].create);
    expect(createAdmitted).toEqual(["record_id", "sequence_allocated"]);
  });

  it("refuses the first offending key and names the class", () => {
    const invoice = surfaces.get("Invoice")!;
    expect(writeSurfaceRefusal(invoice, ["total", "booking_rate"], "create")).toEqual({
      kind: "server_owned",
      field: "booking_rate",
      reason: "effect_stamp",
    });
    expect(writeSurfaceRefusal(invoice, ["total", "nope"], "update")).toEqual({ kind: "not_declared", field: "nope" });
    expect(writeSurfaceRefusal(invoice, ["id", "invoice_number", "total"], "create")).toBeNull();
    expect(writeSurfaceRefusal(invoice, ["invoice_number"], "update")).toEqual({
      kind: "server_owned",
      field: "invoice_number",
      reason: "sequence_allocated",
    });
  });

  it("does not stamp an entity's own created_by when it carries no `auditable` trait", () => {
    const m = {
      ...CORE,
      entities: [{ name: "Note", fields: [{ name: "created_by", type: { kind: "text" as const } }] }],
    };
    const s = buildWriteSurfaces(m as typeof CORE, []).get("Note")!;
    expect(s.stampsActor).toBe(false);
    expect(s.serverOwned.get("created_by")).toBeUndefined();
    expect(writeSurfaceRefusal(s, ["created_by"], "create")).toBeNull();
  });

  it("uses the same record-id pattern as the Postgres stores, read from their source", () => {
    // A second spelling of one rule across a package boundary operate-runtime cannot import across
    // (operate-runtime-pg depends on it), so the agreement is read as text.
    const src = readFileSync(new URL("../../operate-runtime-pg/src/records.ts", import.meta.url), "utf8");
    const m = src.match(/const RECORD_ID_RE = (\/.+\/);/);
    expect(m?.[1]).toBe(String(CALLER_RECORD_ID_PATTERN));
  });
});

describe("create and update refuse what the server owns and what the manifest does not declare", () => {
  it("refuses an undeclared key on create with 422, storing nothing", async () => {
    const r = rig();
    const out = await r.invoke(op("Vendor", "create"), { body: { ...VENDOR, bogus: "x" } });
    expect(out.status).toBe(422);
    expect(body(out)).toMatchObject({ error: "field_not_declared", field: "bogus" });
    expect((await r.store.listPage(TENANT, "Vendor", { sort: [], filters: [], limit: 10, cursor: null })).records).toEqual([]);
  });

  it.each([
    ["created_at", "2001-01-01T00:00:00.000Z", "implicit_column"],
    ["updated_at", "2001-01-01T00:00:00.000Z", "implicit_column"],
    ["tenant_id", "7906126a-1012-471a-9659-44f6a8a97610", "implicit_column"],
    ["created_by", BOB, "actor_stamp"],
    ["updated_by", BOB, "actor_stamp"],
  ])("refuses %s on create (%s)", async (field, value, reason) => {
    const r = rig();
    const out = await r.invoke(op("Vendor", "create"), { body: { ...VENDOR, [field]: value } });
    expect(out.status).toBe(422);
    expect(body(out)).toMatchObject({ error: "field_server_owned", field, reason });
  });

  it("refuses an FX booking rate on create, which the recognition edge would then not stamp", async () => {
    const r = rig();
    const vendorId = await vendor(r);
    const out = await r.invoke(op("Bill", "create"), {
      body: { vendor_id: vendorId, bill_date: "2026-06-01", due_date: "2026-07-01", booking_rate: 9.5 },
    });
    expect(body(out)).toMatchObject({ error: "field_server_owned", field: "booking_rate", reason: "effect_stamp" });
  });

  it.each([
    ["created_at", "1999-01-01T00:00:00.000Z"],
    ["id", "rec_other"],
    ["tenant_id", "7906126a-1012-471a-9659-44f6a8a97610"],
    ["updated_by", BOB],
    ["bill_number", "B-999"],
    ["booking_rate", 2],
    ["bogus", "x"],
  ])("refuses %s on update, leaving the record unchanged", async (field, value) => {
    const r = rig();
    const id = await bill(r);
    const before = await r.store.get(TENANT, "Bill", id);
    const out = await r.invoke(op("Bill", "update"), { params: { id }, body: { [field]: value } });
    expect(out.status).toBe(422);
    expect(body(out)["field"]).toBe(field);
    expect(await r.store.get(TENANT, "Bill", id)).toEqual(before);
  });

  it("admits an ordinary update and the optimistic-concurrency token", async () => {
    const r = rig();
    const id = await bill(r);
    const before = await r.store.get(TENANT, "Bill", id);
    const out = await r.invoke(op("Bill", "update"), {
      params: { id },
      body: { due_date: "2026-08-01", expectedUpdatedAt: before?.["updated_at"] },
    });
    expect(out.status).toBe(200);
    expect(body(out)["due_date"]).toBe("2026-08-01");
  });
});

describe("a caller-supplied id", () => {
  it("is kept on create, and a second create with it is a 409 rather than an overwrite", async () => {
    const r = rig();
    const first = await r.invoke(op("Vendor", "create"), { body: { ...VENDOR, id: "legacy-0001" } });
    expect(first.status).toBe(201);
    expect(body(first)["id"]).toBe("legacy-0001");
    const again = await r.invoke(op("Vendor", "create"), { body: { name: "Other", vendor_code: "OTH", id: "legacy-0001" } });
    expect(again.status).toBe(409);
    expect(body(again)).toMatchObject({ error: "id_conflict", field: "id" });
    // The in-memory store used to overwrite the first record here.
    expect((await r.store.get(TENANT, "Vendor", "legacy-0001"))?.["name"]).toBe("Acme");
  });

  it.each([["has space"], [""], [42], ["x".repeat(201)]])("is refused 422 when malformed (%s)", async (id) => {
    const r = rig();
    const out = await r.invoke(op("Vendor", "create"), { body: { ...VENDOR, id } });
    expect(out.status).toBe(422);
    expect(body(out)).toMatchObject({ error: "record_id_malformed", field: "id" });
  });
});

describe("sequence numbers", () => {
  it("are kept when a caller supplies one on create (an import keeping legacy numbers)", async () => {
    const r = rig();
    const vendorId = await vendor(r);
    const out = await r.invoke(op("Bill", "create"), {
      body: { vendor_id: vendorId, bill_date: "2026-06-01", due_date: "2026-07-01", bill_number: "LEGACY-7" },
    });
    expect(out.status).toBe(201);
    expect(body(out)["bill_number"]).toBe("LEGACY-7");
  });

  it("are not spent by a create refused at validation", async () => {
    const r = rig();
    const vendorId = await vendor(r);
    const ok = (await r.invoke(op("Bill", "create"), {
      body: { vendor_id: vendorId, bill_date: "2026-06-01", due_date: "2026-07-01" },
    })) as HandlerOutput;
    const first = body(ok)["bill_number"] as string;
    expect((await r.invoke(op("Bill", "create"), { body: { vendor_id: vendorId, bill_date: "2026-06-01" } })).status).toBe(422);
    const next = body(
      await r.invoke(op("Bill", "create"), { body: { vendor_id: vendorId, bill_date: "2026-06-01", due_date: "2026-07-01" } }),
    )["bill_number"] as string;
    const seq = (n: string) => Number(n.match(/(\d+)$/)?.[1]);
    expect(seq(next)).toBe(seq(first) + 1);
  });

  it("are allocated outside the entity transaction, so one create never holds two pool connections", async () => {
    // The Postgres allocator commits on a connection of its own. Asked while the entity transaction
    // holds one, N concurrent creates on an N-connection pool each wait for a slot none of them frees.
    let inTxn = false;
    const inner = new InMemoryEntityStore();
    const store = Object.assign(Object.create(inner) as InMemoryEntityStore, {
      async withTransaction<T>(_tenantId: string, fn: (tx: InMemoryEntityStore) => Promise<T>): Promise<T> {
        inTxn = true;
        try {
          return await fn(inner);
        } finally {
          inTxn = false;
        }
      },
    });
    const allocations: boolean[] = [];
    const base = new InMemorySequenceAllocator();
    const server = compileOperateServer(CORE, {
      store,
      allocator: {
        allocate: (input) => {
          allocations.push(inTxn);
          return base.allocate(input);
        },
      },
      principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
    });
    const vendorSpec = server.routeSpecs.find(op("Vendor", "create"))!;
    const billSpec = server.routeSpecs.find(op("Bill", "create"))!;
    const call = (spec: typeof billSpec, parsed: Record<string, unknown>) =>
      server.handlers.resolve(spec.operationId)!({
        request: buildIncomingRequest({
          id: "req_ws00000002",
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
        principal: principalFor(alice),
        params: {},
        parsedBody: parsed,
      });
    const vendorOut = await call(vendorSpec, VENDOR);
    const out = await call(billSpec, {
      vendor_id: body(vendorOut)["id"],
      bill_date: "2026-06-01",
      due_date: "2026-07-01",
    });
    expect(out.status).toBe(201);
    expect(allocations.length).toBeGreaterThan(0);
    expect(allocations.every((held) => !held)).toBe(true);
  });
});

describe("created_by and updated_by", () => {
  it("are stamped from the person on create, then updated_by moves on update and on a transition", async () => {
    const r = rig();
    const id = await bill(r, alice);
    expect(await r.store.get(TENANT, "Bill", id)).toMatchObject({ created_by: ALICE, updated_by: ALICE });
    await r.invoke(op("Bill", "update"), { caller: bob, params: { id }, body: { due_date: "2026-08-02" } });
    expect(await r.store.get(TENANT, "Bill", id)).toMatchObject({ created_by: ALICE, updated_by: BOB });
    const approved = await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } });
    expect(approved.status).toBe(200);
    expect(await r.store.get(TENANT, "Bill", id)).toMatchObject({ created_by: ALICE, updated_by: ALICE });
  });

  it("name whoever voided an invoice on its credit note, never the invoice's creator", async () => {
    const r = rig();
    const account = body(
      await r.invoke(op("Account", "create"), { body: { name: "Cust", billing_email: "c@example.test" } }),
    )["id"] as string;
    const inv = body(
      await r.invoke(op("Invoice", "create"), {
        body: { account_id: account, currency: "USD", subtotal: 100, total: 100, issue_date: "2026-06-01", due_date: "2026-07-01" },
      }),
    )["id"] as string;
    expect((await r.invoke(transition("Invoice", "send"), { params: { id: inv } })).status).toBe(200);
    expect((await r.invoke(transition("Invoice", "void"), { caller: bob, params: { id: inv } })).status).toBe(200);
    const notes = (await r.store.listPage(TENANT, "Invoice", { sort: [], filters: [], limit: 10, cursor: null })).records.filter(
      (x) => x["document_type"] === "credit_note",
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ created_by: BOB, updated_by: BOB });
  });

  it("name whoever reversed a journal entry on the reversal and its lines, never the original's people", async () => {
    const r = rig();
    const ledger = body(
      await r.invoke(op("LedgerAccount", "create"), { body: { account_code: "1000", name: "Cash", account_type: "asset" } }),
    );
    expect(ledger["id"]).toBeTypeOf("string");
    const je = body(await r.invoke(op("JournalEntry", "create"), { body: { entry_date: "2026-06-01" } }))["id"] as string;
    for (const [debit, credit] of [
      [10, 0],
      [0, 10],
    ]) {
      const line = await r.invoke(op("JournalLine", "create"), {
        body: { journal_entry_id: je, ledger_account_id: ledger["id"], debit, credit },
      });
      expect(line.status).toBe(201);
    }
    expect((await r.invoke(transition("JournalEntry", "post"), { caller: bob, params: { id: je } })).status).toBe(200);
    const carol = { id: "33333333-3333-4333-8333-333333333333", kind: "user" as const };
    expect((await r.invoke(transition("JournalEntry", "reverse"), { caller: carol, params: { id: je } })).status).toBe(200);
    const entries = (await r.store.listPage(TENANT, "JournalEntry", { sort: [], filters: [], limit: 10, cursor: null })).records;
    const reversal = entries.find((e) => e["id"] !== je)!;
    expect(reversal).toMatchObject({ created_by: carol.id, updated_by: carol.id });
    const lines = (await r.store.listPage(TENANT, "JournalLine", { sort: [], filters: [], limit: 10, cursor: null })).records.filter(
      (l) => l["journal_entry_id"] === reversal["id"],
    );
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatchObject({ created_by: carol.id, updated_by: carol.id });
  });

  it("carry no value for a credential that names no person, never the key's shared placeholder", async () => {
    const r = rig();
    const id = await vendor(r, serviceKey);
    const stored = await r.store.get(TENANT, "Vendor", id);
    // The stamp is `null`, which every store serves as absent (ADR-0414 Q4) — the column store
    // never could hold the difference — so what matters is that no id was written.
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty("created_by");
    expect(stored).not.toHaveProperty("updated_by");
  });
});

/**
 * An auditor that keeps the trail in memory and answers removals the way the Postgres reader does:
 * a delete, or an update whose `after` names a different parent, whose `before` named this one.
 */
class TrailAuditor implements EntityWriteAuditor {
  readonly events: EntityWriteAuditEvent[] = [];
  readonly asked: ChildRemovalQuery[] = [];
  constructor(private readonly answer?: ChildRemovers | "throw") {}

  async record(event: EntityWriteAuditEvent): Promise<void> {
    this.events.push(event);
  }

  async childRemovers(query: ChildRemovalQuery): Promise<ChildRemovers> {
    this.asked.push(query);
    if (this.answer === "throw") throw new Error("trail down");
    if (this.answer !== undefined) return this.answer;
    const removers = this.events
      .filter(
        (e) =>
          e.tenantId === query.tenantId &&
          e.entity === query.childEntity &&
          e.before?.[query.parentField] === query.parentId &&
          (e.after === null || e.after[query.parentField] !== query.parentId),
      )
      .map((e) => e.actorUserId);
    return { kind: "read", removers };
  }
}

async function billWithTwoLines(r: Rig, caller: Caller): Promise<{ id: string; big: string }> {
  const id = await bill(r, caller);
  const line = async (amount: string): Promise<string> => {
    const out = await r.invoke(op("BillLine", "create"), {
      caller,
      body: { bill_id: id, description: "widgets", quantity: 1, unit_price: amount, amount },
    });
    expect(out.status).toBe(201);
    return body(out)["id"] as string;
  };
  await line("1.00");
  return { id, big: await line("100000.00") };
}

describe("segregation of duties", () => {
  it("names the approve-class transitions erp-core declares", () => {
    expect(approveClassTransitions(CORE)).toEqual([
      "Bill.approve",
      "Bill.mark_paid",
      "Expense.approve",
      "Expense.reimburse",
      "Invoice.mark_paid",
      "JournalEntry.post",
      "LeaveRequest.approve",
      "Payment.complete",
      "PurchaseOrder.approve",
      "TaxReturn.mark_paid",
      "Timesheet.approve",
    ]);
    expect(isApproveClassTransition("Encounter", "complete")).toBe(false);
    expect([...APPROVE_CLASS_TRANSITION_NAMES].length + [...APPROVE_CLASS_QUALIFIED_TRANSITIONS].length).toBe(5);
  });

  it("refuses the creator approving their own bill when on", async () => {
    const r = rig({ segregationOfDuties: true });
    const id = await bill(r, alice);
    const out = await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } });
    expect(out.status).toBe(422);
    expect(body(out)["error"]).toBe(MAKER_CHECKER_ERRORS.same_person);
    expect((await r.store.get(TENANT, "Bill", id))?.["state"]).toBe("draft");
  });

  it("admits a different person when on", async () => {
    const r = rig({ segregationOfDuties: true });
    const id = await bill(r, alice);
    expect((await r.invoke(transition("Bill", "approve"), { caller: bob, params: { id } })).status).toBe(200);
  });

  it("refuses when the maker or the approver is not a person, rather than admitting what it cannot check", async () => {
    const r = rig({ segregationOfDuties: true });
    const byKey = await bill(r, serviceKey);
    const a = await r.invoke(transition("Bill", "approve"), { caller: bob, params: { id: byKey } });
    expect(body(a)["error"]).toBe(MAKER_CHECKER_ERRORS.unverifiable);
    const byAlice = await bill(r, alice);
    const b = await r.invoke(transition("Bill", "approve"), { caller: serviceKey, params: { id: byAlice } });
    expect(body(b)["error"]).toBe(MAKER_CHECKER_ERRORS.unverifiable);
  });

  it("leaves a transition that is not approve-class alone", async () => {
    const r = rig({ segregationOfDuties: true });
    const id = await bill(r, alice);
    expect((await r.invoke(transition("Bill", "void"), { caller: alice, params: { id } })).status).toBe(200);
  });

  it("is off by default: the creator may approve", async () => {
    const r = rig();
    const id = await bill(r, alice);
    expect((await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } })).status).toBe(200);
  });

  it("says at boot whether it is on, and names what it gates either way", () => {
    const off = formatSegregationOfDuties(CORE, false, true);
    expect(off).toMatch(/^\[sod\] segregation of duties: off/);
    expect(off).toContain("--segregation-of-duties");
    expect(off).toContain("11 approve-class transition(s)");
    const on = formatSegregationOfDuties(CORE, true, true);
    expect(on).toMatch(/^\[sod\] segregation of duties: on/);
    expect(on).toContain("Payment.complete");
    expect(on).toContain(MAKER_CHECKER_ERRORS.same_person);
    expect(on).toContain(MAKER_CHECKER_ERRORS.unverifiable);
    expect(on).not.toContain("--segregation-of-duties");
  });

  it("refuses the last editor of a bill approving it, though somebody else created it", async () => {
    const r = rig({ segregationOfDuties: true });
    const id = await bill(r, bob);
    const edit = await r.invoke(op("Bill", "update"), { caller: alice, params: { id }, body: { due_date: "2026-08-01" } });
    expect(edit.status).toBe(200);
    expect((await r.store.get(TENANT, "Bill", id))?.["updated_by"]).toBe(ALICE);
    const out = await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } });
    expect(out.status).toBe(422);
    expect(body(out)["error"]).toBe(MAKER_CHECKER_ERRORS.same_person);
    expect(String(body(out)["detail"])).toContain("last edited");
    expect((await r.store.get(TENANT, "Bill", id))?.["state"]).toBe("draft");
  });

  it("admits a third person after another's edit: the editor rule names the editor, not every editor", async () => {
    const r = rig({ segregationOfDuties: true });
    const id = await bill(r, bob);
    await r.invoke(op("Bill", "update"), { caller: alice, params: { id }, body: { due_date: "2026-08-01" } });
    const carol: Caller = { id: "33333333-3333-4333-8333-333333333333", kind: "user" };
    expect((await r.invoke(transition("Bill", "approve"), { caller: carol, params: { id } })).status).toBe(200);
  });

  it("refuses the author of a line approving the document that owns it", async () => {
    const r = rig({ segregationOfDuties: true });
    const id = await bill(r, bob);
    const line = await r.invoke(op("BillLine", "create"), {
      caller: alice,
      body: { bill_id: id, description: "widgets", quantity: 1, unit_price: "100000.00", amount: "100000.00" },
    });
    expect(line.status).toBe(201);
    const out = await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } });
    expect(out.status).toBe(422);
    expect(body(out)["error"]).toBe(MAKER_CHECKER_ERRORS.same_person);
    expect(String(body(out)["detail"])).toContain("BillLine");
    const carol: Caller = { id: "33333333-3333-4333-8333-333333333333", kind: "user" };
    expect((await r.invoke(transition("Bill", "approve"), { caller: carol, params: { id } })).status).toBe(200);
  });

  it("refuses an approver who deleted somebody else's line, read from the audit trail", async () => {
    // Measured live before this: Bob writes lines of 1.00 and 100 000.00, Alice deletes the second
    // and approves the first — 204 then 200, because the rows read held only Bob's line.
    const trail = new TrailAuditor();
    const r = rig({ segregationOfDuties: true, entityAudit: trail });
    const { id, big } = await billWithTwoLines(r, bob);
    expect((await r.invoke(op("BillLine", "delete"), { caller: alice, params: { id: big } })).status).toBe(204);
    const out = await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } });
    expect(out.status).toBe(422);
    expect(body(out)["error"]).toBe(MAKER_CHECKER_ERRORS.same_person);
    expect(String(body(out)["detail"])).toContain("deleted or moved away");
    expect((await r.store.get(TENANT, "Bill", id))?.["state"]).toBe("draft");
    expect(trail.asked).toEqual([
      {
        tenantId: TENANT,
        childEntity: "BillLine",
        parentField: "bill_id",
        parentId: id,
        parentCreatedAt: (await r.store.get(TENANT, "Bill", id))?.["created_at"],
      },
    ]);
    expect(typeof trail.asked[0]?.parentCreatedAt).toBe("string");
    const carol: Caller = { id: "33333333-3333-4333-8333-333333333333", kind: "user" };
    expect((await r.invoke(transition("Bill", "approve"), { caller: carol, params: { id } })).status).toBe(200);
  });

  it("counts a line moved to another bill as taken away from this one", async () => {
    const trail = new TrailAuditor();
    const r = rig({ segregationOfDuties: true, entityAudit: trail });
    const { id, big } = await billWithTwoLines(r, bob);
    const other = await bill(r, bob);
    const moved = await r.invoke(op("BillLine", "update"), { caller: alice, params: { id: big }, body: { bill_id: other } });
    expect(moved.status).toBe(200);
    const out = await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } });
    expect(body(out)["error"]).toBe(MAKER_CHECKER_ERRORS.same_person);
    // The bill it was moved to holds a line Alice last wrote, which the row read already refuses.
    expect(body(await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id: other } }))["error"]).toBe(
      MAKER_CHECKER_ERRORS.same_person,
    );
  });

  it("admits the approver when the removal was somebody else's", async () => {
    const trail = new TrailAuditor();
    const r = rig({ segregationOfDuties: true, entityAudit: trail });
    const { id, big } = await billWithTwoLines(r, bob);
    expect((await r.invoke(op("BillLine", "delete"), { caller: bob, params: { id: big } })).status).toBe(204);
    expect((await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } })).status).toBe(200);
  });

  it("refuses as unverifiable when the trail cannot be read, or a removal names no person", async () => {
    const unreadable = new TrailAuditor({ kind: "unreadable", reason: "PgError 42501" });
    const r = rig({ segregationOfDuties: true, entityAudit: unreadable });
    const { id } = await billWithTwoLines(r, bob);
    const a = await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } });
    expect(body(a)["error"]).toBe(MAKER_CHECKER_ERRORS.unverifiable);
    expect(String(body(a)["detail"])).toContain("audit trail could not be read");

    const throwing = new TrailAuditor("throw");
    const r2 = rig({ segregationOfDuties: true, entityAudit: throwing });
    const b = await billWithTwoLines(r2, bob);
    expect(body(await r2.invoke(transition("Bill", "approve"), { caller: alice, params: { id: b.id } }))["error"]).toBe(
      MAKER_CHECKER_ERRORS.unverifiable,
    );

    const trail = new TrailAuditor();
    const r3 = rig({ segregationOfDuties: true, entityAudit: trail });
    const c = await billWithTwoLines(r3, bob);
    expect((await r3.invoke(op("BillLine", "delete"), { caller: serviceKey, params: { id: c.big } })).status).toBe(204);
    const out = await r3.invoke(transition("Bill", "approve"), { caller: alice, params: { id: c.id } });
    expect(body(out)["error"]).toBe(MAKER_CHECKER_ERRORS.unverifiable);
    expect(String(body(out)["detail"])).toContain("names no person");
  });

  it("does not ask the trail when the rows already decide, nor when no trail is mounted", async () => {
    const trail = new TrailAuditor();
    const r = rig({ segregationOfDuties: true, entityAudit: trail });
    const id = await bill(r, bob);
    await r.invoke(op("BillLine", "create"), {
      caller: alice,
      body: { bill_id: id, description: "widgets", quantity: 1, unit_price: "5.00", amount: "5.00" },
    });
    expect(body(await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } }))["error"]).toBe(
      MAKER_CHECKER_ERRORS.same_person,
    );
    expect(trail.asked).toEqual([]);
    // No auditor: the removal is not checked — the boot line says so rather than the check pretending.
    const bare = rig({ segregationOfDuties: true });
    const { id: b, big } = await billWithTwoLines(bare, bob);
    await bare.invoke(op("BillLine", "delete"), { caller: alice, params: { id: big } });
    expect((await bare.invoke(transition("Bill", "approve"), { caller: alice, params: { id: b } })).status).toBe(200);
    expect(formatSegregationOfDuties(CORE, true, false)).toContain("is NOT checked");
    expect(formatSegregationOfDuties(CORE, true, true)).toContain("deleted or moved one away");
  });

  it("refuses an unstamped line as unverifiable rather than passing it", async () => {
    const r = rig({ segregationOfDuties: true });
    const id = await bill(r, bob);
    await r.store.create(TENANT, "BillLine", {
      id: "bl_unstamped",
      bill_id: id,
      description: "legacy",
      quantity: 1,
      unit_price: "1.00",
      amount: "1.00",
    });
    const out = await r.invoke(transition("Bill", "approve"), { caller: alice, params: { id } });
    expect(body(out)["error"]).toBe(MAKER_CHECKER_ERRORS.unverifiable);
  });

  it("keeps the two-person expense flow: the approver may reimburse what they approved", async () => {
    const r = rig({ segregationOfDuties: true });
    const created = await r.store.create(TENANT, "Expense", {
      id: "exp_twoperson",
      expense_number: "EXP-1",
      employee_id: "emp_1",
      category: "travel",
      amount: "10.00",
      currency: "USD",
      state: "submitted",
      incurred_on: "2026-06-01",
      created_by: ALICE,
      updated_by: ALICE,
    });
    const id = created["id"] as string;
    expect((await r.invoke(transition("Expense", "approve"), { caller: alice, params: { id } })).status).toBe(422);
    expect((await r.invoke(transition("Expense", "approve"), { caller: bob, params: { id } })).status).toBe(200);
    expect((await r.store.get(TENANT, "Expense", id))?.["updated_by"]).toBe(BOB);
    expect((await r.invoke(transition("Expense", "reimburse"), { caller: bob, params: { id } })).status).toBe(200);
  });

  it("derives what the rule reads from erp-core rather than listing it", () => {
    const c = approvalContentFromManifest(CORE);
    expect([...(c.editorAttributable.get("Bill.approve") ?? [])]).toEqual(["draft"]);
    expect([...(c.editorAttributable.get("JournalEntry.post") ?? [])]).toEqual(["draft"]);
    expect([...(c.editorAttributable.get("Expense.approve") ?? [])]).toEqual([]);
    expect(c.editorUnread).toEqual([
      "Bill.mark_paid",
      "Expense.approve",
      "Expense.reimburse",
      "Invoice.mark_paid",
      "LeaveRequest.approve",
      "Payment.complete",
      "PurchaseOrder.approve",
      "TaxReturn.mark_paid",
      "Timesheet.approve",
    ]);
    const owned = Object.fromEntries([...c.children].map(([k, v]) => [k, v.map((x) => `${x.entity}.${x.parentField}`)]));
    expect(owned["Bill"]).toEqual(["BillLine.bill_id"]);
    expect(owned["JournalEntry"]).toEqual(["JournalLine.journal_entry_id"]);
    expect(Object.keys(owned).every((k) => approveClassTransitions(CORE).some((t) => t.startsWith(`${k}.`)))).toBe(true);
  });

  it("says at boot which approvals still admit their last editor", () => {
    const on = formatSegregationOfDuties(CORE, true, true);
    expect(on).toContain("last editor");
    expect(on).toContain("Expense.reimburse");
    expect(on).not.toContain("Bill.approve, Bill.mark_paid)");
  });

  it("compares ids case-insensitively", () => {
    expect(makerCheckerRefusal("Bill", "approve", { created_by: ALICE.toUpperCase() }, ALICE, true)?.error).toBe(
      MAKER_CHECKER_ERRORS.same_person,
    );
  });

  it("does not trust a created_by the client could write: an entity without the auditable trait", async () => {
    // Bill re-declared with its own `created_by` and no `auditable`: the field is then an ordinary,
    // client-writable one, so a maker could name somebody else as creator and approve their own bill.
    const bare = {
      ...CORE,
      entities: (CORE.entities ?? []).map((e) =>
        e.name === "Bill"
          ? { ...e, traits: [], fields: [...e.fields, { name: "created_by", type: { kind: "uuid" as const } }] }
          : e,
      ),
    } as typeof CORE;
    const store = new InMemoryEntityStore();
    const server = compileOperateServer(bare, {
      store,
      allocator: new InMemorySequenceAllocator(),
      principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
      segregationOfDuties: true,
    });
    const invoke = async (match: Parameters<Rig["invoke"]>[0], opts: Parameters<Rig["invoke"]>[1]) => {
      const spec = server.routeSpecs.find(match)!;
      const request = buildIncomingRequest({
        id: "req_ws00000002",
        receivedAt: "2026-06-03T12:00:00.000Z",
        method: spec.method,
        path: "/v1/x",
        headers: {},
        host: "api.example.com",
        scheme: "https",
        bodyBytes: null,
        clientIp: "203.0.113.1",
        edgeTrust: "untrusted",
      });
      return server.handlers.resolve(spec.operationId)!({
        request,
        route: routeFromSpec(spec),
        principal: principalFor(opts.caller ?? alice),
        params: opts.params ?? {},
        parsedBody: opts.body ?? null,
      });
    };
    const vendorId = body(await invoke(op("Vendor", "create"), { body: VENDOR }))["id"] as string;
    const created = await invoke(op("Bill", "create"), {
      body: { vendor_id: vendorId, bill_date: "2026-06-01", due_date: "2026-07-01", created_by: BOB },
    });
    expect(created.status).toBe(201);
    const id = body(created)["id"] as string;
    expect((await store.get(TENANT, "Bill", id))?.["created_by"]).toBe(BOB);
    const out = await invoke(transition("Bill", "approve"), { caller: alice, params: { id } });
    expect(body(out)["error"]).toBe(MAKER_CHECKER_ERRORS.unverifiable);
    expect(makerCheckerRefusal("Bill", "approve", { created_by: BOB }, ALICE, false)?.error).toBe(
      MAKER_CHECKER_ERRORS.unverifiable,
    );
  });
});

describe("the UI schema", () => {
  it("shows a server-stamped field read-only and leaves a sequence field and an ordinary one alone", () => {
    const surfaces = buildWriteSurfaces(CORE, defaultEffectStamps(CORE));
    const fields = buildUiSchema(CORE, new Date("2026-06-03T00:00:00Z"), surfaces).entities.find(
      (e) => e.name === "Invoice",
    )!.fields;
    const ro = (n: string) => fields.find((f) => f.name === n)?.readOnly;
    expect(ro("booking_rate")).toBe(true);
    expect(ro("withholding_total")).toBe(true);
    expect(ro("total")).toBeUndefined();
    // Read-only already, as a sequence field, for its own reason.
    expect(ro("invoice_number")).toBe(true);
    // Without the surfaces the field stays an input, which is the control.
    const bare = buildUiSchema(CORE, new Date("2026-06-03T00:00:00Z")).entities.find((e) => e.name === "Invoice")!.fields;
    expect(bare.find((f) => f.name === "booking_rate")?.readOnly).toBeUndefined();
  });

  it("shows a bill's stamped withholding and settlement date read-only", () => {
    const surfaces = buildWriteSurfaces(CORE, defaultEffectStamps(CORE));
    const fields = buildUiSchema(CORE, new Date("2026-06-03T00:00:00Z"), surfaces).entities.find(
      (e) => e.name === "Bill",
    )!.fields;
    const ro = (n: string) => fields.find((f) => f.name === n)?.readOnly;
    expect(ro("withholding_total")).toBe(true);
    expect(ro("paid_at")).toBe(true);
    expect(ro("total")).toBeUndefined();
  });
});
