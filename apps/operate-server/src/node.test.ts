import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { parseServeArgs } from "./cli.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { buildOperateHttpServer } from "./server.js";
import { auditEmitterAvailable, createNodeRequestListener, serve, type NodeReqLike, type NodeResLike } from "./node.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const manifest = await loadBuiltinPack("erp-retail");

function httpServer() {
  return buildOperateHttpServer({
    manifest,
    store: new InMemoryEntityStore(),
    apiKeys: [parseApiKeySpec(`key-manager:store_manager:${TENANT}`)],
    now: () => new Date("2026-06-03T12:00:00.000Z"),
  }).httpServer;
}

function mockReq(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
}): NodeReqLike {
  const chunks = opts.body ? [opts.body] : [];
  return {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
    socket: { remoteAddress: "203.0.113.1" },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function mockRes(): NodeResLike & { status: number; headers: Record<string, string>; body: Uint8Array | null } {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(chunk?: Uint8Array) {
      this.body = chunk ?? null;
    },
  };
}

describe("createNodeRequestListener", () => {
  it("serves a GET through the Node glue", async () => {
    const listener = createNodeRequestListener(httpServer());
    const res = mockRes();
    await listener(mockReq({ method: "GET", url: "/v1/products", headers: { "x-api-key": "key-manager" } }), res);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(new TextDecoder().decode(res.body ?? new Uint8Array())) as { data: unknown[] };
    expect(Array.isArray(parsed.data)).toBe(true);
  });

  it("rejects a body over MAX_REQUEST_BODY_BYTES with 413 before dispatch", async () => {
    const listener = createNodeRequestListener(httpServer());
    const res = mockRes();
    const megabyte = new Uint8Array(1024 * 1024);
    const req: NodeReqLike = {
      method: "POST",
      url: "/v1/products",
      headers: { "x-api-key": "key-manager", "content-type": "application/json" },
      socket: { remoteAddress: "203.0.113.1" },
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 11; i++) yield megabyte;
      },
    };
    await listener(req, res);
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toBe("application/problem+json");
    const parsed = JSON.parse(new TextDecoder().decode(res.body ?? new Uint8Array())) as { status: number };
    expect(parsed.status).toBe(413);
  });

  it("applies a per-route override, bounding the read before dispatch", async () => {
    // ADR-0331. The default is deliberately tiny here, which is the posture the feature exists to
    // enable: one platform-wide number has to be the largest legitimate body in the deployment,
    // and that figure then applies to every cheap endpoint.
    const listener = createNodeRequestListener(httpServer(), 2048, [
      { prefix: "/v1/products", bytes: 1024 * 1024 },
    ]);
    const res = mockRes();
    const body = new TextEncoder().encode(
      JSON.stringify({ sku: "S1", name: "A".repeat(4000), unit_price: 2, unit_cost: 1, status: "active", category: "grocery" }),
    );
    await listener(
      mockReq({
        method: "POST",
        url: "/v1/products",
        headers: { "x-api-key": "key-manager", "content-type": "application/json" },
        body,
      }),
      res,
    );
    // Over the 2 KiB default, under the route's 1 MiB — so it is read, not refused.
    expect(body.byteLength).toBeGreaterThan(2048);
    expect(res.status).not.toBe(413);
  });

  it("still refuses a route the override does not cover", async () => {
    // The other half: an override must not loosen anything it did not name.
    const listener = createNodeRequestListener(httpServer(), 2048, [
      { prefix: "/v1/products", bytes: 1024 * 1024 },
    ]);
    const res = mockRes();
    const chunk = new Uint8Array(4096);
    await listener(
      mockReq({
        method: "POST",
        url: "/v1/orders",
        headers: { "x-api-key": "key-manager", "content-type": "application/json" },
        body: chunk,
      }),
      res,
    );
    expect(res.status).toBe(413);
  });

  it("cannot have its limit widened by a query string", async () => {
    // The matcher cuts the query before matching, so appending one cannot select another route's
    // allowance — nor make a non-matching path match.
    const listener = createNodeRequestListener(httpServer(), 2048, [
      { prefix: "/v1/products", bytes: 1024 * 1024 },
    ]);
    const res = mockRes();
    await listener(
      mockReq({
        method: "POST",
        url: "/v1/orders?x=/v1/products",
        headers: { "x-api-key": "key-manager", "content-type": "application/json" },
        body: new Uint8Array(4096),
      }),
      res,
    );
    expect(res.status).toBe(413);
  });

  it("collects a POST body and creates a record", async () => {
    const listener = createNodeRequestListener(httpServer());
    const res = mockRes();
    const body = new TextEncoder().encode(JSON.stringify({ sku: "S1", name: "A", unit_price: 2, unit_cost: 1, status: "active", category: "grocery" }));
    await listener(
      mockReq({
        method: "POST",
        url: "/v1/products",
        headers: { "x-api-key": "key-manager", "content-type": "application/json" },
        body,
      }),
      res,
    );
    expect(res.status).toBe(201);
  });
});

describe("serve — real loopback boot", () => {
  it("boots a listening server and answers a request", async () => {
    const running = await serve(
      parseServeArgs(["--pack", "erp-retail", "--port", "0", "--api-key", `key-manager:store_manager:${TENANT}`]),
    );
    try {
      const status = await get(running.port, "/v1/products", "key-manager");
      expect(status).toBe(200);
    } finally {
      await running.close();
    }
  });
});

describe("auditEmitterAvailable", () => {
  /**
   * The flags whose features write an audit row. Kept as a list only to assert that **none of them
   * matters any more** (ADR-0327).
   *
   * `needsAuditEmitter` used to enumerate these and answer false for anything missing, and the
   * enumeration was wrong three times. The third time got through a per-flag test exactly like the
   * one below: `--deletion-escalation-config` was in the test's list and **absent from the
   * predicate**, and the test still passed because the parser turns `--deletion-request-routes` on
   * alongside it. A hand-maintained list cannot catch a flag missing from both copies of itself.
   */
  const AUDIT_WRITING_ARGS: ReadonlyArray<readonly string[]> = [
    ["--ai-design"],
    ["--per-tenant-manifests"],
    // `--design-review` travels with its prerequisite since ADR-0368: the CLI refuses it alone,
    // because `source: "ai"` is the only producer of a reviewable proposal, so a reviewer without
    // the Architect is a console over a queue that can never be non-empty. The pair is still one
    // entry here — the list is "each audit-writing flag", and the flag is what writes the row.
    ["--design-review", "--ai-design"],
    ["--audit-read-routes"],
    ["--tenant-erasure-routes"],
    ["--tenant-deletion-routes"],
    ["--deletion-request-routes"],
    ["--deletion-runner-ms", "60000"],
    ["--deletion-escalation-config", "/tmp/deletion-escalation.json"],
    ["--integrity-proof-config", "/tmp/proof.json"],
  ];

  const base = ["--pack", "erp-retail", "--port", "0", "--store", "pg"];

  it("is true for a Postgres server with no audit-writing feature at all", () => {
    // The whole change: an emitter exists because there is a database to write to, not because
    // somebody remembered to add a flag to a list.
    expect(auditEmitterAvailable(parseServeArgs(base))).toBe(true);
  });

  it("is true for each audit-writing flag, by construction rather than by enumeration", () => {
    for (const args of AUDIT_WRITING_ARGS) {
      expect(auditEmitterAvailable(parseServeArgs([...base, ...args])), args.join(" ")).toBe(true);
    }
  });

  it("is false without a Postgres store, which is the only condition that was ever real", () => {
    const memory = ["--pack", "erp-retail", "--port", "0"];
    expect(auditEmitterAvailable(parseServeArgs(memory))).toBe(false);
    // And the CLI refuses the combination outright rather than leaving it to this predicate — a
    // stronger guarantee than the gate ever gave, and the reason the gate had nothing left to do.
    expect(() => parseServeArgs([...memory, "--audit-read-routes"])).toThrow(/require a Postgres/);
  });

  it("does not depend on any flag, so a feature added tomorrow cannot omit itself", () => {
    // Every flag combination answers the same thing: the store decides. This is the assertion the
    // old per-flag loop could not make, and the reason the list above is now evidence rather than
    // a gate.
    const all = AUDIT_WRITING_ARGS.flatMap((a) => [...a]);
    expect(auditEmitterAvailable(parseServeArgs([...base, ...all]))).toBe(
      auditEmitterAvailable(parseServeArgs(base)),
    );
  });
});

// Local helper for the loopback test -----------------------------------------

function get(port: number, path: string, apiKey: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { "x-api-key": apiKey } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the two durable job producers report their failures", () => {
  /**
   * `JobScheduler` and `PostgresEntityEventSink` both route **every** failure to an `onError`
   * callback — the scheduler's own doc comment says "a per-tenant enqueue error is routed to
   * `onError` and the loop continues" — and `serve()` constructed both without one. That made the
   * only failure either has completely silent, and the failure is not hypothetical:
   * `meta.job_runs` carries one `ALL`-scope tenant-isolation policy and no platform arm while both
   * producers issue an unscoped `conn.query`, so as any non-owner role the INSERT is refused
   * `42501`. Measured on a live cluster before the fix: the scheduler wrote 0 rows and logged 0
   * lines over 8 ticks, and `POST /v1/leads` answered **201** with the record stored, no job run
   * enqueued and nothing logged — while the boot survey went on reporting that runs accumulate.
   *
   * Pinned by reading the file as text because both constructions live inside `serve()`, which
   * needs a live Postgres and a bound port to reach. That is this app's own idiom for a wiring
   * fact a unit test cannot hold (`unique-enforcement.test.ts`, `token-mint.test.ts`).
   */
  const src = readFileSync(resolve(import.meta.dirname, "./node.ts"), "utf8");

  it("passes onError to the cron scheduler", () => {
    const ctor = src.slice(src.indexOf("jobScheduler = new JobScheduler({"));
    expect(ctor.slice(0, ctor.indexOf("});")), "JobScheduler construction").toContain("onError:");
  });

  it("passes onError to the entity-event sink", () => {
    const ctor = src.slice(src.indexOf("new PostgresEntityEventSink("));
    expect(ctor.slice(0, ctor.indexOf("});")), "PostgresEntityEventSink construction").toContain(
      "onError:",
    );
  });

  it("names a remedy in both, because the measured cause has one", () => {
    // ADR-0334's rule: naming a fix that would not work is worse than naming none — and here one
    // works, so it is named. A bare "enqueue failed" would send an operator to the job handlers.
    //
    // ADR-0389 **replaced** the remedy both messages name, and the replacement is why this test's
    // own premise had to be re-read rather than left alone. They used to say *own the table or
    // bypass its policy*, which was the measured cause while the enqueue was an unscoped
    // `conn.query`. The enqueue now sets `app.current_tenant_id` from the row's own tenant, so that
    // advice became unnecessary **and** the opposite of the least-privilege direction the fix
    // supports — ADR-0334's own rule turned against the sentence it had justified. What a 42501 on
    // this path can still mean is a missing table-level GRANT, which is what they name now. The
    // assertion is unchanged because it pins the *presence* of a named cause, not its content.
    for (const prefix of ["[schedule] enqueue failed", "[entity-events] enqueue failed"]) {
      const at = src.indexOf(prefix);
      expect(at, prefix).toBeGreaterThan(-1);
      expect(src.slice(at, at + 400), prefix).toContain("42501");
    }
  });
});

describe("serve() — the settlement coverage flag reaches both gateways and the survey", () => {
  /**
   * ADR-0386's class: `buildOperateHttpServer` forwards options **one named field at a time**, and
   * a field it does not name is dropped in silence — invisible to `tsc` because the caller passes
   * them inside a conditional spread (which bypasses the excess-property check), invisible to the
   * boot line because the line reads the flag while the request path reads the dropped option, and
   * invisible to every test because the default there is the *safe* value. Measured once in that
   * increment on `requiredJwtClaims`; the same three mechanisms hold here.
   *
   * Read as text for the reason the fence above it is: both constructions live inside `serve()`,
   * which needs a bound port to reach, and no type can ask whether a field was forwarded — a
   * forwarded field and an absent one are identical to the type system.
   */
  const src = readFileSync(resolve(import.meta.dirname, "./node.ts"), "utf8");

  it("forwards it to the boot gateway and to the per-tenant one", () => {
    // Both, and the per-tenant one is the half ADR-0340 established has to be covered: a tenant's
    // own activated manifest can declare a settleable document, and a guard built only for the boot
    // manifest would leave exactly the tenant-authored one unguarded.
    //
    // Each call's own option literal, not a count of the field across the file: the first draft
    // asserted `toHaveLength(2)` over the whole source and read **3**, because the survey call
    // passes the same field under the same name. A count would have been satisfied by three
    // forwards and no survey, or by two surveys and one gateway.
    const sites = [...src.matchAll(/buildOperateHttpServer\(\{/g)].map((m) => m.index ?? -1);
    expect(sites).toHaveLength(2);
    for (const at of sites) {
      // Bounded by a slice rather than by a brace matcher: these literals nest, so the first
      // `});` is not the end of the call — the window is generous and the field is unique enough
      // that a hit inside it is a hit in this call.
      expect(src.slice(at, at + 6000), `buildOperateHttpServer at ${at.toString()}`).toContain(
        "allowUncoveredSettlement: options.allowUncoveredSettlement",
      );
    }
  });

  it("surveys it at boot, so a deployment is told which documents are unguarded", () => {
    // The whole defect was a silence, so the flag suppressing the guard must not suppress the
    // report. `surveySettlementCoverage` is called with the flag rather than with `false`.
    const at = src.indexOf("surveySettlementCoverage(manifest, {");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 180)).toContain("allowUncoveredSettlement: options.allowUncoveredSettlement");
  });

  it("is forwarded on again by buildOperateHttpServer, which is the unfenced hop", () => {
    // The chain is three hops — `serve()` → `BuildOperateHttpServerOptions` →
    // `CompileOperateServerOptions` — and only the first two are covered above. The third has no
    // fence of its own: `compile.test.ts`' `notForwarded` map (ADR-0386) is over
    // `buildOperateGateway` → `GatewayRuntime` in `@crossengin/operate-runtime`, and nothing
    // compares `apps/operate-server/src/server.ts`' option literal against what
    // `compileOperateServer` accepts. So the hop ADR-0386's defect lived on is, in *this* package,
    // still only pinned per field — this is that pin for this field, and the general rule is that
    // package's own open end rather than something this test can supply.
    //
    // Read from `node.test.ts` rather than from a `server.test.ts` block because the subject is
    // one wiring chain and splitting the assertions across two files is how half of one gets
    // forgotten.
    const serverSrc = readFileSync(resolve(import.meta.dirname, "./server.ts"), "utf8");
    expect(serverSrc).toContain("readonly allowUncoveredSettlement?: boolean;");
    expect(serverSrc).toContain("{ allowUncoveredSettlement: options.allowUncoveredSettlement }");
  });

  it("chooses the log level from the report rather than from the flag", () => {
    // `settlementCoverageIsSuspect` reads the same list the verdict is computed from, so the level
    // an operator sees and the verdict they read cannot disagree — and a level keyed on the flag
    // would print `info` for `TaxReturn`, which is unguarded on every deployment there is.
    const at = src.indexOf("const settlementLine = formatSettlementCoverageReport");
    expect(at).toBeGreaterThan(-1);
    const after = src.slice(at, at + 300);
    expect(after).toContain("settlementCoverageIsSuspect(settlementCoverage)");
    expect(after).toContain("console.warn(settlementLine)");
    expect(after).toContain("console.info(settlementLine)");
  });
});
