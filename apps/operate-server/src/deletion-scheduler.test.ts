import { describe, expect, it } from "vitest";

import {
  DeletionScheduler,
  type StrandedReconcilerLike,
  type DeletionRunnerLike,
  type TombstoneSweepPage,
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
