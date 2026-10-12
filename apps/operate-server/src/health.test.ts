import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_READINESS_TIMEOUT_MS,
  HEALTH_METHODS,
  HEALTH_PATHS,
  HEALTH_PROBE_KINDS,
  HealthConfigRefused,
  MAX_READINESS_TIMEOUT_MS,
  MIN_READINESS_TIMEOUT_MS,
  POSTGRES_READINESS_CHECK_NAME,
  READINESS_CHECK_NAME_RE,
  READINESS_OUTCOMES,
  READINESS_OUTCOME_SERVES,
  READINESS_PROBE_SQL,
  ReadinessCheckNameSchema,
  ReadinessReportSchema,
  buildHealthInterceptor,
  buildPostgresReadinessCheck,
  buildReadinessProbe,
  handleHealthRequest,
  healthProbeKindFor,
  isHealthPath,
  readinessResponseBody,
  toRawHealthResponse,
  type ReadinessCheck,
  type ReadinessFailureInfo,
  type ReadinessReport,
} from "./health.js";

/** A probe that never resolves until the test says so. */
function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
} {
  let resolve: () => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

function okCheck(name = "dep"): ReadinessCheck {
  return { name, probe: () => Promise.resolve(undefined) };
}

function failingCheck(name: string, err: unknown): ReadinessCheck {
  return { name, probe: () => Promise.reject(err) };
}

/** A probe that answers nothing, so only the budget can settle the request. */
function stalledCheck(name = "dep"): { check: ReadinessCheck; calls: () => number } {
  let calls = 0;
  return {
    check: {
      name,
      probe: () => {
        calls += 1;
        return new Promise<void>(() => undefined);
      },
    },
    calls: () => calls,
  };
}

/**
 * Records every statement and **throws** on anything but a query.
 *
 * The fallback arm raises rather than answering, following `shared-table-erasure.test.ts`: a fake
 * that quietly served a `transaction` would make the claim that the readiness probe opens none
 * unassertable, which is this repo's own fake-connection blind spot applied to the fake.
 */
function recordingConnection(
  answer: () => Promise<PgQueryResult> = () => Promise.resolve({ rows: [], rowCount: 0 }),
): { conn: PgConnection; calls: { sql: string; params: readonly unknown[] | undefined }[] } {
  const calls: { sql: string; params: readonly unknown[] | undefined }[] = [];
  const conn: PgConnection = {
    query: <T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<PgQueryResult<T>> => {
      calls.push({ sql, params });
      return answer() as Promise<PgQueryResult<T>>;
    },
    transaction: () => {
      throw new Error("readiness must not open a transaction");
    },
    withAdvisoryLock: () => {
      throw new Error("readiness must not take an advisory lock");
    },
    close: () => Promise.resolve(),
  };
  return { conn, calls };
}

const NEVER_PROBED = (): Promise<ReadinessReport> => {
  throw new Error("liveness must not evaluate readiness");
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probe paths", () => {
  it("declares a path for every probe kind", () => {
    expect(Object.keys(HEALTH_PATHS).sort()).toEqual([...HEALTH_PROBE_KINDS].sort());
    expect(new Set(Object.values(HEALTH_PATHS)).size).toBe(HEALTH_PROBE_KINDS.length);
  });

  it("maps each declared path to its kind", () => {
    expect(healthProbeKindFor(HEALTH_PATHS.liveness)).toBe("liveness");
    expect(healthProbeKindFor(HEALTH_PATHS.readiness)).toBe("readiness");
  });

  it("ignores a query string and one trailing slash", () => {
    expect(healthProbeKindFor("/readyz/")).toBe("readiness");
    expect(healthProbeKindFor("/readyz?verbose=1")).toBe("readiness");
    expect(healthProbeKindFor("/health/?x=y")).toBe("liveness");
  });

  it("matches exactly and never as a prefix", () => {
    // A prefix match would hand the gateway's own routes to this module and answer 200 for them.
    expect(healthProbeKindFor("/readyz/../v1/vendors")).toBeNull();
    expect(healthProbeKindFor("/health/extra")).toBeNull();
    expect(healthProbeKindFor("/healthz")).toBeNull();
    expect(healthProbeKindFor("/readyzz")).toBeNull();
  });

  it("answers false for an ordinary gateway path", () => {
    expect(isHealthPath("/v1/vendors")).toBe(false);
    expect(isHealthPath("/")).toBe(false);
    expect(isHealthPath(HEALTH_PATHS.readiness)).toBe(true);
  });
});

describe("outcome vocabulary", () => {
  it("is a total map in which only `ready` serves", () => {
    expect(Object.keys(READINESS_OUTCOME_SERVES).sort()).toEqual([...READINESS_OUTCOMES].sort());
    const serving = READINESS_OUTCOMES.filter((o) => READINESS_OUTCOME_SERVES[o]);
    expect(serving).toEqual(["ready"]);
  });

  it("accepts the postgres check name under the declared pattern", () => {
    expect(ReadinessCheckNameSchema.safeParse(POSTGRES_READINESS_CHECK_NAME).success).toBe(true);
    expect(READINESS_CHECK_NAME_RE.test("pg_primary")).toBe(true);
    expect(READINESS_CHECK_NAME_RE.test("Postgres")).toBe(false);
    expect(READINESS_CHECK_NAME_RE.test("db host")).toBe(false);
    expect(READINESS_CHECK_NAME_RE.test("")).toBe(false);
  });
});

describe("configuration refusals", () => {
  it("refuses a budget below the floor", () => {
    expect(() =>
      buildReadinessProbe({ checks: [], timeoutMs: MIN_READINESS_TIMEOUT_MS - 1 }),
    ).toThrow(HealthConfigRefused);
  });

  it("refuses a budget above the ceiling rather than clamping it", () => {
    expect(() =>
      buildReadinessProbe({ checks: [], timeoutMs: MAX_READINESS_TIMEOUT_MS + 1 }),
    ).toThrow(/between/);
  });

  it("refuses a non-integer budget", () => {
    expect(() => buildReadinessProbe({ checks: [], timeoutMs: 500.5 })).toThrow(
      HealthConfigRefused,
    );
  });

  it("accepts both bounds and the default", () => {
    expect(() => buildReadinessProbe({ checks: [], timeoutMs: MIN_READINESS_TIMEOUT_MS })).not.toThrow();
    expect(() => buildReadinessProbe({ checks: [], timeoutMs: MAX_READINESS_TIMEOUT_MS })).not.toThrow();
    expect(() => buildReadinessProbe({ checks: [] })).not.toThrow();
    expect(DEFAULT_READINESS_TIMEOUT_MS).toBeGreaterThanOrEqual(MIN_READINESS_TIMEOUT_MS);
    expect(DEFAULT_READINESS_TIMEOUT_MS).toBeLessThanOrEqual(MAX_READINESS_TIMEOUT_MS);
  });

  it("refuses a check name that is not a declared identifier", () => {
    expect(() => buildReadinessProbe({ checks: [okCheck("Postgres primary")] })).toThrow(
      HealthConfigRefused,
    );
  });

  it("refuses two checks sharing a name", () => {
    // They would share one in-flight slot, so the second dependency would never be asked.
    expect(() => buildReadinessProbe({ checks: [okCheck("pg"), okCheck("pg")] })).toThrow(
      /duplicate/,
    );
  });
});

describe("liveness", () => {
  it("answers 200 without evaluating readiness", async () => {
    const response = await handleHealthRequest(
      { method: "GET", path: HEALTH_PATHS.liveness },
      NEVER_PROBED,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("discloses nothing but the status", async () => {
    const response = await handleHealthRequest(
      { method: "GET", path: HEALTH_PATHS.liveness },
      NEVER_PROBED,
    );
    // No version, no build id, no uptime, no commit: a liveness probe reads a status code.
    expect(Object.keys(response.body ?? {})).toEqual(["status"]);
  });

  it("forbids caching", async () => {
    const response = await handleHealthRequest(
      { method: "HEAD", path: HEALTH_PATHS.liveness },
      NEVER_PROBED,
    );
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a method a probe would not use, naming the ones it may", async () => {
    const response = await handleHealthRequest(
      { method: "POST", path: HEALTH_PATHS.liveness },
      NEVER_PROBED,
    );
    expect(response.status).toBe(405);
    expect(response.headers["allow"]).toBe(HEALTH_METHODS.join(", "));
  });

  it("refuses a method on the readiness path too, without probing", async () => {
    const response = await handleHealthRequest(
      { method: "DELETE", path: HEALTH_PATHS.readiness },
      NEVER_PROBED,
    );
    expect(response.status).toBe(405);
  });

  it("reports a path that is not ours as 404", async () => {
    const response = await handleHealthRequest(
      { method: "GET", path: "/v1/vendors" },
      NEVER_PROBED,
    );
    expect(response.status).toBe(404);
  });
});

describe("readiness", () => {
  it("is ready with no declared checks", async () => {
    const report = await buildReadinessProbe({ checks: [] })();
    expect(ReadinessReportSchema.safeParse(report).success).toBe(true);
    expect(report).toEqual({ ready: true, checks: [] });
  });

  it("is ready when every check answers", async () => {
    const report = await buildReadinessProbe({ checks: [okCheck("pg"), okCheck("cache")] })();
    expect(report.ready).toBe(true);
    expect(report.checks.map((c) => c.outcome)).toEqual(["ready", "ready"]);
  });

  it("reports a rejecting probe as unreachable and is not ready", async () => {
    const report = await buildReadinessProbe({
      checks: [failingCheck("pg", new Error("ECONNREFUSED 10.0.0.4:5432"))],
    })();
    expect(report.ready).toBe(false);
    expect(report.checks[0]?.outcome).toBe("unreachable");
  });

  it("reports a probe that outlives its budget as timed_out", async () => {
    const { check } = stalledCheck("pg");
    const report = await buildReadinessProbe({
      checks: [check],
      timeoutMs: MIN_READINESS_TIMEOUT_MS,
    })();
    expect(report.ready).toBe(false);
    expect(report.checks[0]?.outcome).toBe("timed_out");
  });

  it("is not ready when any one check fails", async () => {
    const report = await buildReadinessProbe({
      checks: [okCheck("cache"), failingCheck("pg", new Error("down"))],
    })();
    expect(report.ready).toBe(false);
    expect(report.checks.map((c) => c.outcome)).toEqual(["ready", "unreachable"]);
  });

  it("reads a synchronous throw as unreachable rather than letting it escape", async () => {
    // A probe is a caller-supplied function and nothing stops it throwing before it returns a
    // promise. Unconverted, that throw escapes the whole evaluation and the request becomes a
    // **500** — the surface whose job is to report an unreachable dependency reporting instead that
    // the request failed, which is not retryable and leaves the instance in rotation.
    const check: ReadinessCheck = {
      name: "pg",
      probe: () => {
        throw new Error("pool is closed");
      },
    };
    const failures: ReadinessFailureInfo[] = [];
    const report = await buildReadinessProbe({
      checks: [check],
      onNotReady: (info) => failures.push(info),
    })();
    expect(report.ready).toBe(false);
    expect(report.checks[0]?.outcome).toBe("unreachable");
    expect(failures).toHaveLength(1);
    expect((failures[0]?.error as Error).message).toBe("pool is closed");
  });

  it("converts a thrown non-Error into an Error rather than reporting a bare value", async () => {
    const check: ReadinessCheck = {
      name: "pg",
      probe: () => {
        throw "nope";
      },
    };
    const failures: ReadinessFailureInfo[] = [];
    const report = await buildReadinessProbe({
      checks: [check],
      onNotReady: (info) => failures.push(info),
    })();
    expect(report.checks[0]?.outcome).toBe("unreachable");
    expect(failures[0]?.error).toBeInstanceOf(Error);
  });

  it("recovers on the very next probe after a synchronous throw, holding no slot", async () => {
    // The slot is released inside the settle handler, so a throw leaves nothing behind. Asked
    // without an intervening tick, which is what the one-microtask-later release got wrong.
    let fail = true;
    const check: ReadinessCheck = {
      name: "pg",
      probe: () => {
        if (fail) throw new Error("down");
        return Promise.resolve(undefined);
      },
    };
    const probe = buildReadinessProbe({ checks: [check] });
    expect((await probe()).ready).toBe(false);
    fail = false;
    expect((await probe()).ready).toBe(true);
  });

  it("measures the probe's own elapsed time from an injected clock", async () => {
    // Exactly two reads: one for the slot's `startedAt`, one at the end of the evaluation. A third
    // tick here would be a fixture asserting a clock read the implementation does not make.
    const ticks = [1_000, 1_250];
    let i = 0;
    const report = await buildReadinessProbe({
      checks: [okCheck("pg")],
      clock: () => new Date(ticks[Math.min(i++, ticks.length - 1)] ?? 0),
    })();
    expect(report.checks[0]?.durationMs).toBe(250);
  });

  it("never reports a negative duration when the wall clock steps backwards", async () => {
    const ticks = [5_000, 4_000];
    let i = 0;
    const report = await buildReadinessProbe({
      checks: [okCheck("pg")],
      clock: () => new Date(ticks[Math.min(i++, ticks.length - 1)] ?? 0),
    })();
    expect(report.checks[0]?.durationMs).toBe(0);
  });
});

describe("what a 503 discloses", () => {
  it("carries the check name and outcome and nothing else", () => {
    const body = readinessResponseBody({
      ready: false,
      checks: [{ name: "postgres", outcome: "unreachable", durationMs: 17 }],
    });
    expect(body).toEqual({
      status: "not_ready",
      checks: [{ name: "postgres", outcome: "unreachable" }],
    });
    // Timing is for `onNotReady`, not for an anonymous caller polling the database's load.
    expect(JSON.stringify(body)).not.toContain("17");
  });

  it("never echoes a dependency's own failure text", async () => {
    const secret = 'password authentication failed for user "crossengin" at db.internal:5432';
    const response = await handleHealthRequest(
      { method: "GET", path: HEALTH_PATHS.readiness },
      buildReadinessProbe({ checks: [failingCheck("postgres", new Error(secret))] }),
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("db.internal");
    expect(JSON.stringify(response.body)).not.toContain("crossengin");
  });

  it("answers 200 and `ready` when it can serve", async () => {
    const response = await handleHealthRequest(
      { method: "GET", path: HEALTH_PATHS.readiness },
      buildReadinessProbe({ checks: [okCheck("postgres")] }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ready",
      checks: [{ name: "postgres", outcome: "ready" }],
    });
  });
});

describe("the failure observer", () => {
  it("receives the dependency's real error", async () => {
    const seen: ReadinessFailureInfo[] = [];
    const err = new Error("ECONNREFUSED");
    await buildReadinessProbe({
      checks: [failingCheck("pg", err)],
      onNotReady: (info) => seen.push(info),
    })();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.outcome).toBe("unreachable");
    expect(seen[0]?.error).toBe(err);
  });

  it("receives a null error for a timeout, because nothing has failed yet", async () => {
    const seen: ReadinessFailureInfo[] = [];
    const { check } = stalledCheck("pg");
    await buildReadinessProbe({
      checks: [check],
      timeoutMs: MIN_READINESS_TIMEOUT_MS,
      onNotReady: (info) => seen.push(info),
    })();
    expect(seen[0]?.outcome).toBe("timed_out");
    expect(seen[0]?.error).toBeNull();
  });

  it("is not called when every check answers", async () => {
    const seen: ReadinessFailureInfo[] = [];
    await buildReadinessProbe({ checks: [okCheck()], onNotReady: (i) => seen.push(i) })();
    expect(seen).toEqual([]);
  });

  it("cannot turn a clean 503 into a 500 by throwing", async () => {
    const response = await handleHealthRequest(
      { method: "GET", path: HEALTH_PATHS.readiness },
      buildReadinessProbe({
        checks: [failingCheck("pg", new Error("down"))],
        onNotReady: () => {
          throw new Error("observer exploded");
        },
      }),
    );
    expect(response.status).toBe(503);
  });
});

describe("in-flight collapse", () => {
  it("serves concurrent requests from one underlying probe", async () => {
    const gate = deferred();
    let calls = 0;
    const check: ReadinessCheck = {
      name: "pg",
      probe: () => {
        calls += 1;
        return gate.promise;
      },
    };
    const probe = buildReadinessProbe({ checks: [check] });
    const all = Promise.all([probe(), probe(), probe()]);
    gate.resolve();
    const reports = await all;
    expect(calls).toBe(1);
    expect(reports.every((r) => r.ready)).toBe(true);
  });

  it("starts a fresh probe once the previous one has settled", async () => {
    let calls = 0;
    const check: ReadinessCheck = {
      name: "pg",
      probe: () => {
        calls += 1;
        return Promise.resolve(undefined);
      },
    };
    const probe = buildReadinessProbe({ checks: [check] });
    await probe();
    await probe();
    expect(calls).toBe(2);
  });

  it("keeps the slot while a query outlives its budget, so a wedged database costs one connection", async () => {
    // The invariant: a timeout is a race, not a cancellation, so releasing the slot at the budget
    // would check out a second connection per probe while the first query still held one.
    const { check, calls } = stalledCheck("pg");
    const probe = buildReadinessProbe({ checks: [check], timeoutMs: MIN_READINESS_TIMEOUT_MS });
    const first = await probe();
    const second = await probe();
    expect(first.checks[0]?.outcome).toBe("timed_out");
    expect(second.checks[0]?.outcome).toBe("timed_out");
    expect(calls()).toBe(1);
  });

  it("releases the slot when a query that had timed out finally answers", async () => {
    const gate = deferred();
    let calls = 0;
    const check: ReadinessCheck = {
      name: "pg",
      probe: () => {
        calls += 1;
        return gate.promise;
      },
    };
    const probe = buildReadinessProbe({ checks: [check], timeoutMs: MIN_READINESS_TIMEOUT_MS });
    expect((await probe()).checks[0]?.outcome).toBe("timed_out");
    gate.resolve();
    // A macrotask rather than `await gate.promise`: the slot is released by a `.then` on the
    // *settlement* promise, which is one microtask further on than the gate, so awaiting the gate
    // resumes this test while the slot is still held.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await probe()).ready).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not leave an unhandled rejection when a query fails after its budget expired", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const gate = deferred();
      const probe = buildReadinessProbe({
        checks: [{ name: "pg", probe: () => gate.promise }],
        timeoutMs: MIN_READINESS_TIMEOUT_MS,
      });
      expect((await probe()).checks[0]?.outcome).toBe("timed_out");
      gate.reject(new Error("connection terminated unexpectedly"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("the postgres check", () => {
  it("issues one bare statement, with no parameters and no transaction", async () => {
    const { conn, calls } = recordingConnection();
    const check = buildPostgresReadinessCheck(conn);
    const report = await buildReadinessProbe({ checks: [check] })();
    expect(report.ready).toBe(true);
    expect(calls).toEqual([{ sql: READINESS_PROBE_SQL, params: undefined }]);
  });

  it("names itself with an identifier the response may carry", () => {
    const { conn } = recordingConnection();
    expect(buildPostgresReadinessCheck(conn).name).toBe(POSTGRES_READINESS_CHECK_NAME);
    expect(ReadinessCheckNameSchema.safeParse(POSTGRES_READINESS_CHECK_NAME).success).toBe(true);
  });

  it("reads no relation, so no scope predicate is owed", () => {
    expect(READINESS_PROBE_SQL.toUpperCase()).not.toContain("FROM");
    expect(READINESS_PROBE_SQL).not.toContain("tenant_id");
  });

  it("is unreachable when the connection refuses", async () => {
    const { conn } = recordingConnection(() => Promise.reject(new Error("ECONNREFUSED")));
    const report = await buildReadinessProbe({ checks: [buildPostgresReadinessCheck(conn)] })();
    expect(report.ready).toBe(false);
    expect(report.checks[0]?.outcome).toBe("unreachable");
  });
});

describe("the raw response", () => {
  it("sends no body for HEAD while keeping the GET content-length", () => {
    const answer = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { status: "ok" },
    } as const;
    const get = toRawHealthResponse("GET", answer);
    const head = toRawHealthResponse("HEAD", answer);
    expect(head.body).toBeNull();
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
    expect(get.body).not.toBeNull();
  });

  it("serialises the body as JSON", () => {
    const raw = toRawHealthResponse("get", {
      status: 503,
      headers: {},
      body: { status: "not_ready" },
    });
    expect(raw.status).toBe(503);
    expect(new TextDecoder().decode(raw.body ?? new Uint8Array(0))).toBe('{"status":"not_ready"}');
  });
});

describe("the interceptor", () => {
  it("falls through for a request that is not a probe", async () => {
    const intercept = buildHealthInterceptor({ checks: [okCheck()] });
    expect(await intercept({ method: "GET", url: "/v1/vendors", headers: {} }, null)).toBeNull();
  });

  it("serves liveness", async () => {
    const intercept = buildHealthInterceptor({ checks: [okCheck()] });
    const response = await intercept(
      { method: "GET", url: "/health", headers: {} },
      null,
    );
    expect(response?.status).toBe(200);
    expect(new TextDecoder().decode(response?.body ?? new Uint8Array(0))).toBe('{"status":"ok"}');
  });

  it("serves a 503 readiness for an unreachable dependency", async () => {
    const intercept = buildHealthInterceptor({
      checks: [failingCheck("postgres", new Error("down"))],
    });
    const response = await intercept({ method: "GET", url: "/readyz", headers: {} }, null);
    expect(response?.status).toBe(503);
    expect(response?.headers["cache-control"]).toBe("no-store");
  });

  it("refuses its own configuration at build time rather than per request", () => {
    expect(() => buildHealthInterceptor({ checks: [okCheck("BAD NAME")] })).toThrow(
      HealthConfigRefused,
    );
  });
});
