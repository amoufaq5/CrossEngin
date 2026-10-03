import { describe, expect, it } from "vitest";

import { abortWhile } from "./abort.js";

const immediate = (): Promise<void> => Promise.resolve();

/** Resolves when `deferred.resolve()` is called — lets a test hold a task open across probes. */
function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("abortWhile", () => {
  it("hands a task that finishes immediately an unaborted signal, and winds the watcher down", async () => {
    let probes = 0;
    const seen: boolean[] = [];
    const value = await abortWhile(
      async (signal) => {
        seen.push(signal.aborted);
        return "done";
      },
      {
        shouldAbort: async () => {
          probes += 1;
          return true;
        },
        intervalMs: 0,
        sleep: immediate,
      },
    );
    expect(value).toBe("done");
    expect(seen).toEqual([false]);
    // At most one probe can slip in before the `done` flag is set; never more.
    expect(probes).toBeLessThanOrEqual(1);
  });

  it("trips the signal mid-flight, carrying the reason, and fires onAbort exactly once", async () => {
    const gate = deferred();
    let cancelled = false;
    let aborts = 0;
    let capturedReason: unknown;
    const reason = new Error("cancelled by user:7");

    const result = await abortWhile(
      async (signal) => {
        // The handler waits for the watcher to notice, then cooperates.
        signal.addEventListener("abort", () => gate.resolve());
        cancelled = true;
        await gate.promise;
        capturedReason = signal.reason;
        return signal.aborted;
      },
      {
        shouldAbort: async () => cancelled,
        intervalMs: 0,
        sleep: immediate,
        reason,
        onAbort: () => {
          aborts += 1;
        },
      },
    );

    expect(result).toBe(true);
    expect(capturedReason).toBe(reason);
    expect(aborts).toBe(1);
  });

  it("does not stop a task that ignores the signal — it is a channel, not a kill", async () => {
    let probes = 0;
    const value = await abortWhile(
      async (signal) => {
        while (!signal.aborted) await immediate();
        // Deliberately keeps working after the abort.
        return "ignored the signal";
      },
      {
        shouldAbort: async () => {
          probes += 1;
          return true;
        },
        intervalMs: 0,
        sleep: immediate,
      },
    );
    expect(value).toBe("ignored the signal");
    expect(probes).toBe(1);
  });

  it("a probe that throws does not abort mid-flight work, and the next probe still decides", async () => {
    const gate = deferred();
    let probes = 0;
    const result = await abortWhile(
      async (signal) => {
        signal.addEventListener("abort", () => gate.resolve());
        await gate.promise;
        return signal.aborted;
      },
      {
        shouldAbort: async () => {
          probes += 1;
          if (probes < 3) throw new Error("db blip");
          return true;
        },
        intervalMs: 0,
        sleep: immediate,
      },
    );
    expect(result).toBe(true);
    expect(probes).toBe(3);
  });

  it("stops probing the moment the task settles, leaving no watcher behind", async () => {
    const gate = deferred();
    let probes = 0;
    await abortWhile(
      async () => {
        await gate.promise;
      },
      {
        shouldAbort: async () => {
          probes += 1;
          if (probes === 2) gate.resolve();
          return false;
        },
        intervalMs: 0,
        sleep: immediate,
      },
    );
    const after = probes;
    await immediate();
    await immediate();
    expect(probes).toBe(after);
  });

  it("propagates a task's rejection and still winds the watcher down", async () => {
    let probes = 0;
    await expect(
      abortWhile(
        async () => {
          throw new Error("handler blew up");
        },
        {
          shouldAbort: async () => {
            probes += 1;
            return false;
          },
          intervalMs: 0,
          sleep: immediate,
        },
      ),
    ).rejects.toThrow("handler blew up");
    expect(probes).toBeLessThanOrEqual(1);
  });
});
