import { describe, expect, it } from "vitest";

import { LeaseLostError, renewWhile, type ClaimRenewer } from "./renew.js";

/** A controllable sleep: each call parks until the test releases it, so heartbeat ticks are exact. */
function controllableSleep() {
  const gates: Array<() => void> = [];
  const sleep = (_ms: number): Promise<void> =>
    new Promise((resolve) => {
      gates.push(resolve);
    });
  return { sleep, releaseNext: () => gates.shift()?.() };
}

/** Flush pending microtasks + timers so a released heartbeat runs its renew and re-parks. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("renewWhile", () => {
  it("renews on each heartbeat while the task runs, then stops cleanly", async () => {
    const renews: Array<{ timerId: string; workerId: string; tenantId: string }> = [];
    const renewer: ClaimRenewer = {
      renew: async (o) => {
        renews.push(o);
        return true;
      },
    };
    const { sleep, releaseNext } = controllableSleep();

    let finishTask!: () => void;
    const task = new Promise<string>((r) => (finishTask = () => r("done")));
    const wrapped = renewWhile(task, {
      renewer,
      timerId: "wft_1",
      workerId: "w",
      tenantId: "t-1",
      intervalMs: 100,
      sleep,
    });

    releaseNext(); // heartbeat 1 → renew #1, re-parks
    await flush();
    releaseNext(); // heartbeat 2 → renew #2, re-parks
    await flush();
    expect(renews).toEqual([
      { timerId: "wft_1", workerId: "w", tenantId: "t-1" },
      { timerId: "wft_1", workerId: "w", tenantId: "t-1" },
    ]);

    finishTask(); // task done → done=true
    releaseNext(); // unpark the parked heartbeat so it observes done + exits (no extra renew)
    await expect(wrapped).resolves.toBe("done");
    expect(renews).toHaveLength(2);
  });

  it("stops the heartbeat and reports when a renewal returns false (lease lost)", async () => {
    let lost = false;
    const renewer: ClaimRenewer = { renew: async () => false };
    const { sleep, releaseNext } = controllableSleep();
    let finishTask!: () => void;
    const task = new Promise<void>((r) => (finishTask = r));
    const wrapped = renewWhile(task, {
      renewer,
      timerId: "wft_1",
      workerId: "w",
      tenantId: "t-1",
      intervalMs: 100,
      sleep,
      onLeaseLost: () => {
        lost = true;
      },
    });
    releaseNext(); // heartbeat → renew false → onLeaseLost + break
    await flush();
    expect(lost).toBe(true);
    finishTask(); // task still completes (firing is idempotent)
    await expect(wrapped).resolves.toBeUndefined();
  });

  it("does not renew when the task finishes before the first heartbeat", async () => {
    const renews: number[] = [];
    const renewer: ClaimRenewer = {
      renew: async () => {
        renews.push(1);
        return true;
      },
    };
    const { sleep, releaseNext } = controllableSleep();
    const wrapped = renewWhile(Promise.resolve("fast"), {
      renewer,
      timerId: "wft_1",
      workerId: "w",
      tenantId: "t-1",
      intervalMs: 100,
      sleep,
    });
    await flush(); // task already resolved → done=true; heartbeat parked on its first sleep
    releaseNext(); // unpark → heartbeat sees done → breaks WITHOUT renewing
    await expect(wrapped).resolves.toBe("fast");
    expect(renews).toEqual([]);
  });

  it("aborts a signal-taking task when a renew answers false, so a job handler stops writing", async () => {
    const renewer: ClaimRenewer = { renew: async () => false };
    const { sleep, releaseNext } = controllableSleep();
    let seen: AbortSignal | null = null;
    let finishTask!: () => void;
    const wrapped = renewWhile(
      (signal) => {
        seen = signal;
        return new Promise<void>((r) => (finishTask = r));
      },
      { renewer, timerId: "run_1", workerId: "w", tenantId: "t-1", intervalMs: 100, sleep },
    );
    expect((seen as AbortSignal | null)?.aborted).toBe(false);
    releaseNext(); // heartbeat → renew false → abort + onLeaseLost
    await flush();
    const signal = seen as unknown as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(LeaseLostError);
    expect((signal.reason as LeaseLostError).claimId).toBe("run_1");
    finishTask();
    await expect(wrapped).resolves.toBeUndefined();
  });

  it("does not abort when a renew throws, because the lease may still be held", async () => {
    let lost = false;
    const renewer: ClaimRenewer = {
      renew: async () => {
        throw new Error("connection reset");
      },
    };
    const { sleep, releaseNext } = controllableSleep();
    let seen: AbortSignal | null = null;
    let finishTask!: () => void;
    const wrapped = renewWhile(
      (signal) => {
        seen = signal;
        return new Promise<void>((r) => (finishTask = r));
      },
      {
        renewer,
        timerId: "run_1",
        workerId: "w",
        tenantId: "t-1",
        intervalMs: 100,
        sleep,
        onLeaseLost: () => {
          lost = true;
        },
      },
    );
    releaseNext();
    await flush();
    expect(lost).toBe(true);
    expect((seen as unknown as AbortSignal).aborted).toBe(false);
    finishTask();
    await wrapped;
  });

  it("keeps the signal unaborted while every renew succeeds", async () => {
    const renewer: ClaimRenewer = { renew: async () => true };
    const { sleep, releaseNext } = controllableSleep();
    let seen: AbortSignal | null = null;
    let finishTask!: () => void;
    const wrapped = renewWhile(
      (signal) => {
        seen = signal;
        return new Promise<void>((r) => (finishTask = r));
      },
      { renewer, timerId: "run_1", workerId: "w", tenantId: "t-1", intervalMs: 100, sleep },
    );
    releaseNext();
    await flush();
    releaseNext();
    await flush();
    expect((seen as unknown as AbortSignal).aborted).toBe(false);
    finishTask();
    releaseNext();
    await wrapped;
  });
});
