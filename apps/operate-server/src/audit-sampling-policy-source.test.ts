import { describe, expect, it } from "vitest";
import type { AuditSamplingSettings, SettingsStore, TenantSettings } from "@crossengin/operate-runtime";

import {
  ActiveTenantSource,
  TenantAuditPolicyCache,
  TenantAuditPolicyRefresher,
  auditPolicyFromSettings,
  buildTenantAuditPolicyCache,
} from "./audit-sampling-policy-source.js";
import type { IntervalScheduler } from "./jwks.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "33333333-3333-3333-3333-333333333333";
const TENANT_C = "44444444-4444-4444-4444-444444444444";

/** A settings store keyed by tenant; `get` returns `{}` for an unknown tenant, or throws if configured. */
function fakeSettingsStore(
  byTenant: Record<string, TenantSettings>,
  failFor: Record<string, Error> = {},
): Pick<SettingsStore, "get"> {
  return {
    get: async (tenantId: string): Promise<TenantSettings> => {
      const fail = failFor[tenantId];
      if (fail !== undefined) throw fail;
      return byTenant[tenantId] ?? {};
    },
  };
}

function tenantSource(ids: readonly string[]): ActiveTenantSource {
  return { activeTenantIds: () => ids };
}

describe("auditPolicyFromSettings", () => {
  it("passes recognized outcomes / operations / sampleRate through", () => {
    const settings: AuditSamplingSettings = {
      outcomes: ["deny", "error"],
      operations: ["product.list"],
      sampleRate: 0.5,
    };
    expect(auditPolicyFromSettings(settings)).toEqual({
      outcomes: ["deny", "error"],
      operations: ["product.list"],
      sampleRate: 0.5,
    });
  });

  it("drops unrecognized outcomes, and omits the outcome filter when none survive", () => {
    expect(auditPolicyFromSettings({ outcomes: ["deny", "not_a_real_outcome"] })).toEqual({
      outcomes: ["deny"],
    });
    expect(auditPolicyFromSettings({ outcomes: ["nope"] })).toEqual({});
  });

  it("only sets the fields the settings specify", () => {
    expect(auditPolicyFromSettings({ sampleRate: 0 })).toEqual({ sampleRate: 0 });
    expect(auditPolicyFromSettings({})).toEqual({});
  });
});

describe("TenantAuditPolicyCache", () => {
  it("refresh loads live policies keyed by tenant; get returns them", async () => {
    const store = fakeSettingsStore({
      [TENANT_A]: { auditSampling: { sampleRate: 0.1, outcomes: ["deny"] } },
      [TENANT_B]: { auditSampling: { operations: ["product.get"] } },
    });
    const cache = new TenantAuditPolicyCache({ settingsStore: store, tenants: tenantSource([TENANT_A, TENANT_B]) });
    await cache.refresh();

    expect(cache.get(TENANT_A)).toEqual({ sampleRate: 0.1, outcomes: ["deny"] });
    expect(cache.get(TENANT_B)).toEqual({ operations: ["product.get"] });
    expect(cache.size()).toBe(2);
  });

  it("a tenant without auditSampling yields undefined", async () => {
    const store = fakeSettingsStore({
      [TENANT_A]: { auditSampling: { sampleRate: 0 } },
      [TENANT_B]: { company: { name: "Acme" } },
    });
    const cache = new TenantAuditPolicyCache({ settingsStore: store, tenants: tenantSource([TENANT_A, TENANT_B]) });
    await cache.refresh();

    expect(cache.get(TENANT_B)).toBeUndefined();
    expect(cache.get(TENANT_C)).toBeUndefined(); // never listed
    expect(cache.size()).toBe(1);
  });

  it("swallows a per-tenant load error, routes it to onError, and still loads the others", async () => {
    const errs: { err: unknown; tenantId: string }[] = [];
    const store = fakeSettingsStore(
      {
        [TENANT_A]: { auditSampling: { sampleRate: 0.2 } },
        [TENANT_C]: { auditSampling: { sampleRate: 0.9 } },
      },
      { [TENANT_B]: new Error("settings boom") },
    );
    const cache = new TenantAuditPolicyCache({
      settingsStore: store,
      tenants: tenantSource([TENANT_A, TENANT_B, TENANT_C]),
      onError: (err, tenantId) => errs.push({ err, tenantId }),
    });
    await cache.refresh();

    expect(cache.get(TENANT_A)).toEqual({ sampleRate: 0.2 });
    expect(cache.get(TENANT_C)).toEqual({ sampleRate: 0.9 });
    expect(cache.get(TENANT_B)).toBeUndefined();
    expect(errs).toHaveLength(1);
    expect(errs[0]?.tenantId).toBe(TENANT_B);
  });

  it("a later refresh drops a tenant that no longer sets a policy", async () => {
    const byTenant: Record<string, TenantSettings> = { [TENANT_A]: { auditSampling: { sampleRate: 0 } } };
    const cache = new TenantAuditPolicyCache({ settingsStore: fakeSettingsStore(byTenant), tenants: tenantSource([TENANT_A]) });
    await cache.refresh();
    expect(cache.get(TENANT_A)).toEqual({ sampleRate: 0 });

    byTenant[TENANT_A] = { company: { name: "Acme" } };
    await cache.refresh();
    expect(cache.get(TENANT_A)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });
});

describe("TenantAuditPolicyRefresher", () => {
  function fakeScheduler(): { scheduler: IntervalScheduler; tick: () => void; cleared: () => boolean } {
    let fn: (() => void) | null = null;
    let handle: object | null = null;
    return {
      scheduler: {
        setInterval(handler) {
          fn = handler;
          handle = {};
          return handle;
        },
        clearInterval(h) {
          if (h === handle) handle = null;
        },
      },
      tick: () => fn?.(),
      cleared: () => handle === null,
    };
  }

  it("refreshes the cache immediately on start and on each interval tick, and stops cleanly", async () => {
    const store = fakeSettingsStore({ [TENANT_A]: { auditSampling: { sampleRate: 0.3 } } });
    const cache = new TenantAuditPolicyCache({ settingsStore: store, tenants: tenantSource([TENANT_A]) });
    let refreshes = 0;
    const original = cache.refresh.bind(cache);
    cache.refresh = async (): Promise<void> => {
      refreshes += 1;
      await original();
    };

    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const f = fakeScheduler();
    const refresher = new TenantAuditPolicyRefresher({ cache, intervalMs: 60_000, scheduler: f.scheduler });
    refresher.start();
    await flush();
    expect(refreshes).toBe(1); // refreshOnStart
    expect(cache.get(TENANT_A)).toEqual({ sampleRate: 0.3 });

    f.tick();
    f.tick();
    await flush();
    expect(refreshes).toBe(3);

    refresher.stop();
    expect(f.cleared()).toBe(true);
  });

  it("can skip the start refresh", async () => {
    let refreshes = 0;
    const cache = new TenantAuditPolicyCache({
      settingsStore: fakeSettingsStore({}),
      tenants: tenantSource([]),
    });
    cache.refresh = async (): Promise<void> => void (refreshes += 1);
    const f = fakeScheduler();
    const refresher = new TenantAuditPolicyRefresher({
      cache,
      intervalMs: 1000,
      refreshOnStart: false,
      scheduler: f.scheduler,
    });
    refresher.start();
    expect(refreshes).toBe(0);
    refresher.stop();
    expect(f.cleared()).toBe(true);
  });

  it("routes a whole-refresh failure to onError", async () => {
    const errs: unknown[] = [];
    const cache = new TenantAuditPolicyCache({
      settingsStore: fakeSettingsStore({}),
      tenants: { activeTenantIds: () => Promise.reject(new Error("registry down")) },
    });
    const f = fakeScheduler();
    const refresher = new TenantAuditPolicyRefresher({
      cache,
      intervalMs: 1000,
      scheduler: f.scheduler,
      onError: (err) => errs.push(err),
    });
    refresher.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(errs).toHaveLength(1);
  });
});

describe("buildTenantAuditPolicyCache", () => {
  it("wires a cache + refresher; starting the refresher populates the cache", async () => {
    const store = fakeSettingsStore({ [TENANT_A]: { auditSampling: { sampleRate: 0 } } });
    const { cache, refresher } = buildTenantAuditPolicyCache({
      settingsStore: store,
      tenants: tenantSource([TENANT_A]),
      intervalMs: 60_000,
    });
    await cache.refresh();
    expect(cache.get(TENANT_A)).toEqual({ sampleRate: 0 });
    expect(refresher).toBeInstanceOf(TenantAuditPolicyRefresher);
  });
});
