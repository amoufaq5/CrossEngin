import { AsyncLocalStorage } from "node:async_hooks";

import type { SettingsStore, TenantSettings } from "./settings.js";

/**
 * One read of a tenant's settings, taken **before** a write transaction opens and served to every
 * effect that asks for them inside it.
 *
 * The defect this exists for was found live, not reasoned. The GL posting effects resolve account
 * codes through `settingsStore.get`, which on `--store pg` borrows a pooled connection — while the
 * transaction they run in already holds one. Ten concurrent `send`s on one invoice then each hold a
 * connection: the winner of the conditional update (ADR-0422) needs an eleventh for its settings
 * read, and the nine losers wait on the winner's row lock without releasing theirs. The pool is
 * exhausted, nobody can move, and the deadlock ends only when the connect timeout ADR-0425 bounded
 * fires on the winner — measured at **1 × 500 `write_failed`** per ten-way race, each race costing
 * the full 30 s. Before ADR-0425 the same race had no timeout at all and would have hung.
 *
 * The sibling fix is ADR-0421's: sequence allocation moved out of the transaction for the same
 * reason. This is the general form — a value the transaction's effects need, read on the pool
 * before the transaction's own connection is taken, so nothing inside it ever borrows a second one.
 *
 * Scoped with `AsyncLocalStorage` rather than threaded through `WriteEffectInput`, because the
 * resolvers that read settings are compile-time closures over a `SettingsStore` and a deployment
 * may supply its own effects that read one the same way; the snapshot is a `SettingsStore` too, so
 * every one of them is covered with no signature changing. Keyed on the tenant as well as the scope,
 * so an effect asking about another tenant (none does today) reads the store rather than this
 * tenant's settings.
 */
export interface TransactionSettingsScope {
  /** The store the effects read through: the scoped snapshot inside `run`, the real store outside. */
  readonly store: SettingsStore;
  /** Reads the tenant's settings once (unless `prefetched` is given) and runs `fn` within them. */
  run<T>(tenantId: string, fn: () => Promise<T>, prefetched?: TenantSettings): Promise<T>;
}

export function transactionSettingsScope(inner: SettingsStore): TransactionSettingsScope {
  const scope = new AsyncLocalStorage<{ readonly tenantId: string; readonly settings: TenantSettings }>();
  return {
    store: {
      get: async (tenantId) => {
        const held = scope.getStore();
        return held !== undefined && held.tenantId === tenantId ? held.settings : inner.get(tenantId);
      },
      // Writes go straight through: no effect writes settings, and a snapshot that absorbed one would
      // be a write that reached nobody.
      put: (tenantId, settings, updatedBy) => inner.put(tenantId, settings, updatedBy),
    },
    async run(tenantId, fn, prefetched) {
      const settings = prefetched ?? (await inner.get(tenantId));
      return scope.run({ tenantId, settings }, fn);
    },
  };
}
