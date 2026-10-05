import { describe, expect, it } from "vitest";

import {
  DEFAULT_SWEEP_STALL_ATTEMPTS,
  DeletionScheduler,
  SWEEP_STALL_KINDS,
  type StrandedReconcilerLike,
  type DeletionRunnerLike,
  type TombstoneSweepPage,
  type TombstoneSweepProgress,
  type TombstoneSweepStall,
} from "./deletion-scheduler.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

interface FakeScheduler extends IntervalScheduler {
  readonly fire: () => void;
  readonly intervals: number[];
  readonly cleared: number;
}

function fakeScheduler(): FakeScheduler {
  let handler: (() => void) | null = null;
  const intervals: number[] = [];
  let cleared = 0;
  const s = {
    setInterval(h: () => void, ms: number): IntervalHandle {
      handler = h;
      intervals.push(ms);
      return 1 as unknown as IntervalHandle;
    },
    clearInterval(): void {
      cleared += 1;
      handler = null;
    },
    fire: (): void => handler?.(),
    intervals,
    get cleared(): number {
      return cleared;
    },
  };
  return s as FakeScheduler;
}

function runner(behaviour: { throws?: boolean; results?: number } = {}): {
  readonly runner: DeletionRunnerLike;
  readonly limits: (number | undefined)[];
} {
  const limits: (number | undefined)[] = [];
  return {
    limits,
    runner: {
      runDue: async (limit) => {
        limits.push(limit);
        if (behaviour.throws === true) throw new Error("the database is gone");
        return Array.from({ length: behaviour.results ?? 0 }, (_v, i) => ({
          requestId: `dreq_abcdefgh123${i.toString()}`,
          tenantId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
          outcome: "completed",
          tombstoneId: "tomb_aaaabbbbccccdddd",
          detail: null,
        }));
      },
    },
  };
}

describe("DeletionScheduler", () => {
  it("does NOT run on start, unlike every sibling scheduler", () => {
    const sched = fakeScheduler();
    const r = runner();
    new DeletionScheduler({ runner: r.runner, intervalMs: 60_000, scheduler: sched }).start();
    // A boot is when a misconfiguration is most likely and the work here is irreversible, so an
    // operator who restarts to fix something gets a full interval's grace.
    expect(r.limits).toEqual([]);
    expect(sched.intervals).toEqual([60_000]);
  });

  it("runs the due batch on each tick", async () => {
    const sched = fakeScheduler();
    const r = runner({ results: 1 });
    const seen: string[][] = [];
    const s = new DeletionScheduler({
      runner: r.runner,
      intervalMs: 1000,
      scheduler: sched,
      onRun: (results) => seen.push(results.map((x) => x.requestId)),
    });
    s.start();
    await s.runOnce();
    expect(r.limits).toEqual([5]);
    expect(seen).toEqual([["dreq_abcdefgh1230"]]);
  });

  it("stays quiet when nothing is due", async () => {
    const sched = fakeScheduler();
    const r = runner({ results: 0 });
    let called = 0;
    const s = new DeletionScheduler({
      runner: r.runner,
      intervalMs: 1000,
      scheduler: sched,
      onRun: () => {
        called += 1;
      },
    });
    await s.runOnce();
    expect(called).toBe(0);
  });

  it("uses the configured batch size", async () => {
    const r = runner();
    const s = new DeletionScheduler({
      runner: r.runner,
      intervalMs: 1000,
      batchSize: 1,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    expect(r.limits).toEqual([1]);
  });

  it("routes a failed tick to onError rather than throwing out of the timer", async () => {
    const errors: unknown[] = [];
    const r = runner({ throws: true });
    const s = new DeletionScheduler({
      runner: r.runner,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("is idempotent on start and stops cleanly", () => {
    const sched = fakeScheduler();
    const s = new DeletionScheduler({ runner: runner().runner, intervalMs: 1000, scheduler: sched });
    s.start();
    s.start();
    expect(sched.intervals).toEqual([1000]);
    s.stop();
    s.stop();
    expect(sched.cleared).toBe(1);
  });
});

describe("DeletionScheduler — reconciliation", () => {
  function reconciler(behaviour: { throws?: boolean; repaired?: number } = {}): {
    readonly reconciler: StrandedReconcilerLike;
    readonly limits: (number | undefined)[];
  } {
    const limits: (number | undefined)[] = [];
    return {
      limits,
      reconciler: {
        reconcileStranded: async (limit) => {
          limits.push(limit);
          if (behaviour.throws === true) throw new Error("evidence unreadable");
          return Array.from({ length: behaviour.repaired ?? 0 }, (_v, i) => ({
            requestId: `dreq_repaired1234${i.toString()}`,
            tenantId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
            verdict: "completed_by_evidence",
            applied: true,
            tombstoneId: "tomb_aaaabbbbccccdddd",
            tombstoneIds: ["tomb_aaaabbbbccccdddd"],
            detail: null,
          }));
        },
      },
    };
  }

  it("reconciles on each tick, after the due run", async () => {
    const order: string[] = [];
    const rec = reconciler({ repaired: 1 });
    const seen: string[][] = [];
    const s = new DeletionScheduler({
      runner: {
        runDue: async () => {
          order.push("runDue");
          return [];
        },
      },
      reconciler: {
        reconcileStranded: async (limit) => {
          order.push("reconcile");
          return rec.reconciler.reconcileStranded(limit);
        },
      },
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onReconciled: (r) => seen.push(r.map((x) => x.requestId)),
    });
    await s.runOnce();
    expect(order).toEqual(["runDue", "reconcile"]);
    expect(seen).toEqual([["dreq_repaired12340"]]);
  });

  it("still reconciles on a tick whose due run threw", async () => {
    const errors: unknown[] = [];
    const rec = reconciler({ repaired: 1 });
    const s = new DeletionScheduler({
      runner: runner({ throws: true }).runner,
      reconciler: rec.reconciler,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await s.runOnce();
    // The most likely reason a request is stranded is that a run failed, so the repair pass must not
    // be skipped by the failure that caused it.
    expect(rec.limits).toEqual([5]);
    expect(errors).toHaveLength(1);
  });

  it("routes a failed reconciliation to onError without failing the tick", async () => {
    const errors: unknown[] = [];
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: reconciler({ throws: true }).reconciler,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("stays quiet when nothing needed repairing", async () => {
    let called = 0;
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: reconciler({ repaired: 0 }).reconciler,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onReconciled: () => {
        called += 1;
      },
    });
    await s.runOnce();
    expect(called).toBe(0);
  });

  it("reports nothing for a verdict it did not apply, however many ticks run", async () => {
    const seen: unknown[] = [];
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: {
        reconcileStranded: async () => [
          {
            requestId: "dreq_pending12345",
            tenantId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
            verdict: "too_recent",
            applied: false,
            tombstoneId: null,
            tombstoneIds: [],
            detail: null,
          },
        ],
      },
      intervalMs: 1000,
      scheduler: fakeScheduler(),
      onReconciled: (r) => seen.push(r),
    });
    await s.runOnce();
    await s.runOnce();
    // A standing fact about a row would otherwise be logged every interval for as long as the row
    // exists; the stranded listing is where an operator reads it.
    expect(seen).toEqual([]);
  });

  it("works with no reconciler wired at all", async () => {
    const s = new DeletionScheduler({
      runner: runner().runner,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
  });
});

describe("DeletionScheduler — the reverse-direction audit", () => {
  function auditor(behaviour: { throws?: boolean; findings?: number } = {}): {
    readonly reconciler: StrandedReconcilerLike;
    readonly limits: (number | undefined)[];
  } {
    const limits: (number | undefined)[] = [];
    return {
      limits,
      reconciler: {
        reconcileStranded: async () => [],
        auditCompleted: async (limit) => {
          limits.push(limit);
          if (behaviour.throws === true) throw new Error("a stored row will not parse");
          return Array.from({ length: behaviour.findings ?? 0 }, (_v, i) => ({
            requestId: `dreq_unproven123${i.toString()}`,
            tenantId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
            tombstoneId: "tomb_aaaabbbbccccdddd",
            present: true,
            detail: "tombstone does not verify: scope_tampered",
          }));
        },
      },
    };
  }

  it("never audits when auditEveryTicks is absent", async () => {
    const a = auditor({ findings: 1 });
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: a.reconciler,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    await s.runOnce();
    // Off by default: the pass re-hashes every completed request's tombstone, so a deployment opts in.
    expect(a.limits).toEqual([]);
  });

  it("never audits when auditEveryTicks is 0", async () => {
    const a = auditor({ findings: 1 });
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: a.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 0,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    expect(a.limits).toEqual([]);
  });

  it("reads a negative, fractional or non-finite cadence as off rather than as every tick", async () => {
    for (const every of [-1, -20, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const a = auditor({ findings: 1 });
      const s = new DeletionScheduler({
        runner: runner().runner,
        reconciler: a.reconciler,
        intervalMs: 1000,
        auditEveryTicks: every,
        scheduler: fakeScheduler(),
      });
      await s.runOnce();
      await s.runOnce();
      // A malformed flag must not turn the expensive pass on; failing closed here means not running.
      expect(a.limits, `cadence ${every.toString()}`).toEqual([]);
    }
  });

  it("audits on exactly the Nth tick and not before", async () => {
    const a = auditor();
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: a.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 3,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    expect(a.limits).toEqual([]);
    await s.runOnce();
    expect(a.limits).toEqual([]);
    await s.runOnce();
    expect(a.limits).toHaveLength(1);
  });

  it("does not audit on the first tick, because the counter is incremented before it is tested", async () => {
    const a = auditor();
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: a.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 2,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    // A counter tested at zero would audit at boot, which is the one thing the run pass refuses to do.
    expect(a.limits).toEqual([]);
  });

  it("audits every tick when the cadence is 1, including the first", async () => {
    const a = auditor();
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: a.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    await s.runOnce();
    expect(a.limits).toHaveLength(2);
  });

  it("keeps counting across ticks rather than auditing once and stopping", async () => {
    const a = auditor();
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: a.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 2,
      scheduler: fakeScheduler(),
    });
    for (let i = 0; i < 5; i += 1) await s.runOnce();
    // Ticks 2 and 4; tick 5 is not a multiple.
    expect(a.limits).toHaveLength(2);
  });

  it("does not let stop()/start() reset the cadence", async () => {
    const a = auditor();
    const sched = fakeScheduler();
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: a.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 2,
      scheduler: sched,
    });
    s.start();
    await s.runOnce();
    s.stop();
    s.start();
    await s.runOnce();
    // A config reload or a crash loop around the interval must not re-enter the countdown; the count
    // lives on the instance and nothing in the lifecycle touches it.
    expect(a.limits).toHaveLength(1);
  });

  it("is a no-op for a reconciler that has no auditCompleted at all", async () => {
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: { reconcileStranded: async () => [] },
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
  });

  it("is a no-op with a cadence set and no reconciler wired", async () => {
    let called = 0;
    const s = new DeletionScheduler({
      runner: runner().runner,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onAuditFindings: () => {
        called += 1;
      },
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
    expect(called).toBe(0);
  });

  it("hands findings to onAuditFindings and awaits it", async () => {
    const seen: string[][] = [];
    let settled = false;
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: auditor({ findings: 2 }).reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onAuditFindings: async (findings) => {
        await Promise.resolve();
        seen.push(findings.map((f) => f.requestId));
        settled = true;
      },
    });
    await s.runOnce();
    // Awaited for the same reason `onEscalate` is: a finding that warrants an incident must not be
    // abandoned half-declared when the tick returns.
    expect(settled).toBe(true);
    expect(seen).toEqual([["dreq_unproven1230", "dreq_unproven1231"]]);
  });

  it("does not invoke onAuditFindings for a clean audit", async () => {
    const seen: unknown[] = [];
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: auditor({ findings: 0 }).reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onAuditFindings: (f) => {
        seen.push(f);
      },
    });
    await s.runOnce();
    await s.runOnce();
    // `auditCompleted` returns findings only, so an empty array is "nothing wrong" — not news, the
    // same rule `onReconciled` follows. The route records the clean read; this callback does not.
    expect(seen).toEqual([]);
  });

  it("routes a throwing audit to onError without skipping the run or repair passes", async () => {
    const errors: unknown[] = [];
    const ran: string[] = [];
    const a = auditor({ throws: true });
    const s = new DeletionScheduler({
      runner: {
        runDue: async () => {
          ran.push("runDue");
          return [];
        },
      },
      reconciler: {
        reconcileStranded: async () => {
          ran.push("reconcile");
          return [];
        },
        auditCompleted: a.reconciler.auditCompleted?.bind(a.reconciler),
      },
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
    // The pass most likely to throw — it re-parses stored rows, and an unparseable row *is* the
    // finding — so its own `try` keeps the two passes that destroy and repair data intact.
    expect(ran).toEqual(["runDue", "reconcile"]);
    expect(errors).toHaveLength(1);
  });

  it("keeps auditing on later ticks after one threw", async () => {
    const errors: unknown[] = [];
    const a = auditor({ throws: true });
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: a.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await s.runOnce();
    await s.runOnce();
    expect(a.limits).toHaveLength(2);
    expect(errors).toHaveLength(2);
  });

  it("forwards auditLimit, and forwards nothing when it is absent", async () => {
    const withLimit = auditor();
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: withLimit.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      auditLimit: 7,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    expect(withLimit.limits).toEqual([7]);

    const noLimit = auditor();
    const t = new DeletionScheduler({
      runner: runner().runner,
      reconciler: noLimit.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
    });
    await t.runOnce();
    // Not restated here: the ceiling on this pass belongs to the reconciler and its store.
    expect(noLimit.limits).toEqual([undefined]);
  });

  it("runs the audit last, after the due run and the repair pass", async () => {
    const order: string[] = [];
    const s = new DeletionScheduler({
      runner: {
        runDue: async () => {
          order.push("runDue");
          return [];
        },
      },
      reconciler: {
        reconcileStranded: async () => {
          order.push("reconcile");
          return [];
        },
        auditCompleted: async () => {
          order.push("audit");
          return [];
        },
      },
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    // Last because it is the only pass that writes nothing: a tick with time for one thing should
    // spend it on the deletions that are due.
    expect(order).toEqual(["runDue", "reconcile", "audit"]);
  });

  it("does not disturb the forward direction's escalation hook", async () => {
    const escalated: string[][] = [];
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: {
        reconcileStranded: async () => [
          {
            requestId: "dreq_unverified12",
            tenantId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
            verdict: "evidence_unverified",
            applied: false,
            tombstoneId: "tomb_aaaabbbbccccdddd",
            tombstoneIds: ["tomb_aaaabbbbccccdddd"],
            detail: "scope_tampered",
          },
        ],
        auditCompleted: async () => [],
      },
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onEscalate: (results) => {
        escalated.push(results.map((r) => r.verdict));
      },
    });
    await s.runOnce();
    expect(escalated).toEqual([["evidence_unverified"]]);
  });
});

describe("DeletionScheduler — the tombstone sweep (ADR-0327)", () => {
  const TOMB = "tomb_aaaabbbbccccdddd";

  function pageOf(over: Partial<TombstoneSweepPage> = {}): TombstoneSweepPage {
    return { examined: 412, findings: [], nextAfterTombstoneId: null, ...over };
  }

  function sweepFinding(id = TOMB): TombstoneSweepPage["findings"][number] {
    return {
      tombstoneId: id,
      tenantId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
      reference: "unreferenced",
      relatedDeletionRequestId: null,
      detail: "does not verify: scope_tampered",
    };
  }

  /**
   * A reconciler whose sweep answers a queue of pages, the last repeating — which is what makes the
   * cursor observable across ticks rather than within one call.
   */
  function sweeper(
    behaviour: { throws?: boolean; pages?: readonly TombstoneSweepPage[] } = {},
  ): {
    readonly reconciler: StrandedReconcilerLike;
    readonly calls: Array<Record<string, unknown>>;
  } {
    const calls: Array<Record<string, unknown>> = [];
    let n = 0;
    return {
      calls,
      reconciler: {
        reconcileStranded: async () => [],
        auditCompleted: async () => [],
        auditTombstones: async (input): Promise<TombstoneSweepPage> => {
          calls.push({ ...input });
          if (behaviour.throws === true) throw new Error("a stored tombstone will not parse");
          const pages = behaviour.pages ?? [pageOf()];
          const page = pages[Math.min(n, pages.length - 1)] ?? pageOf();
          n += 1;
          return page;
        },
      },
    };
  }

  it("sweeps on an audit tick and not on a tick that is not one", async () => {
    const sw = sweeper();
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: sw.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 2,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    expect(sw.calls).toEqual([]);
    await s.runOnce();
    expect(sw.calls).toHaveLength(1);
  });

  it("never sweeps when no cadence is configured", async () => {
    const sw = sweeper();
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: sw.reconciler,
      intervalMs: 1000,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    await s.runOnce();
    // The sweep rides the audit's cadence, so a deployment opts into both at once or neither.
    expect(sw.calls).toEqual([]);
  });

  it("runs after auditCompleted, which is the pass it shares a tick with", async () => {
    const order: string[] = [];
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: {
        reconcileStranded: async () => [],
        auditCompleted: async () => {
          order.push("auditCompleted");
          return [];
        },
        auditTombstones: async (): Promise<TombstoneSweepPage> => {
          order.push("sweep");
          return pageOf();
        },
      },
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    expect(order).toEqual(["auditCompleted", "sweep"]);
  });

  it("reports a clean page, unlike onAuditFindings", async () => {
    const seen: TombstoneSweepPage[] = [];
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: sweeper().reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onTombstoneFindings: (page) => {
        seen.push(page);
      },
    });
    await s.runOnce();
    // The examined count *is* the claim: "we verified 412 proofs this lap" cannot be inferred from
    // the absence of a log line (ADR-0323), so a clean page is news here where findings-only is not.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.examined).toBe(412);
    expect(seen[0]?.findings).toEqual([]);
  });

  it("reports the clean page on the very same tick that onAuditFindings stays silent on", async () => {
    const swept: number[] = [];
    const audited: unknown[] = [];
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: sweeper().reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onAuditFindings: (f) => {
        audited.push(f);
      },
      onTombstoneFindings: (page) => {
        swept.push(page.examined);
      },
    });
    await s.runOnce();
    // Pinned together, and deliberately asymmetric: `auditCompleted` returns findings only, so an
    // empty array there means "nothing wrong" and is not news, while a sweep's empty findings list
    // without its count says nothing at all. A later unification of the two callbacks fails here.
    expect(audited).toEqual([]);
    expect(swept).toEqual([412]);
  });

  it("hands the findings through and awaits the callback", async () => {
    const seen: string[][] = [];
    let settled = false;
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: sweeper({
        pages: [
          pageOf({ examined: 2, findings: [sweepFinding(), sweepFinding("tomb_bbbbccccddddeeee")] }),
        ],
      }).reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onTombstoneFindings: async (page) => {
        await Promise.resolve();
        seen.push(page.findings.map((f) => f.tombstoneId));
        settled = true;
      },
    });
    await s.runOnce();
    expect(settled).toBe(true);
    expect(seen).toEqual([[TOMB, "tomb_bbbbccccddddeeee"]]);
  });

  it("advances the cursor to where the last page stopped", async () => {
    const sw = sweeper({ pages: [pageOf({ nextAfterTombstoneId: TOMB }), pageOf()] });
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: sw.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    await s.runOnce();
    // Without this the sweep re-reads page one forever: an audit that looks like it is running while
    // examining the same rows every tick and never reaching the ones a tamper is hiding in.
    expect(sw.calls).toEqual([{}, { afterTombstoneId: TOMB }]);
  });

  it("laps rather than stopping when a page reports the end of the table", async () => {
    const sw = sweeper({
      pages: [pageOf({ nextAfterTombstoneId: TOMB }), pageOf({ nextAfterTombstoneId: null })],
    });
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: sw.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
    });
    for (let i = 0; i < 3; i += 1) await s.runOnce();
    // A null cursor is "the end", and the end resets to the beginning — a tombstone tampered with
    // after the sweep passed it is found on the next lap, and nothing else finds it at all.
    expect(sw.calls).toEqual([{}, { afterTombstoneId: TOMB }, {}]);
  });

  it("does not lose its place when a page throws", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let n = 0;
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: {
        reconcileStranded: async () => [],
        auditTombstones: async (input): Promise<TombstoneSweepPage> => {
          calls.push({ ...input });
          n += 1;
          if (n === 2) throw new Error("the connection dropped mid-page");
          return pageOf({ nextAfterTombstoneId: TOMB });
        },
      },
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onError: () => undefined,
    });
    for (let i = 0; i < 3; i += 1) await s.runOnce();
    // The cursor is assigned after the await, so a failed page is retried from where it started
    // rather than skipped — a skipped page is a row nothing ever verifies.
    expect(calls).toEqual([{}, { afterTombstoneId: TOMB }, { afterTombstoneId: TOMB }]);
  });

  it("is a no-op for a reconciler that has no auditTombstones at all", async () => {
    let called = 0;
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: { reconcileStranded: async () => [], auditCompleted: async () => [] },
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onTombstoneFindings: () => {
        called += 1;
      },
    });
    // Optional on the mirror, so an older store simply does not get swept — not a throw at the first
    // audit tick.
    await expect(s.runOnce()).resolves.toBeUndefined();
    expect(called).toBe(0);
  });

  it("is a no-op with a cadence set and no reconciler wired", async () => {
    let called = 0;
    const s = new DeletionScheduler({
      runner: runner().runner,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onTombstoneFindings: () => {
        called += 1;
      },
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
    expect(called).toBe(0);
  });

  it("forwards auditLimit as the page size, and forwards nothing when it is absent", async () => {
    const withLimit = sweeper();
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: withLimit.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      auditLimit: 7,
      scheduler: fakeScheduler(),
    });
    await s.runOnce();
    expect(withLimit.calls).toEqual([{ limit: 7 }]);

    const noLimit = sweeper();
    const t = new DeletionScheduler({
      runner: runner().runner,
      reconciler: noLimit.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
    });
    await t.runOnce();
    // Omitted rather than defaulted here: the page size belongs to the store, which clamps it.
    expect(noLimit.calls).toEqual([{}]);
    expect("limit" in (noLimit.calls[0] ?? {})).toBe(false);
  });

  it("routes a throwing sweep to onError without skipping the run or repair passes", async () => {
    const errors: unknown[] = [];
    const ran: string[] = [];
    const s = new DeletionScheduler({
      runner: {
        runDue: async () => {
          ran.push("runDue");
          return [];
        },
      },
      reconciler: {
        reconcileStranded: async () => {
          ran.push("reconcile");
          return [];
        },
        auditTombstones: async (): Promise<TombstoneSweepPage> => {
          throw new Error("a stored tombstone will not parse");
        },
      },
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
    // It is inside the audit's own `try`, which is why the two passes that destroy and repair data
    // have already run by the time it throws.
    expect(ran).toEqual(["runDue", "reconcile"]);
    expect(errors).toHaveLength(1);
  });

  it("keeps sweeping on later ticks after one threw", async () => {
    const errors: unknown[] = [];
    const sw = sweeper({ throws: true });
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: sw.reconciler,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await s.runOnce();
    await s.runOnce();
    expect(sw.calls).toHaveLength(2);
    expect(errors).toHaveLength(2);
  });

  it("still sweeps on a tick whose auditCompleted threw", async () => {
    const sw: Array<Record<string, unknown>> = [];
    const errors: unknown[] = [];
    const s = new DeletionScheduler({
      runner: runner().runner,
      reconciler: {
        reconcileStranded: async () => [],
        auditCompleted: async () => {
          throw new Error("a completed request's row will not parse");
        },
        auditTombstones: async (input): Promise<TombstoneSweepPage> => {
          sw.push({ ...input });
          return pageOf();
        },
      },
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      onError: (e) => errors.push(e),
    });
    await s.runOnce();
    await s.runOnce();
    // The two directions get their own `try` (ADR-0327). They are separate facts, and the one most
    // likely to throw is `auditCompleted` — ADR-0323's whole point is that it re-parses stored rows
    // and an unparseable row *is* the finding. Sharing a `try` meant a store in exactly that state
    // had a sweep that silently never ran, while `onError` fired every tick: an audit that looks
    // like it is running.
    expect(sw).toHaveLength(2);
    expect(errors).toHaveLength(2);
  });
});

describe("DeletionScheduler — lap accounting (ADR-0328)", () => {
  const TOMB = "tomb_aaaabbbbccccdddd";
  const NEXT = "tomb_bbbbccccddddeeee";

  function pageOf(over: Partial<TombstoneSweepPage> = {}): TombstoneSweepPage {
    return { examined: 10, findings: [], nextAfterTombstoneId: null, ...over };
  }

  function sweepFinding(id = TOMB): TombstoneSweepPage["findings"][number] {
    return {
      tombstoneId: id,
      tenantId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
      reference: "unreferenced",
      relatedDeletionRequestId: null,
      detail: "does not verify: scope_tampered",
    };
  }

  /** Pages in order, the last repeating, so the counters are observable across ticks. */
  function sweeper(
    behaviour: { throws?: boolean; pages?: readonly TombstoneSweepPage[] } = {},
  ): StrandedReconcilerLike {
    let n = 0;
    return {
      reconcileStranded: async () => [],
      auditTombstones: async (): Promise<TombstoneSweepPage> => {
        if (behaviour.throws === true) throw new Error("the connection dropped mid-page");
        const pages = behaviour.pages ?? [pageOf()];
        const page = pages[Math.min(n, pages.length - 1)] ?? pageOf();
        n += 1;
        return page;
      },
    };
  }

  /** A clock that steps a whole minute per read, so each timestamp is distinguishable. */
  function steppingClock(): () => Date {
    let ms = Date.parse("2026-10-04T00:00:00.000Z");
    return (): Date => {
      const d = new Date(ms);
      ms += 60_000;
      return d;
    };
  }

  function build(
    over: Partial<ConstructorParameters<typeof DeletionScheduler>[0]> = {},
  ): DeletionScheduler {
    return new DeletionScheduler({
      runner: runner().runner,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      clock: steppingClock(),
      ...over,
    });
  }

  it("reports an untouched sweep before anything has run", () => {
    const p = build({ reconciler: sweeper() }).sweepProgress();
    // Zero laps with a null `examinedLastLap` is the one state that means "no claim can be made
    // yet" — distinct from a lap that examined nothing, which is a figure.
    expect(p).toEqual({
      lapsCompleted: 0,
      examinedThisLap: 0,
      examinedLastLap: null,
      lastLapCompletedAt: null,
      cursor: null,
      findingsThisLap: 0,
      findingsLastLap: null,
      pagesAdvanced: 0,
      pagesSwept: 0,
      lastAdvanceAt: null,
      // Null, and null for the same reason an untouched sweep makes no claim: nothing has been
      // attempted, so an absence of motion says nothing yet (ADR-0329).
      stall: null,
    });
  });

  it("accumulates examined across two part-pages of one lap", async () => {
    const s = build({
      reconciler: sweeper({
        pages: [
          pageOf({ examined: 100, nextAfterTombstoneId: TOMB }),
          pageOf({ examined: 60, nextAfterTombstoneId: NEXT }),
        ],
      }),
    });
    await s.runOnce();
    expect(s.sweepProgress().examinedThisLap).toBe(100);
    await s.runOnce();
    // The lap is the unit of the claim, so a page is a contribution to it and not a claim of its own.
    expect(s.sweepProgress()).toMatchObject({
      examinedThisLap: 160,
      examinedLastLap: null,
      lapsCompleted: 0,
      cursor: NEXT,
    });
  });

  it("completes a lap on the page that does not fill, keying on the same null the cursor does", async () => {
    const s = build({
      reconciler: sweeper({
        pages: [
          pageOf({ examined: 100, nextAfterTombstoneId: TOMB }),
          pageOf({ examined: 12, nextAfterTombstoneId: null }),
        ],
      }),
    });
    await s.runOnce();
    await s.runOnce();
    // One signal for "the lap ended": the null that also resets the cursor. A second, independently
    // derived one (examined < limit, say) is how the two come to disagree.
    expect(s.sweepProgress()).toMatchObject({
      lapsCompleted: 1,
      examinedLastLap: 112,
      examinedThisLap: 0,
      cursor: null,
    });
  });

  it("takes examinedLastLap from the running figure before resetting it", async () => {
    const s = build({ reconciler: sweeper({ pages: [pageOf({ examined: 412 })] }) });
    await s.runOnce();
    const p = s.sweepProgress();
    // Reset first and the only number the caller wants is destroyed; this pins the order.
    expect(p.examinedLastLap).toBe(412);
    expect(p.examinedThisLap).toBe(0);
  });

  it("stamps lastLapCompletedAt from the injected clock, not the wall clock", async () => {
    const s = build({
      reconciler: sweeper({ pages: [pageOf()] }),
      clock: () => new Date("2026-10-04T11:22:33.000Z"),
    });
    await s.runOnce();
    expect(s.sweepProgress().lastLapCompletedAt).toBe("2026-10-04T11:22:33.000Z");
  });

  it("leaves lastLapCompletedAt alone on a page that does not end the lap", async () => {
    const s = build({
      reconciler: sweeper({ pages: [pageOf({ nextAfterTombstoneId: TOMB })] }),
    });
    await s.runOnce();
    expect(s.sweepProgress().lastLapCompletedAt).toBeNull();
    // But the page still moved the sweep, which is a different question and gets a different field.
    expect(s.sweepProgress().lastAdvanceAt).not.toBeNull();
  });

  it("counts a second lap and re-stamps the timestamp", async () => {
    const s = build({
      reconciler: sweeper({
        pages: [
          pageOf({ examined: 5, nextAfterTombstoneId: TOMB }),
          pageOf({ examined: 7, nextAfterTombstoneId: null }),
          pageOf({ examined: 9, nextAfterTombstoneId: null }),
        ],
      }),
    });
    for (let i = 0; i < 3; i += 1) await s.runOnce();
    const p = s.sweepProgress();
    expect(p.lapsCompleted).toBe(2);
    // The second lap's own total, not a running sum across laps: "verified since <time>" is a claim
    // about one pass of the table.
    expect(p.examinedLastLap).toBe(9);
    expect(p.lastLapCompletedAt).toBe("2026-10-04T00:02:00.000Z");
  });

  it("counts findings per lap and resets them with the lap", async () => {
    const s = build({
      reconciler: sweeper({
        pages: [
          pageOf({ examined: 3, findings: [sweepFinding()], nextAfterTombstoneId: TOMB }),
          pageOf({ examined: 3, findings: [sweepFinding(NEXT)], nextAfterTombstoneId: null }),
          pageOf({ examined: 3, nextAfterTombstoneId: null }),
        ],
      }),
    });
    await s.runOnce();
    expect(s.sweepProgress().findingsThisLap).toBe(1);
    await s.runOnce();
    expect(s.sweepProgress()).toMatchObject({ findingsLastLap: 2, findingsThisLap: 0 });
    await s.runOnce();
    // A clean lap after a dirty one reports zero, which is the whole point of a per-lap figure: a
    // running total would never come back down once a tamper had been found and put right.
    expect(s.sweepProgress()).toMatchObject({ findingsLastLap: 0, findingsThisLap: 0 });
  });

  it("leaves every counter untouched when a page throws", async () => {
    let n = 0;
    const s = build({
      reconciler: {
        reconcileStranded: async () => [],
        auditTombstones: async (): Promise<TombstoneSweepPage> => {
          n += 1;
          if (n === 2) throw new Error("the connection dropped mid-page");
          return pageOf({ examined: 40, nextAfterTombstoneId: TOMB });
        },
      },
      onError: () => undefined,
    });
    await s.runOnce();
    const before = s.sweepProgress();
    await s.runOnce();
    // A page that threw examined nothing. Every figure moving on a page that never arrived is
    // exactly the "sweep that looks like it is running" this accounting exists to expose.
    expect(s.sweepProgress()).toEqual(before);
  });

  it("resumes the lap's total after a throw rather than restarting it", async () => {
    let n = 0;
    const s = build({
      reconciler: {
        reconcileStranded: async () => [],
        auditTombstones: async (): Promise<TombstoneSweepPage> => {
          n += 1;
          if (n === 2) throw new Error("the connection dropped mid-page");
          return pageOf({ examined: 40, nextAfterTombstoneId: n === 1 ? TOMB : null });
        },
      },
      onError: () => undefined,
    });
    for (let i = 0; i < 3; i += 1) await s.runOnce();
    // The cursor did not move, so the retried page is the same rows — and the lap's total is the
    // first page plus the retry's, with nothing counted for the attempt that failed.
    expect(s.sweepProgress()).toMatchObject({ lapsCompleted: 1, examinedLastLap: 80, pagesSwept: 2 });
  });

  it("counts a page as advancing only when it moves the sweep's position", async () => {
    const s = build({
      reconciler: sweeper({ pages: [pageOf({ examined: 10, nextAfterTombstoneId: TOMB })] }),
    });
    for (let i = 0; i < 3; i += 1) await s.runOnce();
    const p = s.sweepProgress();
    // A store answering the same page forever: pages keep coming back, the cursor never moves, and
    // the rows a tamper is hiding in are never reached. `pagesSwept` says pages arrive;
    // `pagesAdvanced` says they covered nothing new — which is what a caller reads to tell the two
    // stall shapes apart.
    expect(p.pagesSwept).toBe(3);
    expect(p.pagesAdvanced).toBe(1);
    expect(p.lastAdvanceAt).toBe("2026-10-04T00:00:00.000Z");
  });

  it("keeps advancing while the cursor walks the table", async () => {
    const s = build({
      reconciler: sweeper({
        pages: [
          pageOf({ nextAfterTombstoneId: TOMB }),
          pageOf({ nextAfterTombstoneId: NEXT }),
          pageOf({ nextAfterTombstoneId: null }),
        ],
      }),
    });
    for (let i = 0; i < 3; i += 1) await s.runOnce();
    const p = s.sweepProgress();
    // The healthy direction, pinned beside the stuck one: three pages, three advances, and the last
    // one lands back on null because it finished the lap rather than because it stopped moving.
    expect(p.pagesAdvanced).toBe(3);
    expect(p.pagesSwept).toBe(3);
    expect(p.lastAdvanceAt).toBe("2026-10-04T00:02:00.000Z");
  });

  it("counts the end of the table as an advance even though the cursor lands back on null", async () => {
    const s = build({ reconciler: sweeper({ pages: [pageOf({ examined: 0 })] }) });
    await s.runOnce();
    await s.runOnce();
    // An empty or single-page table laps every tick. The cursor is null before and after, so a
    // cursor-changed test alone would read a working sweep as stuck.
    expect(s.sweepProgress()).toMatchObject({ lapsCompleted: 2, pagesAdvanced: 2 });
  });

  it("does not advance when the sweep is never called at all", async () => {
    const s = build({ reconciler: { reconcileStranded: async () => [] } });
    await s.runOnce();
    await s.runOnce();
    // The other stall shape: no store offers `auditTombstones`, so nothing is being verified. Equal
    // counters is what tells a caller it is this one rather than a pinned cursor.
    expect(s.sweepProgress()).toMatchObject({ pagesSwept: 0, pagesAdvanced: 0, lastAdvanceAt: null });
  });

  it("does not advance on ticks the audit cadence skips", async () => {
    const s = build({
      reconciler: sweeper({ pages: [pageOf({ nextAfterTombstoneId: TOMB })] }),
      auditEveryTicks: 3,
    });
    await s.runOnce();
    await s.runOnce();
    expect(s.sweepProgress().pagesSwept).toBe(0);
    await s.runOnce();
    // So `lastAdvanceAt` must be read against the *audit* cadence, not the tick interval.
    expect(s.sweepProgress().pagesSwept).toBe(1);
  });

  it("hands the progress to onTombstoneFindings alongside the page", async () => {
    const lines: string[] = [];
    const s = build({
      reconciler: sweeper({
        pages: [
          pageOf({ examined: 200, nextAfterTombstoneId: TOMB }),
          pageOf({ examined: 212, nextAfterTombstoneId: null }),
        ],
      }),
      onTombstoneFindings: (page, progress) => {
        lines.push(
          `${page.examined.toString()}/${progress.examinedThisLap.toString()}/${progress.lapsCompleted.toString()}`,
        );
      },
    });
    await s.runOnce();
    await s.runOnce();
    // A sink can log the lap and not just the page — "lap 1 complete, 412 proofs verified" — which is
    // the sentence the claim is actually made in.
    expect(lines).toEqual(["200/200/0", "212/0/1"]);
  });

  it("gives the callback a snapshot that already includes this page's lap boundary", async () => {
    const seen: number[] = [];
    const s = build({
      reconciler: sweeper({ pages: [pageOf({ examined: 412 })] }),
      onTombstoneFindings: (_page, progress) => {
        seen.push(progress.examinedLastLap ?? -1);
      },
    });
    await s.runOnce();
    // Accounted before the callback, so a sink that reports the finished lap does not have to wait
    // for the next tick to learn its total.
    expect(seen).toEqual([412]);
  });

  it("gives the callback a snapshot, not a live view of the scheduler", async () => {
    const held: ReturnType<DeletionScheduler["sweepProgress"]>[] = [];
    const s = build({
      reconciler: sweeper({
        pages: [pageOf({ examined: 1, nextAfterTombstoneId: TOMB }), pageOf({ examined: 1 })],
      }),
      onTombstoneFindings: (_page, progress) => {
        held.push(progress);
      },
    });
    await s.runOnce();
    await s.runOnce();
    expect(held[0]?.examinedThisLap).toBe(1);
    expect(held[1]?.lapsCompleted).toBe(1);
  });

  it("accounts for the page even when the findings callback throws", async () => {
    const errors: unknown[] = [];
    const s = build({
      reconciler: sweeper({ pages: [pageOf({ examined: 412 })] }),
      onTombstoneFindings: () => {
        throw new Error("the log sink is gone");
      },
      onError: (e) => errors.push(e),
    });
    await s.runOnce();
    // The rows *were* examined. A logging failure must not retract a verification that happened, or
    // the lap's coverage would depend on whether anybody was listening.
    expect(errors).toHaveLength(1);
    expect(s.sweepProgress()).toMatchObject({ lapsCompleted: 1, examinedLastLap: 412 });
  });

  it("does not reset lap accounting across stop() and start()", async () => {
    const sched = fakeScheduler();
    const s = build({ reconciler: sweeper({ pages: [pageOf({ examined: 9 })] }), scheduler: sched });
    await s.runOnce();
    s.start();
    s.stop();
    s.start();
    // A config reload has not swept the table again. Resetting here would make a lap boundary a
    // statement about the process rather than about the table, which is the same reason `ticks`
    // survives a restart.
    expect(s.sweepProgress()).toMatchObject({ lapsCompleted: 1, examinedLastLap: 9 });
  });

  it("reads the clock once per page, so a lap's two timestamps agree", async () => {
    const s = build({ reconciler: sweeper({ pages: [pageOf()] }) });
    await s.runOnce();
    const p = s.sweepProgress();
    // One read per page rather than one per field: with a real clock, two reads could stamp an
    // advance and the lap it completed a millisecond apart for no reason a reader could explain.
    expect(p.lastAdvanceAt).toBe(p.lastLapCompletedAt);
  });

  it("does not read the clock at all on a tick that sweeps nothing", async () => {
    let reads = 0;
    const s = build({
      reconciler: { reconcileStranded: async () => [] },
      clock: (): Date => {
        reads += 1;
        return new Date("2026-10-04T00:00:00.000Z");
      },
    });
    await s.runOnce();
    expect(reads).toBe(0);
  });

  it("counts the lap the page reports even when a limit makes every lap empty", async () => {
    const s = build({ reconciler: sweeper({ pages: [pageOf({ examined: 0 })] }) });
    for (let i = 0; i < 4; i += 1) await s.runOnce();
    // A `limit` that resolves to 0 laps constantly over nothing. The counters do not hide it: laps
    // climb while `examinedLastLap` stays 0, which reads as "covering no rows" rather than as health.
    expect(s.sweepProgress()).toMatchObject({ lapsCompleted: 4, examinedLastLap: 0 });
  });
});

describe("DeletionScheduler — a sweep that says it stalled (ADR-0329)", () => {
  const TOMB = "tomb_aaaabbbbccccdddd";
  const NEXT = "tomb_bbbbccccddddeeee";

  function pageOf(over: Partial<TombstoneSweepPage> = {}): TombstoneSweepPage {
    return { examined: 10, findings: [], nextAfterTombstoneId: null, ...over };
  }

  /** A page, or a page that never arrives — the two shapes the stall exists to tell apart. */
  type Step = TombstoneSweepPage | "throws";

  /** Steps in order, the last repeating, so a condition can be made to persist across ticks. */
  function sweeper(steps: readonly Step[]): StrandedReconcilerLike {
    let n = 0;
    return {
      reconcileStranded: async () => [],
      auditTombstones: async (): Promise<TombstoneSweepPage> => {
        const step = steps[Math.min(n, steps.length - 1)] ?? pageOf();
        n += 1;
        if (step === "throws") throw new Error("the connection dropped mid-page");
        return step;
      },
    };
  }

  function build(
    over: Partial<ConstructorParameters<typeof DeletionScheduler>[0]> = {},
  ): DeletionScheduler {
    return new DeletionScheduler({
      runner: runner().runner,
      intervalMs: 1000,
      auditEveryTicks: 1,
      scheduler: fakeScheduler(),
      clock: (): Date => new Date("2026-10-04T00:00:00.000Z"),
      onError: () => undefined,
      ...over,
    });
  }

  async function tick(s: DeletionScheduler, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) await s.runOnce();
  }

  it("names the two shapes and the attempts it takes to be sure", () => {
    // The remedies share nothing: `no_pages` is a store or a connection and the exception is on
    // `onError`; `pinned_cursor` is the table, and the row after the cursor is the suspect.
    expect(SWEEP_STALL_KINDS).toEqual(["no_pages", "pinned_cursor"]);
    expect(DEFAULT_SWEEP_STALL_ATTEMPTS).toBe(3);
  });

  it("says nothing until enough attempts have failed to advance", async () => {
    const s = build({ reconciler: sweeper([pageOf({ nextAfterTombstoneId: TOMB })]) });
    // Page one advances (null -> TOMB); pages two and three are the same rows over again.
    await tick(s, 3);
    expect(s.sweepProgress().pagesAdvanced).toBe(1);
    // Two non-advancing attempts is a blip, and the sweep is designed to retry a failed page from
    // the same place — an alarm on the blip is one an operator mutes.
    expect(s.sweepProgress().stall).toBeNull();
  });

  it("concludes a pinned cursor once the condition is standing", async () => {
    const s = build({ reconciler: sweeper([pageOf({ nextAfterTombstoneId: TOMB })]) });
    await tick(s, 4);
    const stall = s.sweepProgress().stall;
    expect(stall?.kind).toBe("pinned_cursor");
    expect(stall?.attemptsWithoutAdvance).toBe(3);
    // Pages *are* arriving, which is the whole distinction: three came back and covered nothing new.
    expect(stall?.pagesWithoutAdvance).toBe(3);
    expect(stall?.cursor).toBe(TOMB);
    expect(stall?.detail).toContain(TOMB);
  });

  it("concludes no pages when every attempt throws", async () => {
    const s = build({ reconciler: sweeper(["throws"]) });
    await tick(s, 3);
    const stall = s.sweepProgress().stall;
    expect(stall?.kind).toBe("no_pages");
    // Counted before the await, so an attempt that threw is still an attempt — a counter that moved
    // only on success would be silent for exactly the failure it exists to report.
    expect(stall?.attemptsWithoutAdvance).toBe(3);
    expect(stall?.pagesWithoutAdvance).toBe(0);
    expect(stall?.lastAdvanceAt).toBeNull();
    expect(stall?.detail).toContain("no stored Article 17 proof is being verified");
  });

  it("calls a mixture of throws and pinned pages a pinned cursor", async () => {
    const s = build({
      reconciler: sweeper([
        pageOf({ nextAfterTombstoneId: TOMB }),
        "throws",
        pageOf({ nextAfterTombstoneId: TOMB }),
      ]),
    });
    await tick(s, 4);
    const stall = s.sweepProgress().stall;
    // Pages are coming back, so the store is reachable and the remedy is the table — the opposite
    // message from `no_pages`, on a tick that also threw.
    expect(stall?.kind).toBe("pinned_cursor");
    expect(stall?.pagesWithoutAdvance).toBe(2);
    expect(stall?.attemptsWithoutAdvance).toBe(3);
  });

  it("never reports an empty tombstone table as stalled", async () => {
    const s = build({ reconciler: sweeper([pageOf({ examined: 0 })]) });
    await tick(s, 10);
    // An empty table laps every tick with a null cursor on both sides. A cursor-comparison test
    // would call this stalled on every deployment that has never deleted a tenant — and an alarm
    // that cries wolf there costs the real one.
    expect(s.sweepProgress()).toMatchObject({ lapsCompleted: 10, stall: null });
  });

  it("never reports a single-page table as stalled", async () => {
    const s = build({ reconciler: sweeper([pageOf({ examined: 7 })]) });
    await tick(s, 10);
    // The same shape with rows in it: the whole table is verified every tick, which is the healthiest
    // a sweep gets. The end of the table counts as motion (ADR-0328), which is what makes this work.
    expect(s.sweepProgress()).toMatchObject({ examinedLastLap: 7, pagesAdvanced: 10, stall: null });
  });

  it("never reports a deployment whose reconciler has no sweep", async () => {
    let called = 0;
    const s = build({
      reconciler: { reconcileStranded: async () => [], auditCompleted: async () => [] },
      onSweepStall: () => {
        called += 1;
      },
    });
    await tick(s, 10);
    // There is no sweep to stall. That the deployment has none is a configuration fact, visible at
    // boot, and claiming a stall over it would fire on every reconciler that predates ADR-0327.
    expect(s.sweepProgress().stall).toBeNull();
    expect(called).toBe(0);
  });

  it("never reports a deployment with no audit cadence", async () => {
    const s = build({
      reconciler: sweeper([pageOf({ nextAfterTombstoneId: TOMB })]),
      auditEveryTicks: 0,
    });
    await tick(s, 10);
    // The sweep rides the audit's cadence, so this deployment opted out of both. Nothing was ever
    // attempted, and an absence of motion says nothing about a sweep that never ran.
    expect(s.sweepProgress()).toMatchObject({ pagesSwept: 0, stall: null });
  });

  it("stops being stalled the moment a page moves the position again", async () => {
    const s = build({
      reconciler: sweeper([
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: NEXT }),
      ]),
    });
    await tick(s, 4);
    expect(s.sweepProgress().stall?.kind).toBe("pinned_cursor");
    await s.runOnce();
    // Motion is what clears it, and both counters reset together — a counter left standing would
    // keep the conclusion up over a sweep that has recovered.
    expect(s.sweepProgress().stall).toBeNull();
    expect(s.sweepProgress().cursor).toBe(NEXT);
  });

  it("counts attempts in audit ticks, not in ticks", async () => {
    const s = build({
      reconciler: sweeper([pageOf({ nextAfterTombstoneId: TOMB })]),
      auditEveryTicks: 3,
    });
    await tick(s, 9);
    // Three sweeps in nine ticks, of which the first advanced. A figure in ticks or milliseconds
    // would have to be read against `auditEveryTicks` to mean anything.
    expect(s.sweepProgress().pagesSwept).toBe(3);
    expect(s.sweepProgress().stall).toBeNull();
    await tick(s, 3);
    expect(s.sweepProgress().stall?.attemptsWithoutAdvance).toBe(3);
  });

  it("hands the conclusion to onSweepStall and awaits it", async () => {
    const seen: TombstoneSweepStall[] = [];
    let settled = false;
    const s = build({
      reconciler: sweeper([pageOf({ nextAfterTombstoneId: TOMB })]),
      onSweepStall: async (stall) => {
        await Promise.resolve();
        seen.push(stall);
        settled = true;
      },
    });
    await tick(s, 4);
    expect(settled).toBe(true);
    expect(seen.map((x) => x.kind)).toEqual(["pinned_cursor"]);
  });

  it("reports the no-pages stall even though no page arrived to report it with", async () => {
    const stalls: TombstoneSweepStall[] = [];
    const findings: number[] = [];
    const s = build({
      reconciler: sweeper(["throws"]),
      onTombstoneFindings: (page) => {
        findings.push(page.examined);
      },
      onSweepStall: (stall) => {
        stalls.push(stall);
      },
    });
    await tick(s, 3);
    // The half of the failure that matters most never reaches `onTombstoneFindings` at all: a
    // throwing sweep has no page to hand it. Before the sweep got its own `try` the stall check sat
    // behind the throw, so the one surface that could say "no proof is being verified" was skipped
    // on precisely the ticks it was true.
    expect(findings).toEqual([]);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.kind).toBe("no_pages");
  });

  it("keeps reporting while the condition stands, with a growing figure", async () => {
    const stalls: number[] = [];
    const s = build({
      reconciler: sweeper(["throws"]),
      onSweepStall: (stall) => {
        stalls.push(stall.attemptsWithoutAdvance);
      },
    });
    await tick(s, 6);
    // A stall is a standing condition, not an event. Announced once it would read as resolved by the
    // next morning; the growing figure is what lets a sink show it hardening rather than repeat one
    // sentence, and deduping belongs to the sink, as it already does for the sweep's findings.
    expect(stalls).toEqual([3, 4, 5, 6]);
  });

  it("does not report before the threshold", async () => {
    const stalls: TombstoneSweepStall[] = [];
    const s = build({
      reconciler: sweeper(["throws"]),
      onSweepStall: (stall) => {
        stalls.push(stall);
      },
    });
    await tick(s, 2);
    expect(stalls).toEqual([]);
  });

  it("takes a configured threshold", async () => {
    const s = build({
      reconciler: sweeper([pageOf({ nextAfterTombstoneId: TOMB })]),
      stallAfterAttempts: 1,
    });
    await tick(s, 2);
    expect(s.sweepProgress().stall?.attemptsWithoutAdvance).toBe(1);
  });

  it("reads a malformed threshold as the default rather than as off", async () => {
    const s = build({
      reconciler: sweeper(["throws"]),
      stallAfterAttempts: 0,
    });
    await tick(s, 2);
    expect(s.sweepProgress().stall).toBeNull();
    await s.runOnce();
    // The opposite of `auditEveryTicks`, deliberately: there, off is the status quo and the surprise
    // is an expensive pass every tick. Here, off is exactly the silence ADR-0328 named, so a
    // malformed flag must not buy it.
    expect(s.sweepProgress().stall?.attemptsWithoutAdvance).toBe(3);
  });

  it("gives the callback the same conclusion sweepProgress() reports", async () => {
    const stalls: TombstoneSweepStall[] = [];
    const s = build({
      reconciler: sweeper([pageOf({ nextAfterTombstoneId: TOMB })]),
      onSweepStall: (stall) => {
        stalls.push(stall);
      },
    });
    await tick(s, 4);
    // One definition of "stalled", read twice: a surface asked between ticks must not be able to
    // disagree with the line that was logged.
    expect(s.sweepProgress().stall).toEqual(stalls[0]);
  });

  it("carries the last advance, so an operator can see how long the table has been uncovered", async () => {
    let ms = Date.parse("2026-10-04T00:00:00.000Z");
    const s = build({
      reconciler: sweeper([pageOf({ nextAfterTombstoneId: TOMB })]),
      clock: (): Date => {
        const d = new Date(ms);
        ms += 60_000;
        return d;
      },
    });
    await tick(s, 4);
    // The advance that stamped it is the first page's; the three since then covered nothing, and
    // that gap is the figure a human reads.
    expect(s.sweepProgress().stall?.lastAdvanceAt).toBe("2026-10-04T00:00:00.000Z");
  });

  it("routes a throwing stall callback to onError without failing the tick", async () => {
    const errors: unknown[] = [];
    const s = build({
      reconciler: sweeper([pageOf({ nextAfterTombstoneId: TOMB })]),
      onSweepStall: () => {
        throw new Error("the log sink is gone");
      },
      onError: (e) => errors.push(e),
    });
    await expect(s.runOnce()).resolves.toBeUndefined();
    await tick(s, 3);
    // The sweep's accounting is unaffected: a sink that cannot take the news does not retract the
    // condition, exactly as a failing findings callback does not retract a verification.
    expect(errors).toHaveLength(1);
    expect(s.sweepProgress().stall?.kind).toBe("pinned_cursor");
  });

  it("does not stop the passes that destroy and repair data", async () => {
    const ran: string[] = [];
    const s = build({
      runner: {
        runDue: async () => {
          ran.push("runDue");
          return [];
        },
      },
      reconciler: {
        reconcileStranded: async () => {
          ran.push("reconcile");
          return [];
        },
        auditTombstones: async (): Promise<TombstoneSweepPage> => {
          throw new Error("the connection dropped mid-page");
        },
      },
      onSweepStall: () => undefined,
    });
    await tick(s, 3);
    // A stalled sweep is a failure of the audit, not of the deletion flow. The two queues share one
    // interval and nothing else.
    expect(ran.filter((x) => x === "runDue")).toHaveLength(3);
    expect(ran.filter((x) => x === "reconcile")).toHaveLength(3);
  });
});

describe("DeletionScheduler — a sweep that says it recovered (ADR-0329)", () => {
  const TOMB = "tomb_aaaabbbbccccdddd";
  const NEXT = "tomb_bbbbccccddddeeee";

  function pageOf(over: Partial<TombstoneSweepPage> = {}): TombstoneSweepPage {
    return { examined: 10, findings: [], nextAfterTombstoneId: null, ...over };
  }

  type Step = TombstoneSweepPage | "throws";

  /** Steps in order, the last repeating. */
  function sweeper(steps: readonly Step[]): StrandedReconcilerLike {
    let n = 0;
    return {
      reconcileStranded: async () => [],
      auditTombstones: async (): Promise<TombstoneSweepPage> => {
        const step = steps[Math.min(n, steps.length - 1)] ?? pageOf();
        n += 1;
        if (step === "throws") throw new Error("the connection dropped mid-page");
        return step;
      },
    };
  }

  function build(
    over: Partial<ConstructorParameters<typeof DeletionScheduler>[0]> = {},
  ): DeletionScheduler {
    return new DeletionScheduler({
      runner: runner().runner,
      intervalMs: 1000,
      auditEveryTicks: 1,
      clock: (): Date => new Date("2026-10-04T00:00:00.000Z"),
      onError: () => undefined,
      ...over,
    });
  }

  async function tick(s: DeletionScheduler, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) await s.runOnce();
  }

  it("says nothing about a sweep that has never stalled", async () => {
    const recovered: TombstoneSweepProgress[] = [];
    const s = build({
      reconciler: sweeper([pageOf()]),
      onSweepRecovered: (p) => {
        recovered.push(p);
      },
    });
    await tick(s, 10);
    // Edge-triggered: a sink hears from this only as the answer to a stall it was told about, so it
    // never has to remember whether it was told the opposite.
    expect(recovered).toEqual([]);
    expect(s.sweepProgress().lapsCompleted).toBe(10);
  });

  it("announces the recovery once, when a page moves the cursor again", async () => {
    const recovered: TombstoneSweepProgress[] = [];
    const stalls: number[] = [];
    const s = build({
      reconciler: sweeper([
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: NEXT }),
      ]),
      onSweepStall: (stall) => {
        stalls.push(stall.attemptsWithoutAdvance);
      },
      onSweepRecovered: (p) => {
        recovered.push(p);
      },
    });
    await tick(s, 4);
    expect(stalls).toEqual([3]);
    expect(recovered).toEqual([]);
    await tick(s, 3);
    // Once, not once per healthy tick. The condition is over; repeating it would be the shape the
    // stall line deliberately has and a recovery deliberately does not.
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.stall).toBeNull();
    expect(recovered[0]?.cursor).toBe(NEXT);
  });

  it("carries the evidence the recovery is drawn from", async () => {
    let ms = Date.parse("2026-10-04T00:00:00.000Z");
    const recovered: TombstoneSweepProgress[] = [];
    const s = build({
      reconciler: sweeper([
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: NEXT }),
      ]),
      clock: (): Date => {
        const d = new Date(ms);
        ms += 60_000;
        return d;
      },
      onSweepStall: () => undefined,
      onSweepRecovered: (p) => {
        recovered.push(p);
      },
    });
    await tick(s, 5);
    // An advance is **positive evidence**, not an absence of bad news: `pagesAdvanced` only moves in
    // the branch a page takes after it covered ground. That is why this recovery may be applied
    // automatically where ADR-0322's `never_committed` may not.
    expect(recovered[0]?.pagesAdvanced).toBe(2);
    expect(recovered[0]?.lastAdvanceAt).toBe("2026-10-04T00:04:00.000Z");
  });

  it("treats reaching the end of the table as the recovery too", async () => {
    const recovered: TombstoneSweepProgress[] = [];
    const s = build({
      reconciler: sweeper([
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: null }),
      ]),
      onSweepStall: () => undefined,
      onSweepRecovered: (p) => {
        recovered.push(p);
      },
    });
    await tick(s, 5);
    // The end of the table counts as motion (ADR-0328), which is the rule that keeps an empty or
    // single-page table from reading as stalled — and it has to clear a stall for the same reason.
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.lapsCompleted).toBe(1);
  });

  it("re-arms, so a sweep that stalls twice recovers twice", async () => {
    const stalls: number[] = [];
    const recovered: string[] = [];
    const s = build({
      reconciler: sweeper([
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: NEXT }),
        pageOf({ nextAfterTombstoneId: NEXT }),
        pageOf({ nextAfterTombstoneId: NEXT }),
        pageOf({ nextAfterTombstoneId: NEXT }),
        pageOf({ nextAfterTombstoneId: null }),
      ]),
      onSweepStall: (stall) => {
        stalls.push(stall.attemptsWithoutAdvance);
      },
      onSweepRecovered: () => {
        recovered.push("recovered");
      },
    });
    await tick(s, 9);
    // A flapping store is two episodes rather than one, because each was genuinely closed on
    // evidence in between — the opposite of the stall *kind* flipping, which is one episode.
    expect(stalls).toEqual([3, 3]);
    expect(recovered).toEqual(["recovered", "recovered"]);
  });

  it("retries a recovery its sink refused, and routes the failure to onError", async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const s = build({
      reconciler: sweeper([
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: NEXT }),
      ]),
      onSweepStall: () => undefined,
      onSweepRecovered: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("the incident store is unreachable");
      },
      onError: (e) => errors.push(e),
    });
    await tick(s, 5);
    expect(attempts).toBe(1);
    expect(errors).toHaveLength(1);
    await s.runOnce();
    // The flag is cleared only after the sink accepts it, so a resolution lost to a blip is
    // re-offered — otherwise an incident stays open for a sweep that is working.
    expect(attempts).toBe(2);
    await tick(s, 2);
    expect(attempts).toBe(2);
  });

  it("still recovers after a stall announcement its own sink refused", async () => {
    const recovered: string[] = [];
    const s = build({
      reconciler: sweeper([
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: NEXT }),
      ]),
      onSweepStall: () => {
        throw new Error("the log sink is gone");
      },
      onSweepRecovered: () => {
        recovered.push("recovered");
      },
    });
    await tick(s, 5);
    // The edge is armed *before* the stall is announced, for this case: the recovery is what closes
    // an incident, and arming it on a failed announcement costs only a recovery for an episode
    // nothing opened — which every resolution here answers with `none`.
    expect(recovered).toEqual(["recovered"]);
  });

  it("never announces one for a deployment with no sweep", async () => {
    const recovered: string[] = [];
    const s = build({
      reconciler: { reconcileStranded: async () => [], auditCompleted: async () => [] },
      onSweepStall: () => undefined,
      onSweepRecovered: () => {
        recovered.push("recovered");
      },
    });
    await tick(s, 10);
    // Nothing can recover from a stall that could not be concluded.
    expect(recovered).toEqual([]);
  });

  it("never announces one for a deployment with no audit cadence", async () => {
    const recovered: string[] = [];
    const s = build({
      reconciler: sweeper([pageOf({ nextAfterTombstoneId: TOMB })]),
      auditEveryTicks: 0,
      onSweepRecovered: () => {
        recovered.push("recovered");
      },
    });
    await tick(s, 10);
    expect(recovered).toEqual([]);
  });

  it("answers on the audit's cadence, not on every tick", async () => {
    const recovered: number[] = [];
    const s = build({
      auditEveryTicks: 2,
      reconciler: sweeper([
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: NEXT }),
      ]),
      onSweepStall: () => undefined,
      onSweepRecovered: (p) => {
        recovered.push(p.pagesSwept);
      },
    });
    await tick(s, 10);
    // The sweep rides the audit's cadence, so the recovery does too: five sweeps in ten ticks, the
    // fifth of which advanced.
    expect(recovered).toEqual([5]);
  });

  it("works with no recovery sink wired, and still clears the condition", async () => {
    const s = build({
      reconciler: sweeper([
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: TOMB }),
        pageOf({ nextAfterTombstoneId: NEXT }),
      ]),
      onSweepStall: () => undefined,
    });
    await tick(s, 5);
    expect(s.sweepProgress().stall).toBeNull();
  });
});
