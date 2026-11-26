import { describe, expect, it } from "vitest";

import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import type { Entity } from "@crossengin/types/meta-schema";

import { compileOperateServer } from "./compile.js";
import { ReadCeilingExceeded } from "./list-drain.js";
import {
  FINANCE_ACCOUNT_CODE_KEYS,
  FinanceSettingsSchema,
  InMemorySettingsStore,
  type FinanceAccountCodeFiller,
  type FinanceAccountCodeKey,
  type SettingsStore,
} from "./settings.js";
import {
  ensureStarterChart,
  formatStarterChartActorCapability,
  starterChartActorCapability,
  STARTER_ACCOUNT_TYPES,
  STARTER_ACCOUNTS_BY_SETTING,
  STARTER_ACCOUNTS_WITHOUT_SETTING,
  STARTER_CHART,
  STARTER_CHART_ENTITY,
  STARTER_CHART_OUTCOMES,
  STARTER_CHART_VERSION,
  STARTER_REMITTANCE_POSTING_OUTCOMES,
  type StarterChartReport,
} from "./starter-chart.js";
import type { TaxRemittanceWiring } from "./tax-remittance.js";
import type { EntityRecord } from "./store.js";
import { InMemoryEntityStore } from "./store.js";
import {
  NO_TENANT_REGISTRY_STANDING,
  type SystemActor,
  type SystemEntityAccess,
  type SystemReadQuery,
  type SystemWriteResult,
  type TenantEntityAccess,
} from "./system-writer.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTOR: SystemActor = {
  roles: ["erp_admin"],
  origin: { kind: "provisioning", operation: "starter_chart", provisioningId: "areq_0001" },
  standing: NO_TENANT_REGISTRY_STANDING,
};

function ledgerAccountEntity(): Entity {
  const entity = (buildErpCorePack().entities ?? []).find((e) => e.name === STARTER_CHART_ENTITY);
  if (entity === undefined) throw new Error("erp-core declares no LedgerAccount");
  return entity;
}

const CODES = STARTER_CHART.map((a) => a.code);
const SCHEMA_KEYS = Object.keys(FinanceSettingsSchema.shape)
  .filter((k) => k.endsWith("AccountCode"))
  .sort();
const codeOf = (key: FinanceAccountCodeKey): string => STARTER_ACCOUNTS_BY_SETTING[key].code;
const typeOfCode = (code: string): string => STARTER_CHART.find((a) => a.code === code)?.accountType ?? "asset";

/** A stored account as the real create handler leaves it: defaults applied. */
function account(code: string, overrides: Readonly<Record<string, unknown>> = {}): EntityRecord {
  return {
    id: `rec_${code}_${Math.random().toString(36).slice(2, 8)}`,
    account_code: code,
    name: `Account ${code}`,
    account_type: typeOfCode(code),
    currency: "USD",
    is_postable: true,
    status: "active",
    ...overrides,
  };
}

interface FakeOptions {
  readonly serves?: boolean;
  readonly seed?: readonly EntityRecord[];
  readonly results?: Readonly<Record<string, SystemWriteResult>>;
  /** A read that throws, by its position in this run (0 the first read, 1 the re-read, 2 the extra read). */
  readonly readErrors?: Readonly<Record<number, Error>>;
  /** Runs before the read at that position: a concurrent writer acting between reads. */
  readonly beforeRead?: (index: number, rows: EntityRecord[]) => void;
  /** Fields the fake's created rows carry beyond the body. */
  readonly createdExtras?: Readonly<Record<string, unknown>>;
  /** Tax returns the tenant holds, answered by a TaxReturn read's state in-filter. */
  readonly taxReturns?: readonly EntityRecord[];
  readonly taxReturnReadError?: Error;
  /** Whether the deployment serves a TaxReturn create; default true. */
  readonly servesTaxReturn?: boolean;
}

function fakeAccess(options: FakeOptions = {}) {
  const bodies: Record<string, unknown>[] = [];
  const reads: SystemReadQuery[] = [];
  const taxReturnReads: { query: SystemReadQuery; ceiling: number }[] = [];
  const tenants: string[] = [];
  const actors: SystemActor[] = [];
  const rows: EntityRecord[] = [...(options.seed ?? [])];
  let readIndex = 0;
  const tenantAccess = (tenantId: string): TenantEntityAccess => ({
    tenantId,
    assertWritable: () => Promise.resolve(),
    create(entity, body) {
      expect(entity).toBe(STARTER_CHART_ENTITY);
      bodies.push({ ...body });
      const code = String(body["account_code"]);
      const scripted = options.results?.[code];
      if (scripted !== undefined) return Promise.resolve(scripted);
      const record = { ...account(code), ...body, ...(options.createdExtras ?? {}) };
      rows.push(record);
      return Promise.resolve({ kind: "written", status: 201, record });
    },
    update: () => Promise.reject(new Error("the starter chart must not update")),
    transition: () => Promise.reject(new Error("the starter chart must not transition")),
    read: () => Promise.reject(new Error("the starter chart reads with readAll")),
    readAll(entity, query, bounds) {
      if (entity === "TaxReturn") {
        taxReturnReads.push({ query, ceiling: bounds.ceiling });
        if (options.taxReturnReadError !== undefined) return Promise.reject(options.taxReturnReadError);
        const filter = query.filters?.[0];
        const wanted = new Set(Array.isArray(filter?.value) ? filter.value.map(String) : []);
        const field = filter?.field ?? "";
        return Promise.resolve((options.taxReturns ?? []).filter((r) => wanted.has(String(r[field]))));
      }
      expect(entity).toBe(STARTER_CHART_ENTITY);
      const index = readIndex;
      readIndex += 1;
      reads.push(query);
      options.beforeRead?.(index, rows);
      const error = options.readErrors?.[index];
      if (error !== undefined) return Promise.reject(error);
      const filter = query.filters?.[0];
      const wanted = new Set(Array.isArray(filter?.value) ? filter.value.map(String) : []);
      return Promise.resolve(rows.filter((r) => wanted.has(String(r["account_code"]))));
    },
  });
  const access: SystemEntityAccess = {
    serves: (entity, operation) =>
      operation === "create" &&
      ((entity === STARTER_CHART_ENTITY && (options.serves ?? true)) ||
        (entity === "TaxReturn" && (options.servesTaxReturn ?? true))),
    forTenant(tenantId, actor) {
      tenants.push(tenantId);
      actors.push(actor);
      return tenantAccess(tenantId);
    },
  };
  return { access, bodies, reads, taxReturnReads, tenants, actors, rows };
}

function refusal(status: number, error: string): SystemWriteResult {
  return { kind: "refused", status, error, detail: null, operationId: "ledgerAccount.create" };
}

type ChartSettings = FinanceAccountCodeFiller & Pick<SettingsStore, "get">;

/** A filler double with an empty settings document to read. */
function filler(fill: FinanceAccountCodeFiller["fillUnsetFinanceAccountCodes"]): ChartSettings {
  return { fillUnsetFinanceAccountCodes: fill, get: () => Promise.resolve({}) };
}

async function run(
  fake: ReturnType<typeof fakeAccess>,
  settings: ChartSettings = new InMemorySettingsStore(),
  taxRemittance?: TaxRemittanceWiring | null,
  requestRemittancePosting = true,
): Promise<StarterChartReport> {
  return ensureStarterChart({
    access: fake.access,
    tenantId: TENANT,
    actor: ACTOR,
    settings,
    updatedBy: null,
    requestRemittancePosting,
    ...(taxRemittance !== undefined ? { taxRemittance } : {}),
  });
}

describe("the starter chart", () => {
  it("maps exactly the finance settings that name an account, read off the schema both ways", () => {
    expect(Object.keys(STARTER_ACCOUNTS_BY_SETTING).sort()).toEqual(SCHEMA_KEYS);
    expect([...FINANCE_ACCOUNT_CODE_KEYS].sort()).toEqual(SCHEMA_KEYS);
    expect(SCHEMA_KEYS).toHaveLength(18);
  });

  it("holds 21 accounts with unique four-digit codes that fit the account_code column", () => {
    const field = ledgerAccountEntity().fields.find((f) => f.name === "account_code");
    const maxLength = field?.type.kind === "text" ? field.type.maxLength : undefined;
    expect(maxLength).toBe(32);
    expect(STARTER_CHART).toHaveLength(SCHEMA_KEYS.length + STARTER_ACCOUNTS_WITHOUT_SETTING.length);
    expect(STARTER_CHART).toHaveLength(21);
    expect(new Set(CODES).size).toBe(21);
    for (const code of CODES) {
      expect(code).toMatch(/^[0-9]{4}$/);
      expect(code.length).toBeLessThanOrEqual(maxLength ?? 0);
    }
  });

  it("serves withholding tax payable from its own liability account, apart from output tax", () => {
    expect(STARTER_ACCOUNTS_BY_SETTING.whtPayableAccountCode).toEqual({
      code: "2210",
      name: "Withholding tax payable",
      accountType: "liability",
    });
    expect(STARTER_ACCOUNTS_BY_SETTING.taxPayableAccountCode).toMatchObject({ code: "2200", accountType: "liability" });
    expect(STARTER_ACCOUNTS_BY_SETTING.taxInputAccountCode.accountType).toBe("asset");
  });

  it("gives no two settings one account", () => {
    const codes = Object.values(STARTER_ACCOUNTS_BY_SETTING).map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    const unmapped = STARTER_ACCOUNTS_WITHOUT_SETTING.map((a) => a.code);
    expect(unmapped.filter((c) => codes.includes(c))).toEqual([]);
    expect(codes.length + unmapped.length).toBe(STARTER_CHART.length);
  });

  it("uses only the account types erp-core's LedgerAccount declares, and is sorted by code", () => {
    const field = ledgerAccountEntity().fields.find((f) => f.name === "account_type");
    const declared = field?.type.kind === "enum" ? field.type.values : [];
    expect([...STARTER_ACCOUNT_TYPES].sort()).toEqual([...declared].sort());
    for (const a of STARTER_CHART) expect(STARTER_ACCOUNT_TYPES).toContain(a.accountType);
    expect(CODES).toEqual([...CODES].sort((a, b) => a.localeCompare(b)));
  });

  it("names every account", () => {
    for (const a of STARTER_CHART) expect(a.name.trim().length).toBeGreaterThan(0);
  });
});

describe("ensureStarterChart", () => {
  it("creates all 21 accounts for a fresh tenant and points all 18 settings at them", async () => {
    const fake = fakeAccess();
    const settings = new InMemorySettingsStore();
    const report = await run(fake, settings);
    expect(report).toEqual({
      outcome: "complete",
      version: STARTER_CHART_VERSION,
      created: CODES,
      existing: [],
      refused: [],
      settingsFilled: [...FINANCE_ACCOUNT_CODE_KEYS],
      remittancePosting: "skipped_unwired",
      settingsSkipped: [],
      settingsDangling: [],
    });
    expect(report.settingsFilled).toHaveLength(18);
    const finance = (await settings.get(TENANT)).finance ?? {};
    for (const key of FINANCE_ACCOUNT_CODE_KEYS) expect(finance[key]).toBe(codeOf(key));
    expect(fake.tenants).toEqual([TENANT]);
    expect(fake.actors).toEqual([ACTOR]);
  });

  it("sends the code, name and type and leaves currency to the handler's default", async () => {
    const fake = fakeAccess();
    await run(fake);
    expect(fake.bodies).toHaveLength(21);
    for (const body of fake.bodies) {
      expect(Object.keys(body).sort()).toEqual(["account_code", "account_type", "name"]);
    }
    expect(fake.bodies[0]).toEqual({ account_code: "1000", name: "Cash and bank", account_type: "asset" });
  });

  it("reads the chart codes before writing and again after, each with one in-filter", async () => {
    const fake = fakeAccess();
    await run(fake);
    const chartRead = { filters: [{ field: "account_code", op: "in", value: CODES }] };
    expect(fake.reads).toEqual([chartRead, chartRead]);
  });

  it("leaves a usable existing code alone, does not recreate it, and points its setting at it", async () => {
    const fake = fakeAccess({ seed: [account("1100"), account("4000")] });
    const report = await run(fake);
    expect(report.outcome).toBe("complete");
    expect(report.existing).toEqual(["1100", "4000"]);
    expect(report.created).toHaveLength(19);
    const sent = fake.bodies.map((b) => b["account_code"]);
    expect(sent).not.toContain("1100");
    expect(sent).not.toContain("4000");
    expect(report.settingsFilled).toEqual(expect.arrayContaining(["arAccountCode", "revenueAccountCode"]));
  });

  it("is refused when every create is refused and nothing existed", async () => {
    const results = Object.fromEntries(CODES.map((c) => [c, refusal(403, "forbidden")]));
    const settings = new InMemorySettingsStore();
    const report = await run(fakeAccess({ results }), settings);
    expect(report.outcome).toBe("refused");
    expect(report.created).toEqual([]);
    expect(report.existing).toEqual([]);
    expect(report.refused).toHaveLength(21);
    expect(report.refused[0]).toEqual({ code: "1000", status: 403, error: "forbidden" });
    expect(report.settingsFilled).toEqual([]);
    expect(await settings.get(TENANT)).toEqual({});
  });

  it("is partial, not refused, when every create is refused but one code already existed", async () => {
    const results = Object.fromEntries(CODES.filter((c) => c !== "1100").map((c) => [c, refusal(403, "forbidden")]));
    const report = await run(fakeAccess({ seed: [account("1100")], results }));
    expect(report.outcome).toBe("partial");
    expect(report.existing).toEqual(["1100"]);
    expect(report.settingsFilled).toEqual(["arAccountCode"]);
  });

  it.each([
    [402, "subscription_required"],
    [403, "forbidden"],
    [422, "validation_failed"],
  ])("reports a %s refusal as partial and fills no setting for that account", async (status, error) => {
    const settings = new InMemorySettingsStore();
    const report = await run(fakeAccess({ results: { "1100": refusal(status, error) } }), settings);
    expect(report.outcome).toBe("partial");
    expect(report.refused).toEqual([{ code: "1100", status, error }]);
    expect(report.created).toHaveLength(20);
    expect(report.settingsFilled).not.toContain("arAccountCode");
    expect(report.settingsFilled).toHaveLength(17);
    expect((await settings.get(TENANT)).finance?.arAccountCode).toBeUndefined();
  });

  it("counts a 409 unique_violation as existing when the re-read finds the code", async () => {
    const fake = fakeAccess({
      results: { "2000": refusal(409, "unique_violation") },
      beforeRead: (index, rows) => {
        if (index === 1) rows.push(account("2000"));
      },
    });
    const settings = new InMemorySettingsStore();
    const report = await run(fake, settings);
    expect(report.outcome).toBe("complete");
    expect(report.existing).toEqual(["2000"]);
    expect(report.created).not.toContain("2000");
    expect(report.refused).toEqual([]);
    expect((await settings.get(TENANT)).finance?.apAccountCode).toBe("2000");
  });

  it("refuses a 409 unique_violation the re-read does not find, and fills no setting for it", async () => {
    const settings = new InMemorySettingsStore();
    const report = await run(fakeAccess({ results: { "2000": refusal(409, "unique_violation") } }), settings);
    expect(report.outcome).toBe("partial");
    expect(report.refused).toEqual([{ code: "2000", status: 409, error: "unique_violation" }]);
    expect(report.existing).toEqual([]);
    expect(report.settingsFilled).not.toContain("apAccountCode");
    expect((await settings.get(TENANT)).finance?.apAccountCode).toBeUndefined();
  });

  it("treats a 409 that is not a unique violation as a refusal even if the code exists", async () => {
    const fake = fakeAccess({
      results: { "2000": refusal(409, "state_changed") },
      beforeRead: (index, rows) => {
        if (index === 1) rows.push(account("2000"));
      },
    });
    const report = await run(fake);
    expect(report.outcome).toBe("partial");
    expect(report.refused).toEqual([{ code: "2000", status: 409, error: "state_changed" }]);
  });

  it.each([
    ["type_mismatch", account("4000", { account_type: "expense" })],
    ["archived", account("4000", { status: "archived" })],
    ["not_postable", account("4000", { is_postable: false })],
  ] as const)("skips a setting whose existing account is %s, and fills the rest", async (reason, existing) => {
    const settings = new InMemorySettingsStore();
    const report = await run(fakeAccess({ seed: [existing] }), settings);
    expect(report.outcome).toBe("partial");
    expect(report.existing).toEqual(["4000"]);
    expect(report.settingsSkipped).toEqual([{ key: "revenueAccountCode", code: "4000", reason }]);
    expect(report.settingsFilled).not.toContain("revenueAccountCode");
    expect(report.settingsFilled).toHaveLength(17);
    expect((await settings.get(TENANT)).finance?.revenueAccountCode).toBeUndefined();
  });

  it("skips a setting whose code two accounts carry, as duplicated", async () => {
    const settings = new InMemorySettingsStore();
    const report = await run(fakeAccess({ seed: [account("1100"), account("1100")] }), settings);
    expect(report.outcome).toBe("partial");
    expect(report.settingsSkipped).toEqual([{ key: "arAccountCode", code: "1100", reason: "duplicated" }]);
    expect((await settings.get(TENANT)).finance?.arAccountCode).toBeUndefined();
  });

  it("does not report a skipped setting an admin had already set", async () => {
    const settings = new InMemorySettingsStore();
    await settings.put(TENANT, { finance: { revenueAccountCode: "REV" } });
    const fake = fakeAccess({ seed: [account("4000", { account_type: "expense" }), account("REV", { account_type: "revenue" })] });
    const report = await run(fake, settings);
    expect(report.settingsSkipped).toEqual([]);
    expect(report.settingsDangling).toEqual([]);
    expect(report.outcome).toBe("complete");
    expect((await settings.get(TENANT)).finance?.revenueAccountCode).toBe("REV");
  });

  it("fills a setting for a code this run created whatever the stored row says", async () => {
    const fake = fakeAccess({ createdExtras: { is_postable: false, status: "archived" } });
    const report = await run(fake);
    expect(report.outcome).toBe("complete");
    expect(report.settingsSkipped).toEqual([]);
    expect(report.settingsFilled).toHaveLength(18);
  });

  it("does nothing at all when the deployment serves no LedgerAccount create", async () => {
    const fake = fakeAccess({ serves: false });
    let asked = false;
    const report = await run(
      fake,
      filler(() => {
        asked = true;
        return Promise.resolve({ filled: [], inEffect: {} });
      }),
    );
    expect(report).toEqual({
      outcome: "not_served",
      version: STARTER_CHART_VERSION,
      created: [],
      existing: [],
      refused: [],
      settingsFilled: [],
      remittancePosting: null,
      settingsSkipped: [],
      settingsDangling: null,
    });
    expect(fake.tenants).toEqual([]);
    expect(fake.reads).toEqual([]);
    expect(fake.bodies).toEqual([]);
    expect(asked).toBe(false);
  });

  it("writes nothing when the first read is past the ceiling", async () => {
    const fake = fakeAccess({ readErrors: { 0: new ReadCeilingExceeded(STARTER_CHART_ENTITY, 1000, "x") } });
    const settings = new InMemorySettingsStore();
    const report = await run(fake, settings);
    expect(report.outcome).toBe("duplicates_present");
    expect(report.created).toEqual([]);
    expect(report.settingsFilled).toEqual([]);
    expect(fake.bodies).toEqual([]);
    expect(await settings.get(TENANT)).toEqual({});
  });

  it("keeps what it created and fills nothing when the re-read is past the ceiling", async () => {
    const fake = fakeAccess({ readErrors: { 1: new ReadCeilingExceeded(STARTER_CHART_ENTITY, 1000, "x") } });
    const settings = new InMemorySettingsStore();
    const report = await run(fake, settings);
    expect(report.outcome).toBe("duplicates_present");
    expect(report.created).toEqual(CODES);
    expect(report.settingsFilled).toEqual([]);
    expect(report.settingsDangling).toBeNull();
    expect(await settings.get(TENANT)).toEqual({});
  });

  it("keeps the existing codes and the refusals it had when the re-read is past the ceiling", async () => {
    const fake = fakeAccess({
      seed: [account("1100")],
      results: { "4000": refusal(422, "validation_failed") },
      readErrors: { 1: new ReadCeilingExceeded(STARTER_CHART_ENTITY, 1000, "x") },
    });
    const report = await run(fake);
    expect(report.outcome).toBe("duplicates_present");
    expect(report.existing).toEqual(["1100"]);
    expect(report.refused).toEqual([{ code: "4000", status: 422, error: "validation_failed" }]);
    expect(report.created).toHaveLength(19);
  });

  it("keeps a 409 a refusal when there is no re-read to say the code exists", async () => {
    const fake = fakeAccess({
      results: { "1000": refusal(409, "unique_violation") },
      readErrors: { 1: new ReadCeilingExceeded(STARTER_CHART_ENTITY, 1000, "x") },
    });
    const report = await run(fake);
    expect(report.existing).toEqual([]);
    expect(report.refused).toEqual([{ code: "1000", status: 409, error: "unique_violation" }]);
  });

  it("reports a code removed between the two reads as absent, and the run as partial", async () => {
    const fake = fakeAccess({
      seed: [account("1100")],
      beforeRead: (index, rows) => {
        if (index !== 1) return;
        const at = rows.findIndex((r) => r["account_code"] === "1100");
        if (at >= 0) rows.splice(at, 1);
      },
    });
    const settings = new InMemorySettingsStore();
    const report = await run(fake, settings);
    expect(report.outcome).toBe("partial");
    expect(report.settingsSkipped).toEqual([{ key: "arAccountCode", code: "1100", reason: "absent" }]);
    expect(report.settingsFilled).not.toContain("arAccountCode");
    expect((await settings.get(TENANT)).finance?.arAccountCode).toBeUndefined();
  });

  it("is not complete while any finance setting is unset, even with nothing skipped", async () => {
    const settings = filler((_t, codes) => {
      const inEffect: Partial<Record<FinanceAccountCodeKey, string>> = { ...codes };
      delete inEffect.cashAccountCode;
      return Promise.resolve({ filled: Object.keys(inEffect) as FinanceAccountCodeKey[], inEffect });
    });
    const report = await run(fakeAccess(), settings);
    expect(report.refused).toEqual([]);
    expect(report.settingsSkipped).toEqual([]);
    expect(report.settingsDangling).toEqual([]);
    expect(report.outcome).toBe("partial");
  });

  it("lets any other read failure propagate, having written nothing", async () => {
    const fake = fakeAccess({ readErrors: { 0: new Error("connection reset") } });
    const settings = new InMemorySettingsStore();
    await expect(run(fake, settings)).rejects.toThrow("connection reset");
    expect(fake.bodies).toEqual([]);
    expect(await settings.get(TENANT)).toEqual({});
  });

  it("reports settings_unwritten with the error's name and never its message", async () => {
    class SettingsRowUnreadable extends Error {
      constructor() {
        super("row holds secret-account-9999");
        this.name = "SettingsRowUnreadable";
      }
    }
    const fake = fakeAccess({ seed: [account("1000")], results: { "1100": refusal(403, "forbidden") } });
    const report = await run(
      fake,
      filler(() => Promise.reject(new SettingsRowUnreadable())),
    );
    expect(report.outcome).toBe("settings_unwritten");
    expect(report.settingsError).toBe("SettingsRowUnreadable");
    expect(report.existing).toEqual(["1000"]);
    expect(report.created).toHaveLength(19);
    expect(report.refused).toEqual([{ code: "1100", status: 403, error: "forbidden" }]);
    expect(report.settingsFilled).toEqual([]);
    expect(report.settingsDangling).toBeNull();
    expect(JSON.stringify(report)).not.toContain("secret-account-9999");
  });

  it("reports an admin-set code that names no account as dangling, and the run as partial", async () => {
    const settings = new InMemorySettingsStore();
    await settings.put(TENANT, { finance: { arAccountCode: "AR" } });
    const fake = fakeAccess();
    const report = await run(fake, settings);
    expect(report.outcome).toBe("partial");
    expect(report.settingsDangling).toEqual([{ key: "arAccountCode", code: "AR" }]);
    expect(report.refused).toEqual([]);
    expect(fake.reads[2]).toEqual({ filters: [{ field: "account_code", op: "in", value: ["AR"] }] });
  });

  it("does not report an admin-set code naming a non-chart account that exists", async () => {
    const settings = new InMemorySettingsStore();
    await settings.put(TENANT, { finance: { arAccountCode: "AR-CUSTOM", rounding: "half_even" } });
    const report = await run(fakeAccess({ seed: [account("AR-CUSTOM", { account_type: "asset" })] }), settings);
    expect(report.outcome).toBe("complete");
    expect(report.settingsDangling).toEqual([]);
    expect(report.settingsFilled).not.toContain("arAccountCode");
    expect(report.settingsFilled).toHaveLength(17);
    const finance = (await settings.get(TENANT)).finance;
    expect(finance?.arAccountCode).toBe("AR-CUSTOM");
    expect(finance?.rounding).toBe("half_even");
    expect(finance?.apAccountCode).toBe("2000");
  });

  it.each([
    ["a failing read", new Error("connection reset")],
    ["a ceiling", new ReadCeilingExceeded(STARTER_CHART_ENTITY, 1000, "x")],
  ])("answers settingsDangling null, and partial, when the extra read hits %s", async (_label, error) => {
    const settings = new InMemorySettingsStore();
    await settings.put(TENANT, { finance: { arAccountCode: "AR-CUSTOM" } });
    const report = await run(fakeAccess({ readErrors: { 2: error } }), settings);
    expect(report.settingsDangling).toBeNull();
    expect(report.outcome).toBe("partial");
    expect(report.refused).toEqual([]);
    expect(report.settingsFilled).toHaveLength(17);
  });

  it.each(["", "  "])("treats a blank admin code (%j) as unset and fills it", async (blank) => {
    const settings = new InMemorySettingsStore();
    await settings.put(TENANT, { finance: { arAccountCode: blank } });
    const report = await run(fakeAccess(), settings);
    expect(report.outcome).toBe("complete");
    expect(report.settingsFilled).toContain("arAccountCode");
    expect((await settings.get(TENANT)).finance?.arAccountCode).toBe("1100");
  });

  it("is idempotent: a second run creates nothing and fills nothing", async () => {
    const fake = fakeAccess();
    const settings = new InMemorySettingsStore();
    await run(fake, settings);
    const writes = fake.bodies.length;
    const second = await run(fake, settings);
    expect(fake.bodies).toHaveLength(writes);
    expect(second).toMatchObject({ outcome: "complete", created: [], refused: [], settingsFilled: [], settingsSkipped: [] });
    expect(second.existing).toEqual(CODES);
  });

  it("finishes a partial run on the second attempt", async () => {
    const settings = new InMemorySettingsStore();
    await run(fakeAccess({ results: { "1100": refusal(503, "store_unavailable") } }), settings);
    const second = fakeAccess({ seed: CODES.filter((c) => c !== "1100").map((c) => account(c)) });
    const report = await run(second, settings);
    expect(report).toMatchObject({ outcome: "complete", created: ["1100"], settingsFilled: ["arAccountCode"] });
  });

  it("reaches every outcome it declares", () => {
    expect([...STARTER_CHART_OUTCOMES].sort()).toEqual(
      ["complete", "duplicates_present", "not_served", "partial", "refused", "settings_unwritten"].sort(),
    );
  });

  it("creates a chart erp-core's real create handler accepts, and is idempotent through it", async () => {
    const store = new InMemoryEntityStore();
    const compiled = compileOperateServer(buildErpCorePack(), {
      store,
      principalRoles: (p: ResolvedPrincipal | null) => ({
        primaryRole: p?.grantedScopes[0] ?? "anonymous",
        secondaryRoles: p?.grantedScopes.slice(1) ?? [],
      }),
      clock: { now: () => new Date("2026-03-01T01:00:00.000Z") },
    });
    const settings = new InMemorySettingsStore();
    const input = {
      access: compiled.systemEntityAccess,
      tenantId: TENANT,
      actor: ACTOR,
      settings,
      updatedBy: null,
      requestRemittancePosting: true,
    };
    const first = await ensureStarterChart(input);
    expect(first).toMatchObject({ outcome: "complete", refused: [], settingsSkipped: [], settingsDangling: [] });
    expect(first.created).toEqual(CODES);
    const rows = await compiled.systemEntityAccess
      .forTenant(TENANT, ACTOR)
      .readAll(STARTER_CHART_ENTITY, {}, { ceiling: 100, computing: "x" });
    expect(rows).toHaveLength(21);
    expect(rows.every((r) => r["currency"] === "USD" && r["status"] === "active")).toBe(true);
    const second = await ensureStarterChart(input);
    expect(second).toMatchObject({ outcome: "complete", created: [], settingsFilled: [], settingsSkipped: [] });
    expect(second.existing).toEqual(CODES);
  });

  describe("the tax remittance posting mode (ADR-0467)", () => {
    const WIRING: TaxRemittanceWiring = { entity: "TaxReturn", stateField: "state", reverseTransition: "reverse_payment" };

    async function storeWith(document: Parameters<InMemorySettingsStore["put"]>[1]): Promise<InMemorySettingsStore> {
      const settings = new InMemorySettingsStore();
      await settings.put(TENANT, document);
      return settings;
    }

    it("declares exactly the outcomes it reaches", () => {
      expect([...STARTER_REMITTANCE_POSTING_OUTCOMES].sort()).toEqual(
        [
          "already_set",
          "filled",
          "skipped_existing_tenant",
          "skipped_functional_currency_undeclared",
          "skipped_returns_outstanding",
          "skipped_unwired",
        ].sort(),
      );
    });

    it("filled: a new workspace with a currency and no filed return gets on_mark_paid", async () => {
      const settings = await storeWith({ defaults: { currency: "USD" } });
      const fake = fakeAccess();
      const report = await run(fake, settings, WIRING);
      expect(report.remittancePosting).toBe("filled");
      expect(report.outcome).toBe("complete");
      expect((await settings.get(TENANT)).finance?.taxRemittancePosting).toBe("on_mark_paid");
      // The mode is reported beside the account codes, never among them.
      expect(report.settingsFilled).toEqual([...FINANCE_ACCOUNT_CODE_KEYS]);
      expect(fake.taxReturnReads).toEqual([
        { query: { filters: [{ field: "state", op: "in", value: ["filed", "amended", "paid"] }] }, ceiling: 1000 },
      ]);
    });

    it("filled: on a tenant whose every code is already set, the mode alone is written", async () => {
      const settings = new InMemorySettingsStore();
      await run(fakeAccess(), settings);
      await settings.put(TENANT, { ...(await settings.get(TENANT)), defaults: { currency: "USD" } });
      const report = await run(fakeAccess({ seed: STARTER_CHART.map((a) => account(a.code)) }), settings, WIRING);
      expect(report.settingsFilled).toEqual([]);
      expect(report.remittancePosting).toBe("filled");
      expect((await settings.get(TENANT)).finance?.taxRemittancePosting).toBe("on_mark_paid");
    });

    it("already_set: a mode an admin chose is kept, and no return is read", async () => {
      const settings = await storeWith({ defaults: { currency: "USD" }, finance: { taxRemittancePosting: "manual_journal" } });
      const fake = fakeAccess();
      const report = await run(fake, settings, WIRING);
      expect(report.remittancePosting).toBe("already_set");
      expect((await settings.get(TENANT)).finance?.taxRemittancePosting).toBe("manual_journal");
      expect(fake.taxReturnReads).toEqual([]);
    });

    it("skipped_returns_outstanding: a filed or amended return withholds the mode", async () => {
      for (const state of ["filed", "amended"]) {
        const settings = await storeWith({ defaults: { currency: "USD" } });
        const report = await run(fakeAccess({ taxReturns: [{ id: "rec_tr1", state }] }), settings, WIRING);
        expect(report.remittancePosting).toBe("skipped_returns_outstanding");
        expect((await settings.get(TENANT)).finance?.taxRemittancePosting).toBeUndefined();
        // The account codes are still filled: the skip is about the mode alone.
        expect(report.outcome).toBe("complete");
      }
    });

    it("skipped_returns_outstanding: more returns than the read's ceiling is the same answer", async () => {
      const settings = await storeWith({ defaults: { currency: "USD" } });
      const fake = fakeAccess({ taxReturnReadError: new ReadCeilingExceeded("TaxReturn", 1, "x") });
      expect((await run(fake, settings, WIRING)).remittancePosting).toBe("skipped_returns_outstanding");
    });

    it("control: a draft or ready return, or a paid one whose remittance was recorded here, does not withhold the mode", async () => {
      const settings = await storeWith({ defaults: { currency: "USD" } });
      const returns = [
        { id: "rec_tr0", state: "draft" },
        { id: "rec_tr1", state: "ready" },
        { id: "rec_tr2", state: "paid", remitted_at: "2026-02-01T00:00:00.000Z" },
      ];
      expect((await run(fakeAccess({ taxReturns: returns }), settings, WIRING)).remittancePosting).toBe("filled");
    });

    it("skipped_returns_outstanding: a paid return with no remittance recorded here was journalled by hand", async () => {
      const settings = await storeWith({ defaults: { currency: "USD" } });
      const fake = fakeAccess({ taxReturns: [{ id: "rec_tr1", state: "paid" }] });
      expect((await run(fake, settings, WIRING)).remittancePosting).toBe("skipped_returns_outstanding");
      expect((await settings.get(TENANT)).finance?.taxRemittancePosting).toBeUndefined();
    });

    it("skipped_existing_tenant: a run the caller did not mark as a new workspace never switches posting on", async () => {
      const settings = await storeWith({ defaults: { currency: "USD" } });
      const fake = fakeAccess();
      const report = await run(fake, settings, WIRING, false);
      expect(report.remittancePosting).toBe("skipped_existing_tenant");
      expect(report.outcome).toBe("complete");
      expect((await settings.get(TENANT)).finance?.taxRemittancePosting).toBeUndefined();
      expect(fake.taxReturnReads).toEqual([]);
      // A mode an admin chose is still reported as chosen.
      const chosen = await storeWith({ defaults: { currency: "USD" }, finance: { taxRemittancePosting: "manual_journal" } });
      expect((await run(fakeAccess(), chosen, WIRING, false)).remittancePosting).toBe("already_set");
    });

    it("skipped_functional_currency_undeclared: no defaults.currency, and no return is read", async () => {
      const settings = new InMemorySettingsStore();
      const fake = fakeAccess();
      const report = await run(fake, settings, WIRING);
      expect(report.remittancePosting).toBe("skipped_functional_currency_undeclared");
      expect((await settings.get(TENANT)).finance?.taxRemittancePosting).toBeUndefined();
      expect(fake.taxReturnReads).toEqual([]);
    });

    it("skipped_unwired: no wiring, or a deployment serving no TaxReturn, leaves the mode alone", async () => {
      const unwired = await storeWith({ defaults: { currency: "USD" } });
      const fake = fakeAccess();
      expect((await run(fake, unwired)).remittancePosting).toBe("skipped_unwired");
      expect((await run(fake, unwired, null)).remittancePosting).toBe("skipped_unwired");
      expect(fake.taxReturnReads).toEqual([]);
      const notServed = await storeWith({ defaults: { currency: "USD" } });
      expect((await run(fakeAccess({ servesTaxReturn: false }), notServed, WIRING)).remittancePosting).toBe(
        "skipped_unwired",
      );
      expect((await unwired.get(TENANT)).finance?.taxRemittancePosting).toBeUndefined();
    });

    it("filters on the lifecycle's own state field", async () => {
      const settings = await storeWith({ defaults: { currency: "USD" } });
      const fake = fakeAccess({ taxReturns: [{ id: "rec_tr1", status: "filed" }] });
      const report = await run(fake, settings, { ...WIRING, stateField: "status" });
      expect(report.remittancePosting).toBe("skipped_returns_outstanding");
      expect(fake.taxReturnReads[0]?.query.filters?.[0]?.field).toBe("status");
    });

    it("reads back why the lock left a requested mode, rather than guessing", async () => {
      // Unset with a currency when read first; set by an admin before the lock.
      let reads = 0;
      const settings: ChartSettings = {
        fillUnsetFinanceAccountCodes: (_t, codes) => {
          const { taxRemittancePosting: _mode, ...accountCodes } = codes;
          return Promise.resolve({ filled: Object.keys(accountCodes) as FinanceAccountCodeKey[], inEffect: accountCodes });
        },
        get: () => {
          reads += 1;
          return Promise.resolve(
            reads === 1
              ? { defaults: { currency: "USD" } }
              : { defaults: { currency: "USD" }, finance: { taxRemittancePosting: "manual_journal" as const } },
          );
        },
      };
      expect((await run(fakeAccess(), settings, WIRING)).remittancePosting).toBe("already_set");
      reads = 0;
      settings.get = () => {
        reads += 1;
        return Promise.resolve(reads === 1 ? { defaults: { currency: "USD" } } : {});
      };
      expect((await run(fakeAccess(), settings, WIRING)).remittancePosting).toBe("skipped_functional_currency_undeclared");
    });

    it("asks the fill for the mode exactly when the decision is to request it", async () => {
      const requests: unknown[] = [];
      const recording = (document: Awaited<ReturnType<SettingsStore["get"]>>): ChartSettings => ({
        fillUnsetFinanceAccountCodes: (_t, codes) => {
          requests.push(codes.taxRemittancePosting);
          return Promise.resolve({ filled: [], inEffect: {} });
        },
        get: () => Promise.resolve(document),
      });
      await run(fakeAccess(), recording({ defaults: { currency: "USD" } }), WIRING);
      await run(fakeAccess({ taxReturns: [{ id: "r", state: "filed" }] }), recording({ defaults: { currency: "USD" } }), WIRING);
      await run(fakeAccess(), recording({}), WIRING);
      expect(requests).toEqual(["on_mark_paid", undefined, undefined]);
    });

    it("lets a failing TaxReturn read propagate rather than reporting it as a settings failure", async () => {
      const settings = await storeWith({ defaults: { currency: "USD" } });
      const fake = fakeAccess({ taxReturnReadError: new Error("connection reset") });
      await expect(run(fake, settings, WIRING)).rejects.toThrow("connection reset");
      expect((await settings.get(TENANT)).finance).toBeUndefined();
    });

    it("reports a failing settings read as settings_unwritten with no mode decided", async () => {
      class SettingsRowUnreadable extends Error {
        constructor() {
          super("unreadable");
          this.name = "SettingsRowUnreadable";
        }
      }
      const settings: ChartSettings = {
        fillUnsetFinanceAccountCodes: () => Promise.resolve({ filled: [], inEffect: {} }),
        get: () => Promise.reject(new SettingsRowUnreadable()),
      };
      const report = await run(fakeAccess(), settings, WIRING);
      expect(report.outcome).toBe("settings_unwritten");
      expect(report.settingsError).toBe("SettingsRowUnreadable");
      expect(report.remittancePosting).toBeNull();
    });

    it("works through erp-core's real handlers and store: filled, then withheld for an outstanding return", async () => {
      const store = new InMemoryEntityStore();
      const compiled = compileOperateServer(buildErpCorePack(), {
        store,
        principalRoles: (p: ResolvedPrincipal | null) => ({
          primaryRole: p?.grantedScopes[0] ?? "anonymous",
          secondaryRoles: p?.grantedScopes.slice(1) ?? [],
        }),
        clock: { now: () => new Date("2026-03-01T01:00:00.000Z") },
      });
      const fresh = await storeWith({ defaults: { currency: "USD" } });
      const input = {
        access: compiled.systemEntityAccess,
        actor: ACTOR,
        updatedBy: null,
        taxRemittance: WIRING,
        requestRemittancePosting: true,
      };
      const first = await ensureStarterChart({ ...input, tenantId: TENANT, settings: fresh });
      expect(first.remittancePosting).toBe("filled");

      const OTHER = "22222222-2222-4222-8222-222222222222";
      await store.create(OTHER, "TaxReturn", { id: "rec_tr_filed", return_number: "TAX-1", state: "filed" });
      const withReturn = new InMemorySettingsStore();
      await withReturn.put(OTHER, { defaults: { currency: "USD" } });
      const second = await ensureStarterChart({ ...input, tenantId: OTHER, settings: withReturn });
      expect(second.remittancePosting).toBe("skipped_returns_outstanding");
      expect((await withReturn.get(OTHER)).finance?.taxRemittancePosting).toBeUndefined();
    });
  });
});

describe("starterChartActorCapability (ADR-0480)", () => {
  const core = buildErpCorePack();

  it("answers can_create for erp_admin on erp-core, said at info", () => {
    const cap = starterChartActorCapability(core, ["erp_admin"]);
    expect(cap).toEqual({ kind: "can_create", roles: ["erp_admin"] });
    const out = formatStarterChartActorCapability(cap);
    expect(out.level).toBe("info");
    expect(out.line).toContain("may create LedgerAccount");
  });

  it("warns for erp_viewer, naming the flag that fixes it", () => {
    const cap = starterChartActorCapability(core, ["erp_viewer"]);
    expect(cap.kind).toBe("cannot_create");
    const out = formatStarterChartActorCapability(cap);
    expect(out.level).toBe("warn");
    expect(out.line).toContain("erp_viewer");
    expect(out.line).toContain("--job-actor-role");
  });

  it("reads a secondary role, as the system writer does", () => {
    expect(starterChartActorCapability(core, ["erp_viewer", "erp_admin"]).kind).toBe("can_create");
  });

  it("warns when no role is configured, and is not_served without a LedgerAccount", () => {
    expect(starterChartActorCapability(core, []).kind).toBe("cannot_create");
    const bare = { ...core, entities: (core.entities ?? []).filter((e) => e.name !== "LedgerAccount") };
    const cap = starterChartActorCapability(bare, ["erp_admin"]);
    expect(cap).toEqual({ kind: "not_served" });
    expect(formatStarterChartActorCapability(cap).level).toBe("info");
  });
});
