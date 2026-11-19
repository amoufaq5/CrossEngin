import { describe, expect, it } from "vitest";

import { installProcessLifecycle, type ProcessLike } from "./process-lifecycle.js";

function fakeProcess() {
  const handlers = new Map<string, (arg?: unknown) => void>();
  const exits: number[] = [];
  const proc: ProcessLike = {
    on: ((event: string, listener: (arg?: unknown) => void) => {
      handlers.set(event, listener);
      return proc;
    }) as ProcessLike["on"],
    exit: (code: number) => {
      exits.push(code);
    },
  };
  const emit = (event: string, arg?: unknown): void => handlers.get(event)?.(arg);
  return { proc, emit, exits, handlers };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("installProcessLifecycle", () => {
  it("installs a handler for both signals and both process faults", () => {
    const { proc, handlers } = fakeProcess();
    installProcessLifecycle(proc, { close: async () => undefined, log: () => undefined, deadlineMs: 1000, setTimer: () => undefined });
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"]);
  });

  it("logs a stray rejection with its stack and keeps serving", async () => {
    const { proc, emit, exits } = fakeProcess();
    const lines: string[] = [];
    let closes = 0;
    const lifecycle = installProcessLifecycle(proc, {
      close: async () => {
        closes += 1;
      },
      log: (l) => lines.push(l),
      deadlineMs: 1000,
      setTimer: () => undefined,
    });
    emit("unhandledRejection", new Error("scheduler forgot a catch"));
    await tick();
    expect(lifecycle.unhandledRejections()).toBe(1);
    expect(lines[0]).toContain("scheduler forgot a catch");
    expect(lines[0]).toContain("serving continues");
    expect(closes).toBe(0);
    expect(exits).toEqual([]);
  });

  it("shuts down once on SIGTERM and exits 0, however many signals arrive", async () => {
    const { proc, emit, exits } = fakeProcess();
    let closes = 0;
    installProcessLifecycle(proc, {
      close: async () => {
        closes += 1;
      },
      log: () => undefined,
      deadlineMs: 1000,
      setTimer: () => undefined,
    });
    emit("SIGTERM");
    emit("SIGTERM");
    emit("SIGINT");
    await tick();
    expect(closes).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("drains on an uncaught exception and exits 1", async () => {
    const { proc, emit, exits } = fakeProcess();
    let closes = 0;
    installProcessLifecycle(proc, {
      close: async () => {
        closes += 1;
      },
      log: () => undefined,
      deadlineMs: 1000,
      setTimer: () => undefined,
    });
    emit("uncaughtException", new Error("corrupt"));
    await tick();
    expect(closes).toBe(1);
    expect(exits).toEqual([1]);
  });

  it("exits non-zero rather than rejecting when the close itself fails", async () => {
    const { proc, emit, exits } = fakeProcess();
    const lines: string[] = [];
    installProcessLifecycle(proc, {
      close: async () => {
        throw new Error("pool end failed");
      },
      log: (l) => lines.push(l),
      deadlineMs: 1000,
      setTimer: () => undefined,
    });
    emit("SIGTERM");
    await tick();
    expect(exits).toEqual([1]);
    expect(lines.join("\n")).toContain("pool end failed");
  });

  it("exits at the deadline when a drain hangs", async () => {
    const { proc, emit, exits } = fakeProcess();
    let fire: (() => void) | null = null;
    installProcessLifecycle(proc, {
      close: () => new Promise<void>(() => undefined),
      log: () => undefined,
      deadlineMs: 10_000,
      setTimer: (fn) => {
        fire = fn;
      },
    });
    emit("SIGTERM");
    await tick();
    expect(exits).toEqual([]);
    fire!();
    expect(exits).toEqual([1]);
  });
});
