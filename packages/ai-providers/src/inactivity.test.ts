import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MS,
  ProviderInactivityTimeout,
  resolveInactivityTimeoutMs,
  startInactivityWatchdog,
} from "./inactivity.js";

function streamOf(chunks: readonly string[], gapMs: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (i >= chunks.length) {
        ctrl.close();
        return;
      }
      await new Promise((r) => setTimeout(r, gapMs));
      ctrl.enqueue(enc.encode(chunks[i] ?? ""));
      i += 1;
    },
  });
}

/** A body that never produces a byte and records whether it was cancelled. */
function silentStream(): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
    cancel: () => {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
  }
}

describe("resolveInactivityTimeoutMs", () => {
  it("defaults when absent", () => {
    expect(resolveInactivityTimeoutMs(undefined)).toBe(DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MS);
  });
  it("refuses a value that is not a positive finite number", () => {
    expect(() => resolveInactivityTimeoutMs(0)).toThrow(/inactivity timeout/);
    expect(() => resolveInactivityTimeoutMs(Number.NaN)).toThrow(/inactivity timeout/);
    expect(() => resolveInactivityTimeoutMs(Number.POSITIVE_INFINITY)).toThrow(/inactivity timeout/);
  });
});

describe("startInactivityWatchdog", () => {
  it("lets a slow stream finish when every gap is under the timeout, whatever its total length", async () => {
    const wd = startInactivityWatchdog(200);
    try {
      // 12 chunks x 25ms = 300ms in total: half again the timeout, never silent for 200ms. The gap is
      // an eighth of the timeout because a full workspace sweep loads the CPU: at 30ms against 60ms
      // one late timer tick was enough to fire the watchdog and fail this test on a correct stream.
      const chunks = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
      const out = await drain(wd.watch(streamOf(chunks, 25)));
      expect(out).toBe(chunks.join(""));
      expect(wd.timedOut).toBe(false);
      expect(wd.signal.aborted).toBe(false);
    } finally {
      wd.dispose();
    }
  });

  it("rejects a pending read, aborts the signal and cancels the source when nothing arrives", async () => {
    const wd = startInactivityWatchdog(30);
    const silent = silentStream();
    try {
      await expect(drain(wd.watch(silent.stream))).rejects.toBeInstanceOf(ProviderInactivityTimeout);
      expect(wd.timedOut).toBe(true);
      expect(wd.signal.aborted).toBe(true);
      expect(silent.cancelled()).toBe(true);
    } finally {
      wd.dispose();
    }
  });

  it("cancelling the wrapper cancels the source, so an abandoned consumer releases the connection", async () => {
    const wd = startInactivityWatchdog(1000);
    const silent = silentStream();
    try {
      const reader = wd.watch(silent.stream).getReader();
      await reader.cancel("abandoned");
      expect(silent.cancelled()).toBe(true);
    } finally {
      wd.dispose();
    }
  });

  it("guards the header wait against a transport that ignores the signal", async () => {
    const wd = startInactivityWatchdog(30);
    try {
      await expect(wd.guard(new Promise<never>(() => undefined))).rejects.toBeInstanceOf(
        ProviderInactivityTimeout,
      );
    } finally {
      wd.dispose();
    }
  });

  it("passes a prompt result through and does not fire once disposed", async () => {
    const wd = startInactivityWatchdog(20);
    expect(await wd.guard(Promise.resolve(7))).toBe(7);
    wd.dispose();
    await new Promise((r) => setTimeout(r, 40));
    expect(wd.timedOut).toBe(false);
    expect(wd.signal.aborted).toBe(false);
  });
});
