import { describe, expect, it } from "vitest";

import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler } from "@crossengin/api-gateway-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";

import { compileOperateServer } from "./compile.js";
import type { EntityWriteAuditEvent } from "./entity-audit.js";
import { ReadCeilingExceeded } from "./list-drain.js";
import { InMemoryEntityStore } from "./store.js";
import { systemWriteOriginOf, type SystemActor } from "./system-writer.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-03-01T01:00:00.000Z");

const ACTOR: SystemActor = {
  roles: ["erp_admin"],
  origin: { kind: "job", jobId: "erp-core-depreciation-run", runId: "8b1a9953-c461-4b6d-9f3e-0c5a2f7d41aa" },
};

function setup() {
  const store = new InMemoryEntityStore();
  const audited: EntityWriteAuditEvent[] = [];
  const compiled = compileOperateServer(buildErpCorePack(), {
    store,
    principalRoles: (p: ResolvedPrincipal | null) => ({
      primaryRole: p?.grantedScopes[0] ?? "anonymous",
      secondaryRoles: p?.grantedScopes.slice(1) ?? [],
    }),
    entityAudit: { record: async (e) => void audited.push(e) },
    clock: { now: () => NOW },
  });
  return { store, compiled, audited, access: compiled.systemEntityAccess.forTenant(TENANT, ACTOR) };
}

async function ledger(access: ReturnType<typeof setup>["access"], code: string, type: string): Promise<string> {
  const r = await access.create("LedgerAccount", { account_code: code, name: code, account_type: type });
  if (r.kind !== "written" || r.record === null) throw new Error(`ledger ${code}: ${JSON.stringify(r)}`);
  return r.record["id"] as string;
}

describe("buildSystemEntityAccess — a background write runs the request pipeline", () => {
  it("refuses to post an unbalanced journal entry: the double-entry guard is not behind it", async () => {
    const { access } = setup();
    const dr = await ledger(access, "6100", "expense");
    const cr = await ledger(access, "1590", "asset");
    const je = await access.create("JournalEntry", { entry_date: "2026-02-28", source: "depreciation" });
    expect(je.kind).toBe("written");
    const id = (je.kind === "written" ? je.record?.["id"] : null) as string;
    await access.create("JournalLine", { journal_entry_id: id, ledger_account_id: dr, debit: "100.00", credit: "0" });
    await access.create("JournalLine", { journal_entry_id: id, ledger_account_id: cr, debit: "0", credit: "90.00" });
    const posted = await access.transition("JournalEntry", id, "post");
    expect(posted).toMatchObject({ kind: "refused", status: 422, operationId: "journalEntry.post" });
    expect((await access.read("JournalEntry", id))?.["state"]).toBe("draft");
  });

  it("posts a balanced one and moves the state by the transition", async () => {
    const { access } = setup();
    const dr = await ledger(access, "6100", "expense");
    const cr = await ledger(access, "1590", "asset");
    const je = await access.create("JournalEntry", { entry_date: "2026-02-28", source: "depreciation" });
    const id = (je.kind === "written" ? je.record?.["id"] : null) as string;
    await access.create("JournalLine", { journal_entry_id: id, ledger_account_id: dr, debit: "100.00", credit: "0" });
    await access.create("JournalLine", { journal_entry_id: id, ledger_account_id: cr, debit: "0", credit: "100.00" });
    const posted = await access.transition("JournalEntry", id, "post");
    expect(posted.kind).toBe("written");
    expect((await access.read("JournalEntry", id))?.["state"]).toBe("posted");
  });

  it("applies the lifecycle rule: a state may not be written on create", async () => {
    const { access } = setup();
    const r = await access.create("JournalEntry", { entry_date: "2026-02-28", state: "posted" });
    expect(r).toMatchObject({ kind: "refused", status: 422, error: "lifecycle_state_not_initial" });
  });

  it("is authorized by the actor's roles through the manifest's grants, not exempted", async () => {
    const { compiled } = setup();
    const viewer = compiled.systemEntityAccess.forTenant(TENANT, { ...ACTOR, roles: ["erp_viewer"] });
    const r = await viewer.create("LedgerAccount", { account_code: "1000", name: "Cash", account_type: "asset" });
    expect(r).toMatchObject({ kind: "refused", status: 403, error: "forbidden" });
  });

  it("files the write under the job and names no person", async () => {
    const { access, audited } = setup();
    const r = await access.create("LedgerAccount", { account_code: "1000", name: "Cash", account_type: "asset" });
    expect(r.kind).toBe("written");
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actorUserId: null, origin: ACTOR.origin, operationId: "ledgerAccount.create" });
    const record = r.kind === "written" ? r.record : null;
    expect(record?.["created_by"] ?? null).toBeNull();
  });

  it("carries the origin on a transition's audit record too", async () => {
    const { access, audited } = setup();
    const dr = await ledger(access, "6100", "expense");
    const cr = await ledger(access, "1590", "asset");
    const je = await access.create("JournalEntry", { entry_date: "2026-02-28" });
    const id = (je.kind === "written" ? je.record?.["id"] : null) as string;
    await access.create("JournalLine", { journal_entry_id: id, ledger_account_id: dr, debit: "5.00", credit: "0" });
    await access.create("JournalLine", { journal_entry_id: id, ledger_account_id: cr, debit: "0", credit: "5.00" });
    await access.transition("JournalEntry", id, "post");
    const transition = audited.find((e) => e.action === "transition");
    expect(transition?.origin).toEqual(ACTOR.origin);
  });

  it("gives a principal it did not mint no origin, whatever its kind", () => {
    const forged: ResolvedPrincipal = {
      principalId: "00000000-0000-0000-0000-000000000000",
      tenantId: TENANT,
      principalKind: "system",
      authScheme: "anonymous",
      grantedScopes: ["erp_admin"],
      mfaProofAgeSeconds: null,
      resolvedAt: NOW.toISOString(),
    };
    expect(systemWriteOriginOf(forged)).toBeNull();
    expect(systemWriteOriginOf(null)).toBeNull();
  });

  it("resolves the handler at call time, so a decoration applied after compile is honoured", async () => {
    const { compiled, access } = setup();
    const refused: Handler = () => ({ kind: "json", status: 403, body: { error: "tenant_read_only", detail: "suspended" } });
    compiled.handlers.register("ledgerAccount.create", refused);
    const r = await access.create("LedgerAccount", { account_code: "1000", name: "Cash", account_type: "asset" });
    expect(r).toMatchObject({ kind: "refused", status: 403, error: "tenant_read_only", detail: "suspended" });
  });

  it("answers an operation the server does not serve as a refusal, and says so through serves()", async () => {
    const { compiled, access } = setup();
    expect(compiled.systemEntityAccess.serves("Invoice", { transition: "mark_overdue" })).toBe(true);
    expect(compiled.systemEntityAccess.serves("Invoice", { transition: "teleport" })).toBe(false);
    expect(compiled.systemEntityAccess.serves("Nope", "create")).toBe(false);
    const r = await access.transition("Invoice", "inv-1", "teleport");
    expect(r).toMatchObject({ kind: "refused", status: 404, error: "operation_not_served" });
  });

  it("keeps reads and writes inside the bound tenant", async () => {
    const { compiled, access } = setup();
    await ledger(access, "1000", "asset");
    const other = compiled.systemEntityAccess.forTenant(OTHER, ACTOR);
    expect(await other.readAll("LedgerAccount", {}, { ceiling: 100, computing: "x" })).toHaveLength(0);
    expect(await access.readAll("LedgerAccount", {}, { ceiling: 100, computing: "x" })).toHaveLength(1);
  });

  it("filters a read, and refuses to hand back a prefix past the ceiling", async () => {
    const { access } = setup();
    await ledger(access, "1000", "asset");
    await ledger(access, "1100", "asset");
    await ledger(access, "4000", "revenue");
    const assets = await access.readAll(
      "LedgerAccount",
      { filters: [{ field: "account_type", value: "asset" }] },
      { ceiling: 100, computing: "assets" },
    );
    expect(assets.map((a) => a["account_code"]).sort()).toEqual(["1000", "1100"]);
    await expect(access.readAll("LedgerAccount", {}, { ceiling: 2, computing: "all accounts" })).rejects.toBeInstanceOf(
      ReadCeilingExceeded,
    );
  });

  it("refuses an actor with no role, since no grant could name it", () => {
    const { compiled } = setup();
    expect(() => compiled.systemEntityAccess.forTenant(TENANT, { ...ACTOR, roles: [] })).toThrow(/at least one role/);
  });
});
