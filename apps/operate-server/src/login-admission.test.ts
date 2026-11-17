import { describe, expect, it } from "vitest";

import {
  LOGIN_ADMISSION_REFUSALS,
  LOGIN_ADMISSION_REFUSAL_STATUS,
  LoginAdmission,
  buildShedReporter,
  defaultLoginAdmissionPolicy,
  libuvPoolSize,
  type Admission,
} from "./login-admission.js";

const admitted = (a: Admission): (() => void) => {
  if (!a.admitted) throw new Error(`expected admission, got ${a.refusal}`);
  return a.release;
};

describe("libuvPoolSize", () => {
  it("is 4 when unset, which is libuv's own default", () => {
    expect(libuvPoolSize({})).toBe(4);
    expect(libuvPoolSize({ UV_THREADPOOL_SIZE: "" })).toBe(4);
  });

  it("reads the configured size, capped at libuv's 1024", () => {
    expect(libuvPoolSize({ UV_THREADPOOL_SIZE: "16" })).toBe(16);
    expect(libuvPoolSize({ UV_THREADPOOL_SIZE: "99999" })).toBe(1024);
  });

  it("reads nonsense as 1, the conservative answer", () => {
    for (const v of ["0", "-3", "abc"]) expect(libuvPoolSize({ UV_THREADPOOL_SIZE: v }), v).toBe(1);
  });
});

describe("defaultLoginAdmissionPolicy", () => {
  it("leaves one pool thread for fs and dns", () => {
    expect(defaultLoginAdmissionPolicy(4)).toMatchObject({ concurrency: 3, queue: 12, perAccount: 2 });
    expect(defaultLoginAdmissionPolicy(16).concurrency).toBe(15);
  });

  it("still admits one at a time on a pool of one", () => {
    expect(defaultLoginAdmissionPolicy(1).concurrency).toBe(1);
  });
});

describe("LOGIN_ADMISSION_REFUSAL_STATUS", () => {
  it("is total, and neither status is the login's 401", () => {
    expect(Object.keys(LOGIN_ADMISSION_REFUSAL_STATUS).sort()).toEqual([...LOGIN_ADMISSION_REFUSALS].sort());
    expect(LOGIN_ADMISSION_REFUSAL_STATUS.saturated).toBe(503);
    expect(LOGIN_ADMISSION_REFUSAL_STATUS.account_busy).toBe(429);
  });
});

describe("LoginAdmission", () => {
  it("refuses an invalid policy rather than clamping it", () => {
    const ok = { concurrency: 1, queue: 0, perAccount: 1, retryAfterSeconds: 1 };
    expect(() => new LoginAdmission({ ...ok, concurrency: 0 })).toThrow(/concurrency/);
    expect(() => new LoginAdmission({ ...ok, queue: -1 })).toThrow(/queue/);
    expect(() => new LoginAdmission({ ...ok, perAccount: 0 })).toThrow(/per-account/);
    expect(() => new LoginAdmission({ ...ok, retryAfterSeconds: 0 })).toThrow(/Retry-After/);
  });

  it("runs at most `concurrency`, queues `queue`, and sheds the rest", async () => {
    const a = new LoginAdmission({ concurrency: 2, queue: 1, perAccount: 9, retryAfterSeconds: 2 });
    const r1 = admitted(await a.enter("a"));
    admitted(await a.enter("b"));
    const queued = a.enter("c");
    expect(a.snapshot()).toEqual({ active: 2, queued: 1 });
    expect(await a.enter("d")).toEqual({ admitted: false, refusal: "saturated", retryAfterSeconds: 2 });
    r1();
    admitted(await queued);
    expect(a.snapshot()).toEqual({ active: 2, queued: 0 });
  });

  it("hands a released slot to the oldest waiter, so arrivals cannot overtake it", async () => {
    const a = new LoginAdmission({ concurrency: 1, queue: 5, perAccount: 9, retryAfterSeconds: 1 });
    const first = admitted(await a.enter("x"));
    const order: string[] = [];
    const w1 = a.enter("w1").then((r) => { order.push("w1"); return r; });
    const w2 = a.enter("w2").then((r) => { order.push("w2"); return r; });
    first();
    admitted(await w1)();
    admitted(await w2)();
    expect(order).toEqual(["w1", "w2"]);
    expect(a.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("counts an account's queued requests toward its cap, not only its running ones", async () => {
    const a = new LoginAdmission({ concurrency: 1, queue: 10, perAccount: 2, retryAfterSeconds: 1 });
    const running = admitted(await a.enter("k"));
    const queued = a.enter("k");
    expect(await a.enter("k")).toMatchObject({ admitted: false, refusal: "account_busy" });
    // Another account is unaffected.
    const other = a.enter("j");
    running();
    admitted(await queued)();
    admitted(await other)();
    // Released, the account may enter again.
    admitted(await a.enter("k"))();
  });

  it("ignores a second release", async () => {
    const a = new LoginAdmission({ concurrency: 1, queue: 0, perAccount: 1, retryAfterSeconds: 1 });
    const r = admitted(await a.enter("k"));
    r();
    r();
    expect(a.snapshot()).toEqual({ active: 0, queued: 0 });
    admitted(await a.enter("k"));
    expect(await a.enter("other")).toMatchObject({ refusal: "saturated" });
  });
});

describe("buildShedReporter", () => {
  it("reports at most once per interval, with the count since the last report", () => {
    const a = new LoginAdmission({ concurrency: 1, queue: 0, perAccount: 1, retryAfterSeconds: 1 });
    const lines: string[] = [];
    let now = 0;
    const report = buildShedReporter(a, (l) => lines.push(l), 1000, () => now);
    report();
    report();
    report();
    now = 999;
    report();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/shed 1 sign-in request/);
    now = 1000;
    report();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/shed 4 sign-in request/);
  });
});
