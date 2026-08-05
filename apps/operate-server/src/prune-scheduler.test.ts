import { describe, expect, it } from "vitest";

import type { IntervalScheduler } from "./jwks.js";
import type { DanglingLinkPruner, MultiTenantSweepReport, RelationPair } from "./link-sweep.js";
import { PruneScheduler } from "./prune-scheduler.js";
import { StaticTenantSource } from "./scheduler.js";

const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";

const PAIRS: readonly RelationPair[] = [
  { left: "Product", right: "Store" },
  { left: "Order", right: "Coupon" },
];

interface PruneCall {
  readonly tenantId: string;
  readonly left: string;
  readonly right: string;
}

function fakePruner(calls: PruneCall[], opts: { throwOn?: string } = {}): DanglingLinkPruner {
  return {
    pruneDanglingLinks: async (tenantId, left, right) => {
      calls.push({ tenantId, left, right });
      if (opts.throwOn === tenantId) throw new Error("prune blew up");
      return { pruned: 1, kept: 2 };
    },
  };
}

/** A manual interval scheduler so tests drive sweeps explicitly. */
function manualScheduler(): { scheduler: IntervalScheduler; fire: () => void; cleared: () => boolean } {
  let handler: (() => void) | null = null;
  let clearedFlag = false;
  return {
    scheduler: {
      setInterval: (h) => {
        handler = h;
        return 1;
      },
      clearInterval: () => {
        clearedFlag = true;
      },
    },
    fire: () => handler?.(),
    cleared: () => clearedFlag,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("PruneScheduler", () => {
  it("start() runs an immediate sweep over every tenant × relation", async () => {
    const calls: PruneCall[] = [];
    const { scheduler } = manualScheduler();
    const s = new PruneScheduler({
      pruner: fakePruner(calls),
      pairs: PAIRS,
      tenantSource: new StaticTenantSource([T1, T2]),
      intervalMs: 60_000,
      scheduler,
    });
    s.start();
    await flush();
    // 2 tenants × 2 relations = 4 prune calls.
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.tenantId)).toEqual([T1, T1, T2, T2]);
  });

  it("firing the interval callback sweeps again and reports via onSwept", async () => {
    const calls: PruneCall[] = [];
    const reports: MultiTenantSweepReport[] = [];
    const { scheduler, fire } = manualScheduler();
    const s = new PruneScheduler({
      pruner: fakePruner(calls),
      pairs: PAIRS,
      tenantSource: new StaticTenantSource([T1]),
      intervalMs: 60_000,
      scheduler,
      onSwept: (r) => reports.push(r),
    });
    s.start();
    await flush();
    const afterStart = calls.length;
    expect(afterStart).toBe(2);
    fire();
    await flush();
    expect(calls.length).toBe(afterStart + 2);
    expect(reports).toHaveLength(2);
    expect(reports[0]!.totalPruned).toBe(2);
    expect(reports[0]!.totalKept).toBe(4);
  });

  it("routes a sweep error to onError without escaping the timer", async () => {
    const calls: PruneCall[] = [];
    const errors: unknown[] = [];
    const { scheduler } = manualScheduler();
    const s = new PruneScheduler({
      pruner: fakePruner(calls, { throwOn: T1 }),
      pairs: PAIRS,
      tenantSource: new StaticTenantSource([T1]),
      intervalMs: 60_000,
      scheduler,
      onError: (e) => errors.push(e),
    });
    expect(() => s.start()).not.toThrow();
    await flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("prune blew up");
  });

  it("stop() clears the interval", async () => {
    const { scheduler, cleared } = manualScheduler();
    const s = new PruneScheduler({
      pruner: fakePruner([]),
      pairs: PAIRS,
      tenantSource: new StaticTenantSource([T1]),
      intervalMs: 60_000,
      scheduler,
    });
    s.start();
    await flush();
    s.stop();
    expect(cleared()).toBe(true);
  });

  it("start() is idempotent", () => {
    let setCount = 0;
    const counting: IntervalScheduler = {
      setInterval: () => {
        setCount += 1;
        return 1;
      },
      clearInterval: () => undefined,
    };
    const s = new PruneScheduler({
      pruner: fakePruner([]),
      pairs: PAIRS,
      tenantSource: new StaticTenantSource([T1]),
      intervalMs: 60_000,
      scheduler: counting,
    });
    s.start();
    s.start();
    expect(setCount).toBe(1);
  });
});
