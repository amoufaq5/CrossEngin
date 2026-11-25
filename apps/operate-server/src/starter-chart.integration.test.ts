import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Manifest } from "@crossengin/kernel";
import {
  compileOperateServer,
  ensureStarterChart,
  InMemoryEntityStore,
  InMemorySettingsStore,
  ReferenceNotFound,
  STARTER_ACCOUNTS_BY_SETTING,
  STARTER_CHART,
  type EntityRecord,
  type EntityWriteAuditEvent,
  type StarterChartReport,
  NO_TENANT_REGISTRY_STANDING,
  type SystemActor,
  type TenantSettings,
} from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { BUILTIN_PACK_NAMES, loadBuiltinPack } from "./manifest-source.js";

/**
 * The one reference the Postgres stores enforce that matters here (ADR-0423): a journal line must
 * name a ledger account that exists. The memory store enforces no reference, so without this a send
 * with no chart would post `accounts_receivable` as an account id and report success — which is what
 * `--store pg` did before ADR-0423 and is not what either deployed store does now.
 */
class LedgerReferenceStore extends InMemoryEntityStore {
  override async create(
    ...args: Parameters<InMemoryEntityStore["create"]>
  ): ReturnType<InMemoryEntityStore["create"]> {
    const [tenantId, entity, record] = args;
    if (entity === "JournalLine") {
      const id = record["ledger_account_id"];
      if (typeof id !== "string" || (await super.get(tenantId, "LedgerAccount", id)) === null) {
        throw new ReferenceNotFound("JournalLine", "ledger_account_id", "LedgerAccount");
      }
    }
    return super.create(...args);
  }
}

/**
 * The starter chart through the real create handler of each built-in pack (ADR-0465): what the
 * provisioning writes, what it records, and — on `erp-core` — the reason it exists, an invoice that
 * posts once the chart is there and is refused by name while it is not.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "99999999-9999-4999-8999-999999999999";
const PROVISIONING = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-11-23T10:00:00.000Z";

function provisioningActor(roles: readonly string[] = ["erp_admin"]): SystemActor {
  return {
    roles,
    origin: { kind: "provisioning", operation: "starter_chart", provisioningId: PROVISIONING },
    standing: NO_TENANT_REGISTRY_STANDING,
  };
}

async function harness(manifest: Manifest, settings?: TenantSettings) {
  const store = new LedgerReferenceStore();
  const settingsStore = new InMemorySettingsStore();
  if (settings !== undefined) await settingsStore.put(TENANT, settings);
  const audited: EntityWriteAuditEvent[] = [];
  const compiled = compileOperateServer(manifest, {
    store,
    settingsStore,
    principalRoles: (p: ResolvedPrincipal | null) => ({
      primaryRole: p?.grantedScopes[0] ?? "anonymous",
      secondaryRoles: p?.grantedScopes.slice(1) ?? [],
    }),
    entityAudit: { record: async (e) => void audited.push(e) },
    clock: { now: () => new Date(NOW) },
    segregationOfDuties: false,
  });
  const ensure = (roles?: readonly string[]): Promise<StarterChartReport> =>
    ensureStarterChart({
      access: compiled.systemEntityAccess,
      tenantId: TENANT,
      actor: provisioningActor(roles),
      settings: settingsStore,
      updatedBy: OPERATOR,
      taxRemittance: compiled.taxRemittance,
      requestRemittancePosting: true,
    });
  const rowsOf = (entity: string): Promise<EntityRecord[]> =>
    store.listPage(TENANT, entity, { limit: 500, cursor: null, sort: [], filters: [] }).then((p) => [...p.records]);
  const accounts = (): Promise<EntityRecord[]> => rowsOf("LedgerAccount");
  return { store, settingsStore, audited, compiled, ensure, accounts, rowsOf };
}

const CODES = STARTER_CHART.map((a) => a.code);
const SETTING_KEYS = Object.keys(STARTER_ACCOUNTS_BY_SETTING).sort();

describe.each(BUILTIN_PACK_NAMES.map((p) => [p]))("the starter chart on %s", (pack) => {
  it("creates the whole chart through the create handler and fills every account setting", async () => {
    const h = await harness(await loadBuiltinPack(pack));
    const report = await h.ensure();
    expect(report.outcome).toBe("complete");
    expect([...report.created].sort()).toEqual([...CODES].sort());
    expect(report.created).toHaveLength(21);
    expect(report.existing).toEqual([]);
    expect(report.refused).toEqual([]);
    expect([...report.settingsFilled].sort()).toEqual(SETTING_KEYS);
    expect(report.settingsFilled).toHaveLength(18);
    // Every built-in pack carries TaxReturn's reverse_payment, so the wiring is real on each and the
    // decision gets as far as the currency check, which this harness's settings do not satisfy
    // (ADR-0467). An unwired pack would stop one step earlier, at `skipped_unwired`.
    expect(report.remittancePosting).toBe("skipped_functional_currency_undeclared");
    expect(report.settingsSkipped).toEqual([]);
    expect(report.settingsDangling).toEqual([]);
    expect(report.settingsError).toBeUndefined();

    const rows = await h.accounts();
    expect(rows).toHaveLength(21);
    for (const row of rows) {
      expect(row["currency"]).toBe("USD");
      expect(row["status"]).toBe("active");
      expect(row["is_postable"]).toBe(true);
    }
    const settings = await h.settingsStore.get(TENANT);
    for (const [key, account] of Object.entries(STARTER_ACCOUNTS_BY_SETTING)) {
      expect((settings.finance as Record<string, unknown> | undefined)?.[key]).toBe(account.code);
    }

    expect(h.audited).toHaveLength(21);
    for (const e of h.audited) {
      expect(e.entity).toBe("LedgerAccount");
      expect(e.origin).toEqual({ kind: "provisioning", operation: "starter_chart", provisioningId: PROVISIONING });
    }
  });

  it("is idempotent: a second run creates nothing and fills nothing", async () => {
    const h = await harness(await loadBuiltinPack(pack));
    await h.ensure();
    const second = await h.ensure();
    expect(second.outcome).toBe("complete");
    expect(second.created).toEqual([]);
    expect([...second.existing]).toEqual([...CODES].sort());
    expect(second.settingsFilled).toEqual([]);
    expect(second.settingsSkipped).toEqual([]);
    expect(second.settingsDangling).toEqual([]);
    expect(await h.accounts()).toHaveLength(21);
    expect(h.audited).toHaveLength(21);
  });

  it("takes the tenant's default currency for every account", async () => {
    const h = await harness(await loadBuiltinPack(pack), { defaults: { currency: "EUR" } });
    expect((await h.ensure()).outcome).toBe("complete");
    for (const row of await h.accounts()) expect(row["currency"]).toBe("EUR");
  });
});

describe("the starter chart's refusals and settings", () => {
  it("a role without LedgerAccount create is refused per account, writes nothing, and fills nothing", async () => {
    const h = await harness(await loadBuiltinPack("erp-core"));
    const report = await h.ensure(["erp_viewer"]);
    // Every account refused and none existed: nothing is in place, so the run is refused, not partial.
    expect(report.outcome).toBe("refused");
    expect(report.created).toEqual([]);
    expect(report.existing).toEqual([]);
    expect(report.refused).toHaveLength(21);
    expect(report.refused.map((r) => r.code)).toEqual(CODES);
    for (const r of report.refused) expect(r).toMatchObject({ status: 403, error: "forbidden" });
    // A setting naming a code with no account would read as a remedy already applied.
    expect(report.settingsFilled).toEqual([]);
    expect(await h.accounts()).toEqual([]);
    expect((await h.settingsStore.get(TENANT)).finance).toBeUndefined();
    expect(h.audited).toEqual([]);
  });

  it("never replaces an account code the admin already chose, and leaves a renamed account alone", async () => {
    const h = await harness(await loadBuiltinPack("erp-core"), { finance: { arAccountCode: "1199" } });
    const access = h.compiled.systemEntityAccess.forTenant(TENANT, provisioningActor());
    const mine = await access.create("LedgerAccount", { account_code: "4000", name: "Fees", account_type: "revenue" });
    expect(mine.kind).toBe("written");
    const receivable = await access.create("LedgerAccount", {
      account_code: "1199",
      name: "Trade debtors",
      account_type: "asset",
    });
    expect(receivable.kind).toBe("written");
    const report = await h.ensure();
    expect(report.outcome).toBe("complete");
    expect(report.existing).toEqual(["4000"]);
    expect(report.created).toHaveLength(20);
    expect(report.settingsFilled).not.toContain("arAccountCode");
    expect(report.settingsFilled).toContain("revenueAccountCode");
    expect(report.settingsFilled).toHaveLength(17);
    expect(report.settingsSkipped).toEqual([]);
    expect(report.settingsDangling).toEqual([]);
    const finance = (await h.settingsStore.get(TENANT)).finance as Record<string, unknown>;
    expect(finance["arAccountCode"]).toBe("1199");
    const fees = (await h.accounts()).filter((a) => a["account_code"] === "4000");
    expect(fees).toHaveLength(1);
    expect(fees[0]?.["name"]).toBe("Fees");
  });

  it("does not point revenue at an existing 4000 that is an expense, and says why", async () => {
    const h = await harness(await loadBuiltinPack("erp-core"));
    const access = h.compiled.systemEntityAccess.forTenant(TENANT, provisioningActor());
    const theirs = await access.create("LedgerAccount", {
      account_code: "4000",
      name: "Rent",
      account_type: "expense",
    });
    expect(theirs.kind).toBe("written");
    const report = await h.ensure();
    expect(report.outcome).toBe("partial");
    expect(report.existing).toEqual(["4000"]);
    expect(report.created).toHaveLength(20);
    expect(report.refused).toEqual([]);
    expect(report.settingsSkipped).toEqual([{ key: "revenueAccountCode", code: "4000", reason: "type_mismatch" }]);
    expect(report.settingsFilled).not.toContain("revenueAccountCode");
    expect(report.settingsFilled).toHaveLength(17);
    expect(report.settingsDangling).toEqual([]);
    const finance = (await h.settingsStore.get(TENANT)).finance as Record<string, unknown>;
    expect(finance["revenueAccountCode"]).toBeUndefined();
  });

  it("does point revenue at an existing 4000 that is a revenue account", async () => {
    const h = await harness(await loadBuiltinPack("erp-core"));
    const access = h.compiled.systemEntityAccess.forTenant(TENANT, provisioningActor());
    const theirs = await access.create("LedgerAccount", {
      account_code: "4000",
      name: "Fees",
      account_type: "revenue",
    });
    expect(theirs.kind).toBe("written");
    const report = await h.ensure();
    expect(report.outcome).toBe("complete");
    expect(report.settingsSkipped).toEqual([]);
    expect(report.settingsFilled).toContain("revenueAccountCode");
    const finance = (await h.settingsStore.get(TENANT)).finance as Record<string, unknown>;
    expect(finance["revenueAccountCode"]).toBe("4000");
  });

  it("reports an admin-set code that names no account as dangling, and the run as partial", async () => {
    const h = await harness(await loadBuiltinPack("erp-core"), { finance: { arAccountCode: "AR" } });
    const report = await h.ensure();
    expect(report.outcome).toBe("partial");
    expect(report.created).toHaveLength(21);
    expect(report.refused).toEqual([]);
    expect(report.settingsSkipped).toEqual([]);
    expect(report.settingsDangling).toEqual([{ key: "arAccountCode", code: "AR" }]);
    expect(report.settingsFilled).not.toContain("arAccountCode");
    expect(report.settingsFilled).toHaveLength(17);
    const finance = (await h.settingsStore.get(TENANT)).finance as Record<string, unknown>;
    expect(finance["arAccountCode"]).toBe("AR");
  });
});

describe("an invoice on erp-core, with and without the starter chart", () => {
  async function sendInvoice(h: Awaited<ReturnType<typeof harness>>) {
    const access = h.compiled.systemEntityAccess.forTenant(TENANT, provisioningActor());
    const account = await access.create("Account", { name: "Acme", billing_email: "billing@acme.test" });
    if (account.kind !== "written") throw new Error(`account refused: ${account.error}`);
    const invoice = await access.create("Invoice", {
      account_id: String(account.record?.["id"]),
      currency: "USD",
      issue_date: "2026-11-23",
      due_date: "2026-12-23",
      subtotal: 100,
      total: 100,
    });
    if (invoice.kind !== "written") throw new Error(`invoice refused: ${invoice.error}`);
    const id = String(invoice.record?.["id"]);
    return { id, sent: await access.transition("Invoice", id, "send") };
  }

  it("posts to the chart's receivable and revenue accounts once the chart exists", async () => {
    const h = await harness(await loadBuiltinPack("erp-core"));
    expect((await h.ensure()).outcome).toBe("complete");
    const byCode = new Map((await h.accounts()).map((a) => [String(a["account_code"]), String(a["id"])]));

    const { sent } = await sendInvoice(h);
    expect(sent).toMatchObject({ kind: "written", status: 200 });
    const lines = await h.rowsOf("JournalLine");
    expect(lines).toHaveLength(2);
    const debit = lines.find((l) => l["debit"] === "100.00");
    const credit = lines.find((l) => l["credit"] === "100.00");
    expect(debit?.["ledger_account_id"]).toBe(byCode.get("1100"));
    expect(credit?.["ledger_account_id"]).toBe(byCode.get("4000"));
  });

  it("is refused by name without the chart, and nothing is posted or moved", async () => {
    const h = await harness(await loadBuiltinPack("erp-core"));
    const { id, sent } = await sendInvoice(h);
    expect(sent).toMatchObject({ kind: "refused", status: 409, error: "server_reference_unresolved" });
    expect(await h.rowsOf("JournalLine")).toEqual([]);
    expect(await h.rowsOf("JournalEntry")).toEqual([]);
    expect((await h.store.get(TENANT, "Invoice", id))?.["state"]).toBe("draft");
  });
});
