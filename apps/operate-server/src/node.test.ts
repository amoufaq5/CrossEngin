import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
// The workspace's own comment stripper, shared by all twelve strategy rules. Not a local copy: a
// `}` inside a doc comment unbalances the brace matcher below, and `stripComments` is the one
// implementation whose regex-literal hazard has already been found and fixed (ADR-0356).
import { stripComments } from "@crossengin/testing/strategy";
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
    edgeTrust: "untrusted",
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

  it("is forwarded on again by server.ts, the hop that IS class-fenced", () => {
    // This comment used to say the opposite, and it was wrong when it was written — corrected here
    // because a reader following it would write a fence that already exists and skip the hop that
    // genuinely has none. Three corrections, each measured:
    //
    //   1. It named `CompileOperateServerOptions`, which has **one** occurrence in the whole
    //      workspace: that comment. The real pair is `OperateRuntimeOptions` /
    //      `OperateGatewayOptions`, and `server.ts` calls `buildOperateGateway`, not
    //      `compileOperateServer`.
    //   2. It called this hop unfenced. `server.test.ts` fences it as a class, over the
    //      **intersection** of `BuildOperateHttpServerOptions` with
    //      `OperateGatewayOptions ∪ OperateRuntimeOptions` — the union, so inherited fields are
    //      seen. `git log -S` puts that fence and this comment in the **same commit**
    //      (`8805614`), so the general rule it called another package's open end arrived with it.
    //   3. The hop with no class fence is the one this very block covers per field: `serve()` →
    //      `buildOperateHttpServer`. Nothing compares `node.ts`' two option literals against what
    //      `BuildOperateHttpServerOptions` accepts, which is why each field needs its own pin and
    //      why `adminRoles` sat dropped at both literals for four phases.
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

describe("serve() — the tenant-settings grant reaches both gateways", () => {
  /**
   * The sibling block above explains the mechanism; this is the same pin for `adminRoles`, and it
   * is the field that proved the mechanism rather than merely being exposed to it. `adminRoles` has
   * existed on `BuildOperateHttpServerOptions` and been forwarded by `server.ts` since ADR-0103, and
   * `node.ts` passed it at **neither** literal — so `compileOperateServer`'s own
   * `?? DEFAULT_ADMIN_ROLES` default (`["erp_admin"]`) governed `/v1/admin/settings` on every
   * deployment there is, with no flag able to name it and no boot line announcing it.
   *
   * The drop was invisible three ways, which is ADR-0386's triple: `tsc` cannot see it because the
   * option is optional and the caller spreads conditionally; no boot line contradicted it because
   * there was no boot line; and no test caught it because the default is a *working* value for every
   * shipped pack — all seven declare `erp_admin`. What it was wrong about is the *credential*:
   * `deploy/.env.example` grants the bootstrap operator `platform_admin`, which no pack declares, so
   * the documented operator met a 403 on a page the sidebar links to with no role gate.
   */
  const src = readFileSync(resolve(import.meta.dirname, "./node.ts"), "utf8");

  it("forwards it to the boot gateway and to the per-tenant one", () => {
    // Both, for ADR-0340's reason: `settingsStore` is passed at the per-tenant literal too, so
    // `/v1/admin/settings` is mounted on a tenant's own gateway and a grant wired only at the boot
    // one would leave exactly the tenant-authored manifest governed by the hardcoded default.
    //
    // Bounded by the NEXT call site rather than by a fixed window, which the sibling block above
    // uses and which silently cannot reach this field: the per-tenant literal's own comments run
    // past 6000 characters, so a generous-looking slice ends before `settingsStore` — the first
    // draft of this test failed for that reason and not because the field was missing. A pair of
    // assertions keeps it exact: the forward appears exactly twice in the file, and one of the two
    // falls in each site's span.
    // And NOT a count of the field across the file, which the sibling block's own comment warns
    // about three lines up and which the first draft of this test did anyway: there are **three**
    // occurrences of `adminRoles: options.adminRoles`, because the boot line reads the same option
    // under the same name. A count would also have been satisfied by three forwards and no boot
    // line, which is the half the `says the grant at boot` test below pins.
    const sites = [...src.matchAll(/buildOperateHttpServer\(\{/g)].map((m) => m.index ?? -1);
    expect(sites).toHaveLength(2);
    const bounds = [
      [sites[0] ?? 0, sites[1] ?? src.length],
      [sites[1] ?? 0, src.length],
    ] as const;
    for (const [from, to] of bounds) {
      expect(src.slice(from, to), `buildOperateHttpServer at ${from.toString()}`).toContain(
        "adminRoles: options.adminRoles",
      );
    }
  });

  it("is declared and forwarded by server.ts without an `as never`", () => {
    const serverSrc = readFileSync(resolve(import.meta.dirname, "./server.ts"), "utf8");
    expect(serverSrc).toContain("readonly adminRoles?: readonly string[];");
    expect(serverSrc).toContain("{ adminRoles: options.adminRoles as readonly RoleName[] }");
    // The cast is needed (`RoleName` is branded) and `as never` is not the cast: it accepts any
    // type at all, so it would have validated nothing if this field's type changed — ADR-0362's
    // annotation-standing-in-for-a-check, in the forwarding literal for precisely this field.
    expect(
      serverSrc,
      "adminRoles went back to `as never`, which accepts any type",
    ).not.toContain("adminRoles: options.adminRoles as never");
  });

  it("says the grant at boot, which was the half with no surface at all", () => {
    // The silence was the defect: every sibling grant prints a line and this one printed nothing,
    // so an operator's first and only signal was the 403.
    const at = src.indexOf("const adminGrant = formatAdminGrant({");
    expect(at).toBeGreaterThan(-1);
    const after = src.slice(at, at + 400);
    expect(after).toContain("adminRoles: options.adminRoles");
    expect(after).toContain("manifestRoleNames");
    // Unconditional — not inside an `if` on the flag — because a deployment that declared nothing
    // is exactly the one whose grant it needs to hear.
    expect(after).toContain("console.info(adminGrant.message)");
  });
});

/**
 * The **general rule** over the hop the two blocks above pin per field, which is what those blocks
 * should have been in the first place.
 *
 * `node.test.ts` had accumulated per-field pins — `allowUncoveredSettlement` (ADR-0391), then
 * `adminRoles` and `userIdentity` — each written because the previous one's defect had just been
 * found, and each covering exactly one field of 34. The comment above says so in its own third
 * correction: *"Nothing compares `node.ts`' two option literals against what
 * `BuildOperateHttpServerOptions` accepts, which is why each field needs its own pin."* Writing a
 * third pin rather than the rule it names is ADR-0288's maintained list, and the list was already
 * wrong: the rule found **two** dropped fields on its first run, neither of which any pin covered.
 *
 * What it found, and why a pin could not have: `idempotencyStore` and `rateLimitChecker` were
 * absent from the per-tenant literal, so a tenant serving its own activated manifest fell back to
 * the per-process in-memory pair `buildOperateGateway` installs. The idempotency one is **live on
 * the shipped compose** — which passes `--idempotency-store` *and* `--ai-design`, and `--ai-design`
 * implies `--per-tenant-manifests` — so ADR-0336's defect was silently restored for exactly the
 * tenants ADR-0314 exists to serve. And `node.ts`' own comment above that literal asserted the
 * opposite, naming two deployment-singleton exceptions when there were four, with the other two
 * per-request. A comment claiming the property the code breaks, found by the rule and not by
 * reading.
 *
 * The unit is **every field `BuildOperateHttpServerOptions` declares, against each literal**, with
 * a per-site `notPassed` map carrying the reason. That is available here and is *not* available one
 * hop in: `server.test.ts` fences `buildOperateHttpServer` → `buildOperateGateway` over the
 * **intersection** of two interfaces' field names, which works only because names survive that hop
 * — `cursorSealing` becomes `cursorSealer` across it and so is in neither fence's population. Here
 * the literal's keys *are* the interface's field names, so the comparison is total.
 *
 * Three mechanics are load-bearing and each was wrong in a first draft:
 *
 *   1. **Comments are stripped first**, with the workspace's own `stripComments` — and this is
 *      insurance against a false *green*, not a fix for a false red, which is the opposite of what
 *      a first draft of this comment claimed. Measured both ways: the counts agree today (2 and 4
 *      omissions either way), so removing the strip passes, and what it changes is the **span** —
 *      the per-tenant literal reads 3,522 characters stripped and **9,628** raw, so the raw matcher
 *      runs ~6,100 characters past the literal's true end. A field named anywhere in that tail
 *      (`onInvalidManifest`'s block follows immediately) would read as passed. None is today,
 *      which is why this is not load-bearing and is kept anyway: the failure it prevents is silent.
 *   2. **The span is brace-matched, not a fixed window and not "up to the next call site."** A
 *      6,000-character window cannot reach the per-tenant literal's later fields (the sibling block
 *      above records that failure), and bounding by the next call site gives the boot site a
 *      50,000-character span that swallows every intervening statement — under which
 *      `rateLimitChecker` reads as passed because it is *mentioned* 26 lines later.
 *   3. **The match is a word boundary, not `field\s*[,:]`.** A shorthand property inside a
 *      conditional spread ends in `}` (`...(jwt !== null ? { jwt } : {})`), so a trailing-delimiter
 *      regex reported 17 of 34 fields dropped at both sites — all of them present.
 */
describe("serve()'s two buildOperateHttpServer literals", () => {
  const src = stripComments(readFileSync(resolve(import.meta.dirname, "./node.ts"), "utf8"));
  const serverSrc = readFileSync(resolve(import.meta.dirname, "./server.ts"), "utf8");

  /** The field names an interface declares at its own top level, from the source. */
  function interfaceFields(text: string, name: string): readonly string[] {
    const start = text.indexOf(`export interface ${name} `);
    expect(start, `interface ${name} not found`).toBeGreaterThan(-1);
    const open = text.indexOf("{", start);
    let depth = 0;
    let end = open;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    // Two-space indentation only, so a field of a NESTED object type is not read as a field of
    // this interface — `requestSigning.keys` is four-spaced and would otherwise be compared.
    return [...text.slice(open, end).matchAll(/^\s{2}readonly (\w+)\??:/gm)].map(
      (m) => m[1] as string,
    );
  }

  /** Each `buildOperateHttpServer({ … })` argument, brace-matched over comment-stripped source. */
  function literals(): readonly { readonly at: number; readonly body: string }[] {
    const out: { at: number; body: string }[] = [];
    for (const m of src.matchAll(/buildOperateHttpServer\(\{/g)) {
      const at = m.index ?? 0;
      const open = src.indexOf("{", at);
      let depth = 0;
      let end = open;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === "{") depth += 1;
        else if (src[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      out.push({ at, body: src.slice(open, end + 1) });
    }
    return out;
  }

  const accepted = interfaceFields(serverSrc, "BuildOperateHttpServerOptions");

  /**
   * Fields a given literal legitimately omits. Keyed by site index (0 = the boot gateway,
   * 1 = the per-tenant one), because the two sites differ and collapsing them would excuse a drop
   * at one site with a reason that holds only for the other.
   */
  const notPassed: readonly Readonly<Record<string, string>>[] = [
    Object.freeze({
      now: "a clock seam for a caller that constructs the server directly; serve() has no --now",
      idGenerator:
        "the same, and stronger: `idGenerator` has ZERO occurrences in node.ts, so there is no " +
        "producer to forward — a flag for it has never existed",
      onSurvey:
        "serve() surveys the boot manifest ITSELF, before this function is reached, because " +
        "--classified-write-mask's refusal has to fire before anything mounts and the [cursor] " +
        "line has a declared order relative to checkAbacObligations. Passing it here would " +
        "survey the same manifest twice and report it once. The per-tenant literal does pass it, " +
        "and that asymmetry is the whole reason the option exists",
    }),
    Object.freeze({
      now: "see the boot site",
      idGenerator: "see the boot site",
      webhookRoute:
        "a deployment-wide route singleton, not per-request: the Stripe webhook is matched ahead " +
        "of the gateway on the default server, which handles it for every tenant",
      billingPortal:
        "the same — POST /v1/meta/billing-portal stays on the default server. These two are the " +
        "exceptions node.ts' own comment above the literal names, and they are the only two that " +
        "hold: `idempotencyStore` and `rateLimitChecker` were in this map until the rule found " +
        "them, and both are per-request",
    }),
  ];

  it("passes every option it accepts, at both sites, or declares why not", () => {
    const sites = literals();
    expect(sites, "buildOperateHttpServer is not called exactly twice in node.ts").toHaveLength(
      notPassed.length,
    );

    for (const [i, site] of sites.entries()) {
      const excused = notPassed[i] ?? {};
      const dropped = accepted.filter(
        (f) => !new RegExp(`\\b${f}\\b`).test(site.body) && !(f in excused),
      );
      expect(
        dropped,
        `buildOperateHttpServer call ${(i + 1).toString()} (offset ${site.at.toString()}) does ` +
          `not pass these options; forward them or declare why in notPassed[${i.toString()}]`,
      ).toEqual([]);
    }
  });

  it("declares no exemption for a field that is not an option, so the map cannot go stale", () => {
    // The other direction (`pg-record-retention.ts`'s rule): an entry naming a field the interface
    // no longer has is a reason nobody can check, and it would silently excuse nothing while
    // reading as coverage.
    for (const [i, excused] of notPassed.entries()) {
      for (const f of Object.keys(excused)) {
        expect(
          accepted,
          `notPassed[${i.toString()}] excuses ${f}, which BuildOperateHttpServerOptions does not declare`,
        ).toContain(f);
      }
    }
  });

  it("reads real spans and a real interface, so the check above is not vacuous", () => {
    const sites = literals();
    expect(accepted.length, "BuildOperateHttpServerOptions read as empty").toBeGreaterThan(25);
    for (const [i, site] of sites.entries()) {
      // A span long enough to be the literal and short enough not to be half the file — the two
      // failure modes of the two bounding strategies this rejected.
      expect(site.body.length, `literal ${i.toString()} span`).toBeGreaterThan(900);
      expect(site.body.length, `literal ${i.toString()} span`).toBeLessThan(20_000);
      expect(site.body.trimEnd().endsWith("}"), `literal ${i.toString()} is unbalanced`).toBe(true);
    }
    // And `manifest` is passed at both, which is the one field no deployment can omit.
    for (const site of sites) expect(site.body).toMatch(/\bmanifest\b/);
  });

  it("passes the replay guard and the rate-limit window to the per-tenant gateway", () => {
    // The two the rule found. Pinned by name as well as by the rule, because the rule would be
    // satisfied by moving them back into `notPassed` with a plausible-sounding reason — and the
    // reason cannot be plausible: both are per-request, so the in-memory fallback is a divergence
    // and not a singleton staying put. The idempotency one is ADR-0336's defect restored.
    const perTenant = literals()[1];
    expect(perTenant).toBeDefined();
    expect(perTenant?.body).toMatch(/\bidempotencyStore\b/);
    expect(perTenant?.body).toMatch(/\brateLimitChecker\b/);
    expect(Object.keys(notPassed[1] ?? {})).not.toContain("idempotencyStore");
    expect(Object.keys(notPassed[1] ?? {})).not.toContain("rateLimitChecker");
  });
});

describe("runVerifyChain — the anchor audit's chain argument", () => {
  /**
   * The one site that passed `auditAnchors(…, null)` unconditionally, and the one this increment
   * changed. Read as text because `runVerifyChain` opens a real Postgres connection on its first
   * line, which is this app's own idiom for a wiring fact a unit test cannot hold.
   *
   * It is a wiring fence and not a behaviour one: `chain-verify.test.ts` holds what
   * `verifyChainForAudit` *answers* on every path, and nothing there can see a caller that asks
   * for the entries and then discards them. That is precisely how this defect arrived — the
   * correspondence was available on five of six paths and the call site passed `null` anyway.
   */
  const src = stripComments(readFileSync(resolve(import.meta.dirname, "./node.ts"), "utf8"));
  const body = (() => {
    const start = src.indexOf("export async function runVerifyChain(");
    expect(start, "runVerifyChain declaration").toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n}", start));
  })();

  it("passes the entries the fold examined, and not a bare null", () => {
    expect(body).toContain("auditAnchors(tenantId, checkpoints, verification.correspondenceChain)");
    // The mutation this exists to catch is the pre-increment line, which typechecks and leaves
    // every `chain-verify` test green: `correspondenceChain` is `readonly ChainedLogEntry[] | null`,
    // so `null` is assignable and the audit answers `disagreeing: null` — *not asked* — on a
    // deployment where it was asked and clean.
    expect(body).not.toMatch(/auditAnchors\([^)]*,\s*null\s*\)/);
  });

  it("reaches the audit through verifyChainForAudit, so both modes share one fold", () => {
    expect(body).toContain("verifyChainForAudit(");
    // Neither wrapper, because each returns the report alone — so calling one here would mean a
    // second load for the entries, and a chain read twice can be read differently.
    expect(body).not.toContain("verifyChainFull(");
    expect(body).not.toContain("verifyChainFromCheckpoint(");
  });

  it("audits the anchors before reading the tail, which is the ordering argument", () => {
    // `proveScopeIntegrity`'s own: the witness is read before the tail it is compared against, so
    // an append in the window only ever *clears* the truncation check while a delete in it is a
    // truncation that really happened. Reversed, the window manufactures findings.
    expect(body.indexOf("auditAnchors(")).toBeLessThan(body.indexOf("reader.tail("));
  });
});

describe("the chain scheduler flags name the flag the operator passed", () => {
  // As text because no type can ask it: a message naming `--checkpoint-config` to somebody who
  // passed `--checkpoints` typechecks, and the boolean is the shipped default, so that is the
  // reading an operator gets (ADR-0334 — a remedy they cannot act on; ADR-0364's addendum class).
  const src = readFileSync(resolve(import.meta.dirname, "./node.ts"), "utf8");

  for (const [pair, flagVar, boolFlag, configFlag] of [
    ["checkpoint", "checkpointFlag", "--checkpoints", "--checkpoint-config"],
    ["integrity-proof", "proofFlag", "--integrity-proof", "--integrity-proof-config"],
  ] as const) {
    it(`[${pair}] selects its flag name from which route was used`, () => {
      // The selector itself: the ternary over the `-config` option, not a hardcoded name.
      const selector = new RegExp(
        `const ${flagVar} =[^;]*\\?\\s*"${configFlag}"\\s*:\\s*"${boolFlag}"`,
        "s",
      );
      expect(src).toMatch(selector);

      // Every warn in that block that names a flag names it through the selector. The mutation is
      // restoring either literal into the message, which is what shipped before ADR-0406 defaulted
      // the booleans on and is invisible to `tsc` and to every other test.
      const warns = [...src.matchAll(new RegExp(`\\[${pair}\\] \\$\\{${flagVar}\\}`, "g"))];
      expect(warns.length).toBeGreaterThanOrEqual(2);
      expect(src).not.toContain(`[${pair}] ${configFlag} requires a Postgres store`);
      expect(src).not.toContain(`[${pair}] ${configFlag} needs the chain signing key`);
    });
  }
});
