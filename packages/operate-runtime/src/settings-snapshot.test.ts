import { describe, expect, it } from "vitest";

import { transactionSettingsScope } from "./settings-snapshot.js";
import type { SettingsStore, TenantSettings } from "./settings.js";

function countingStore(by: Record<string, TenantSettings>): SettingsStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get: async (tenantId) => {
      reads.push(tenantId);
      return by[tenantId] ?? {};
    },
    put: async (_tenantId, settings) => settings,
  };
}

describe("transactionSettingsScope", () => {
  it("reads once before the body and serves every read inside it from that one value", async () => {
    const inner = countingStore({ t1: { finance: { arAccountCode: "1100" } } });
    const scope = transactionSettingsScope(inner);
    let readsWhenBodyStarted = -1;
    const codes = await scope.run("t1", async () => {
      // The body stands for the transaction: by now its connection is held, so a read reaching the
      // inner store here is the second pooled connection the deadlock was made of.
      readsWhenBodyStarted = inner.reads.length;
      const a = await scope.store.get("t1");
      const b = await scope.store.get("t1");
      return [a.finance?.arAccountCode, b.finance?.arAccountCode];
    });
    expect(codes).toEqual(["1100", "1100"]);
    expect(readsWhenBodyStarted).toBe(1);
    expect(inner.reads).toEqual(["t1"]);
  });

  it("takes a prefetched value instead of reading again", async () => {
    const inner = countingStore({});
    const scope = transactionSettingsScope(inner);
    const got = await scope.run("t1", () => scope.store.get("t1"), { defaults: { currency: "EUR" } });
    expect(got.defaults?.currency).toBe("EUR");
    expect(inner.reads).toEqual([]);
  });

  it("reads the store for another tenant, and outside any scope", async () => {
    const inner = countingStore({ t1: {}, t2: { defaults: { currency: "JPY" } } });
    const scope = transactionSettingsScope(inner);
    const other = await scope.run("t1", () => scope.store.get("t2"));
    expect(other.defaults?.currency).toBe("JPY");
    await scope.store.get("t1");
    expect(inner.reads).toEqual(["t1", "t2", "t1"]);
  });

  it("keeps two concurrent scopes apart", async () => {
    const inner = countingStore({ t1: { defaults: { currency: "USD" } }, t2: { defaults: { currency: "GBP" } } });
    const scope = transactionSettingsScope(inner);
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));
    const [a, b] = await Promise.all([
      scope.run("t1", async () => {
        await tick();
        return (await scope.store.get("t1")).defaults?.currency;
      }),
      scope.run("t2", async () => {
        await tick();
        return (await scope.store.get("t2")).defaults?.currency;
      }),
    ]);
    expect([a, b]).toEqual(["USD", "GBP"]);
  });
});
