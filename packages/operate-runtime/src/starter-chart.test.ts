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
} from "./settings.js";
import {
  ensureStarterChart,
  STARTER_ACCOUNT_TYPES,
  STARTER_ACCOUNTS_BY_SETTING,
  STARTER_ACCOUNTS_WITHOUT_SETTING,
  STARTER_CHART,
  STARTER_CHART_ENTITY,
  STARTER_CHART_OUTCOMES,
  STARTER_CHART_VERSION,
  type StarterChartReport,
} from "./starter-chart.js";
import type { EntityRecord } from "./store.js";
import { InMemoryEntityStore } from "./store.js";
import type {
  SystemActor,
  SystemEntityAccess,
  SystemReadQuery,
  SystemWriteResult,
  TenantEntityAccess,
} from "./system-writer.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTOR: SystemActor = {
  roles: ["erp_admin"],
  origin: { kind: "provisioning", operation: "starter_chart", provisioningId: "areq_0001" },
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
}

function fakeAccess(options: FakeOptions = {}) {
  const bodies: Record<string, unknown>[] = [];
  const reads: SystemReadQuery[] = [];
  const tenants: string[] = [];
  const actors: SystemActor[] = [];
  const rows: EntityRecord[] = [...(options.seed ?? [])];
  let readIndex = 0;
  const tenantAccess = (tenantId: string): TenantEntityAccess => ({
    tenantId,
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
    readAll(entity, query) {
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
    serves: (entity, operation) => (options.serves ?? true) && entity === STARTER_CHART_ENTITY && operation === "create",
    forTenant(tenantId, actor) {
      tenants.push(tenantId);
      actors.push(actor);
      return tenantAccess(tenantId);
    },
  };
  return { access, bodies, reads, tenants, actors, rows };
}

function refusal(status: number, error: string): SystemWriteResult {
  return { kind: "refused", status, error, detail: null, operationId: "ledgerAccount.create" };
}

async function run(
  fake: ReturnType<typeof fakeAccess>,
  settings: FinanceAccountCodeFiller = new InMemorySettingsStore(),
): Promise<StarterChartReport> {
  return ensureStarterChart({ access: fake.access, tenantId: TENANT, actor: ACTOR, settings, updatedBy: null });
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
    const report = await run(fake, {
      fillUnsetFinanceAccountCodes: () => {
        asked = true;
        return Promise.resolve({ filled: [], inEffect: {} });
      },
    });
    expect(report).toEqual({
      outcome: "not_served",
      version: STARTER_CHART_VERSION,
      created: [],
      existing: [],
      refused: [],
      settingsFilled: [],
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
    const settings: FinanceAccountCodeFiller = {
      fillUnsetFinanceAccountCodes: (_t, codes) => {
        const inEffect = { ...codes };
        delete inEffect.cashAccountCode;
        return Promise.resolve({ filled: Object.keys(inEffect) as FinanceAccountCodeKey[], inEffect });
      },
    };
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
    const report = await run(fake, { fillUnsetFinanceAccountCodes: () => Promise.reject(new SettingsRowUnreadable()) });
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
    const input = { access: compiled.systemEntityAccess, tenantId: TENANT, actor: ACTOR, settings, updatedBy: null };
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
});
