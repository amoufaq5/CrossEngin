import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineExecutionSchema, type PipelineExecution } from "@crossengin/api-gateway";
import { IncidentRecordSchema, type IncidentRecord } from "@crossengin/incident-response";
import {
  CountingIncidentDeclarer,
  type IncidentCloseOut,
  type IncidentCloseOutInput,
  type IncidentDeclarationRequest,
  type IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import type { AlertPolicy, Slo } from "@crossengin/observability";
import { FixedClock, type PageDirective } from "@crossengin/observability-runtime";
import {
  buildSloEnforcement,
  defaultRecoverPages,
  loadSloConfig,
  parseSloConfig,
  type SloConfig,
} from "./slo-config.js";
import type { ObservedEnforcementDecision } from "./slo.js";

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001";
const SURFACE = "product.list";
const END = "2026-06-02T12:00:00.040Z";
const DURATION_MS = 40;

const policy: AlertPolicy = {
  id: "default",
  routes: [{ severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "svc-oncall" }] }],
};

function availabilitySlo(surface: string): Slo {
  return {
    surface,
    targets: [{ kind: "availability", target: 0.99, window: "30d" }],
    id: "product-list-availability",
  };
}

function latencySlo(surface: string): Slo {
  return {
    surface,
    targets: [{ kind: "latency", p95: "10ms", window: "30d" }],
    id: "product-list-latency",
  };
}

/**
 * A connection that answers the incident allocator with a high-water mark and records every
 * statement, so a test can assert the id on a decision is the id of the row it wrote.
 */
function allocatingConnection(capture: { sql: string }[], firstSequence: number): PgConnection {
  const affected: PgQueryResult = { rows: [], rowCount: 1 };
  let next = firstSequence;
  const conn: PgConnection = {
    query: vi.fn(async (sql: string) => {
      capture.push({ sql });
      if (sql.includes("MAX(sequence_number)")) {
        const row = { next: String(next) };
        next += 1;
        return { rows: [row], rowCount: 1 };
      }
      return affected;
    }) as PgConnection["query"],
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as
      PgConnection["transaction"],
    withAdvisoryLock: vi.fn(async <T>(_key: bigint, fn: () => Promise<T>) => fn()) as
      PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return conn;
}

function validConfig(overrides: Partial<SloConfig> = {}): unknown {
  return {
    alertPolicy: policy,
    systemActorUserId: SYSTEM_ACTOR,
    availability: [{ slo: availabilitySlo(SURFACE), category: "availability" }],
    ...overrides,
  };
}

function makeExecution(status: number, outcome: "pass" | "error", at: string): PipelineExecution {
  const startedAt = new Date(Date.parse(at) - DURATION_MS).toISOString();
  const stage = outcome === "error" ? "dispatch_handler" : "emit_audit";
  return PipelineExecutionSchema.parse({
    requestId: "req_abcdefgh12345",
    tenantId: null,
    startedAt,
    completedAt: at,
    totalDurationMs: DURATION_MS,
    finalStage: stage,
    finalOutcome: outcome,
    finalResponseStatus: status,
    stages: [
      {
        stage,
        outcome,
        startedAt,
        completedAt: at,
        durationMs: DURATION_MS,
        reason: "test",
        appliedHeaders: {},
        problemTypeUri: null,
        responseStatus: status,
      },
    ],
    authOutcome: "authenticated",
    routeMatchOutcome: "matched",
    idempotencyOutcome: "no_key_required",
    principalId: null,
    routeOperationId: SURFACE,
    resolvedApiVersion: "v1",
    correlationId: null,
    rateLimitDecisionId: null,
    bytesIn: 0,
    bytesOut: 0,
  });
}

describe("parseSloConfig", () => {
  it("accepts an availability-only config", () => {
    const cfg = parseSloConfig(validConfig());
    expect(cfg.availability).toHaveLength(1);
    expect(cfg.latency).toBeUndefined();
    expect(cfg.systemActorUserId).toBe(SYSTEM_ACTOR);
  });

  it("accepts a latency-only config", () => {
    const cfg = parseSloConfig(
      validConfig({ availability: undefined, latency: [{ slo: latencySlo(SURFACE), category: "performance" }] }),
    );
    expect(cfg.availability).toBeUndefined();
    expect(cfg.latency).toHaveLength(1);
  });

  it("accepts a config with both signals + an explicit interval + rollback", () => {
    const cfg = parseSloConfig(
      validConfig({
        evaluateIntervalMs: 30_000,
        availability: [
          {
            slo: availabilitySlo(SURFACE),
            category: "availability",
            rollback: { flagId: "ff_checkout01", safeValueJson: "false" },
          },
        ],
        latency: [{ slo: latencySlo(SURFACE) }],
      }),
    );
    expect(cfg.evaluateIntervalMs).toBe(30_000);
    expect(cfg.availability?.[0]?.rollback?.flagId).toBe("ff_checkout01");
    expect(cfg.latency).toHaveLength(1);
  });

  it("rejects a config with neither signal populated", () => {
    expect(() => parseSloConfig(validConfig({ availability: [], latency: [] }))).toThrow(
      /at least one of availability\/latency/,
    );
    expect(() =>
      parseSloConfig({ alertPolicy: policy, systemActorUserId: SYSTEM_ACTOR }),
    ).toThrow(/at least one of availability\/latency/);
  });

  it("rejects a non-uuid system actor and unknown top-level keys", () => {
    expect(() => parseSloConfig(validConfig({ systemActorUserId: "not-a-uuid" } as Partial<SloConfig>))).toThrow();
    expect(() => parseSloConfig({ ...(validConfig() as object), bogus: true })).toThrow();
  });
});

describe("loadSloConfig", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir !== null) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("reads + validates a temp JSON file", async () => {
    dir = await mkdtemp(join(tmpdir(), "slo-config-"));
    const path = join(dir, "slo.json");
    await writeFile(path, JSON.stringify(validConfig()), "utf8");
    const cfg = await loadSloConfig(path);
    expect(cfg.availability).toHaveLength(1);
    expect(cfg.alertPolicy.id).toBe("default");
  });

  it("throws a clear error on a missing file", async () => {
    await expect(loadSloConfig("/no/such/slo-config.json")).rejects.toThrow(/failed to read SLO config/);
  });

  it("throws a clear error on invalid JSON", async () => {
    dir = await mkdtemp(join(tmpdir(), "slo-config-"));
    const path = join(dir, "bad.json");
    await writeFile(path, "{not json", "utf8");
    await expect(loadSloConfig(path)).rejects.toThrow(/not valid JSON/);
  });
});

describe("buildSloEnforcement", () => {
  it("builds only the engines whose registrations are present", () => {
    const clock = new FixedClock(new Date(END));
    const availOnly = buildSloEnforcement(parseSloConfig(validConfig()), { clock });
    expect(availOnly.engines.availability).not.toBeNull();
    expect(availOnly.engines.latency).toBeNull();

    const latOnly = buildSloEnforcement(
      parseSloConfig(validConfig({ availability: undefined, latency: [{ slo: latencySlo(SURFACE) }] })),
      { clock },
    );
    expect(latOnly.engines.availability).toBeNull();
    expect(latOnly.engines.latency).not.toBeNull();
  });

  it("drives a breach_opened decision from a failure burst fed through the observer sink", async () => {
    const clock = new FixedClock(new Date(END));
    const enforcement = buildSloEnforcement(parseSloConfig(validConfig()), { clock });
    const sink = enforcement.observer.asExecutionSink();
    for (let i = 0; i < 25; i += 1) {
      sink(makeExecution(503, "error", new Date(Date.parse(END) - i * 1_000).toISOString()));
    }
    const decisions = await enforcement.scheduler.evaluateOnce();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.signal).toBe("availability");
    expect(decisions[0]?.kind).toBe("breach_opened");
    expect(decisions[0]?.surface).toBe(SURFACE);
    expect(decisions[0]?.incidentId).toMatch(/^INC-/);
  });

  it("routes decisions to onDecision when the scheduler evaluates", async () => {
    const clock = new FixedClock(new Date(END));
    const seen: string[] = [];
    const enforcement = buildSloEnforcement(parseSloConfig(validConfig()), {
      clock,
      onDecision: (d) => seen.push(`${d.signal}:${d.kind}`),
    });
    const sink = enforcement.observer.asExecutionSink();
    for (let i = 0; i < 25; i += 1) {
      sink(makeExecution(503, "error", new Date(Date.parse(END) - i * 1_000).toISOString()));
    }
    await enforcement.scheduler.evaluateOnce();
    expect(seen).toEqual(["availability:breach_opened"]);
  });

  it("reports itself unpersisted without a connection", () => {
    expect(buildSloEnforcement(parseSloConfig(validConfig())).persisted).toBe(false);
  });

  it("persists evaluations, actions and the incident itself over a connection", async () => {
    const capture: { sql: string }[] = [];
    const clock = new FixedClock(new Date(END));
    const enforcement = buildSloEnforcement(parseSloConfig(validConfig()), {
      clock,
      conn: allocatingConnection(capture, 88),
    });
    expect(enforcement.persisted).toBe(true);
    const sink = enforcement.observer.asExecutionSink();
    for (let i = 0; i < 25; i += 1) {
      sink(makeExecution(503, "error", new Date(Date.parse(END) - i * 1_000).toISOString()));
    }
    const decisions = await enforcement.scheduler.evaluateOnce();
    // The id on the decision is the id of the row — not a counter's INC-YYYY-0001.
    expect(decisions[0]?.incidentId).toBe("INC-2026-0088");
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.incidents"))).toBe(true);
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.slo_enforcement_actions"))).toBe(
      true,
    );
    expect(capture.some((c) => c.sql.includes("INSERT INTO meta.slo_evaluations"))).toBe(true);
  });

  it("gives both signals ids from one sequence, so they cannot collide", async () => {
    const capture: { sql: string }[] = [];
    const clock = new FixedClock(new Date(END));
    const enforcement = buildSloEnforcement(
      parseSloConfig(
        validConfig({
          latency: [{ slo: latencySlo("GET /v1/items") }],
        }),
      ),
      { clock, conn: allocatingConnection(capture, 88) },
    );
    expect(enforcement.engines.availability).not.toBeNull();
    expect(enforcement.engines.latency).not.toBeNull();
    const sink = enforcement.observer.asExecutionSink();
    for (let i = 0; i < 25; i += 1) {
      sink(makeExecution(503, "error", new Date(Date.parse(END) - i * 1_000).toISOString()));
    }
    for (let i = 0; i < 30; i += 1) {
      enforcement.engines.latency?.recordOutcome({
        surface: "GET /v1/items",
        outcome: "ok",
        at: new Date(Date.parse(END) - i * 1_000).toISOString(),
        latencyMs: 4_000,
      });
    }
    const ids = (await enforcement.scheduler.evaluateOnce()).map((d) => d.incidentId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["INC-2026-0088", "INC-2026-0089"]);
  });
});

/**
 * Recovering the grade of an episode this process did not page (ADR-0327).
 *
 * ADR-0326's rule is that a resolve reaches exactly where its trigger did, because `AlertPolicy`
 * maps a severity to a channel set — so the grade *is* the route. A `recovered` decision carries no
 * severity, so the only non-guessing source for one is the stored record, and every way of failing
 * to read it must answer `[]`: an alert left up is noise, an alert wrongly closed is silence.
 */
describe("defaultRecoverPages", () => {
  const INC = "INC-2026-0042";
  const DECLARED_AT = "2026-06-02T11:00:00.000Z";

  /** Two routes to deliberately *different* channel sets, so a mis-graded resolve is visible. */
  const gradedPolicy: AlertPolicy = {
    id: "graded",
    routes: [
      { severity: "P0", channels: [{ kind: "pagerduty_phone", serviceKey: "svc-p0" }] },
      { severity: "P2", channels: [{ kind: "slack", channel: "#oncall-p2" }] },
    ],
  };

  function record(severity: IncidentRecord["severity"], id: string = INC): IncidentRecord {
    return IncidentRecordSchema.parse({
      id,
      title: `error-budget burn on ${SURFACE}`,
      severity,
      category: "availability",
      status: "declared",
      declaredAt: DECLARED_AT,
      declaredBy: "operate-server",
      autoDeclaredFor: `availability:${SURFACE}`,
      timeline: [
        {
          occurredAt: DECLARED_AT,
          actorUserId: "operate-server",
          kind: "declared",
          message: "burn rate over threshold",
        },
      ],
    });
  }

  function recovered(over: Record<string, unknown> = {}): ObservedEnforcementDecision {
    return {
      signal: "availability",
      kind: "recovered",
      surface: SURFACE,
      sloId: "product-list-availability",
      severity: null,
      incidentId: INC,
      killSwitchId: null,
      closeOut: "cancelled",
      pages: [],
      ...over,
    } as ObservedEnforcementDecision;
  }

  /**
   * A declarer that answers `findById` the way the test asks and nothing else — `declare` throws
   * because reaching it would mean this seam was wired to the wrong method.
   */
  function declarerFor(
    answer: { readonly record: IncidentRecord | null } | { readonly throws: Error },
  ): { readonly declarer: IncidentDeclarer; readonly lookups: string[] } {
    const lookups: string[] = [];
    const declarer: IncidentDeclarer = {
      declare: async (_request: IncidentDeclarationRequest): Promise<IncidentRecord> => {
        throw new Error("declare must not be reached by a recovery");
      },
      findOpen: async (_autoDeclaredFor: string): Promise<IncidentRecord | null> => null,
      findById: async (incidentId: string): Promise<IncidentRecord | null> => {
        lookups.push(incidentId);
        if ("throws" in answer) throw answer.throws;
        return answer.record;
      },
      closeOut: async (
        _incidentId: string,
        _input: IncidentCloseOutInput,
      ): Promise<IncidentCloseOut> => "unpersisted",
    };
    return { declarer, lookups };
  }

  it("plans from the record's own grade, not from a default", async () => {
    const { declarer, lookups } = declarerFor({ record: record("sev3") });
    const pages = await defaultRecoverPages(gradedPolicy, declarer)(recovered());
    expect(lookups).toEqual([INC]);
    expect(pages).toHaveLength(1);
    // The defect ADR-0326 fixed, in a new place: a sev3 episode resolved at the P0 service would
    // close an alert that service never had, and leave the P2 rotation a page nobody closed.
    expect(pages[0]?.severity).toBe("sev3");
    expect(pages[0]?.alertSeverity).toBe("P2");
    expect(pages[0]?.channels).toEqual([{ kind: "slack", channel: "#oncall-p2" }]);
    expect(pages[0]?.incidentId).toBe(INC);
  });

  it("plans the other grade's route for the other grade", async () => {
    const { declarer } = declarerFor({ record: record("sev1") });
    const pages = await defaultRecoverPages(gradedPolicy, declarer)(recovered());
    expect(pages[0]?.alertSeverity).toBe("P0");
    expect(pages[0]?.channels).toEqual([{ kind: "pagerduty_phone", serviceKey: "svc-p0" }]);
  });

  it("names the record's id, not the decision's, as the alert to close", async () => {
    // They are the same id in practice; pinning it means a future change that reads the id off the
    // decision instead cannot pass by accident.
    const { declarer } = declarerFor({ record: record("sev3", "INC-2026-0099") });
    const pages = await defaultRecoverPages(gradedPolicy, declarer)(recovered());
    expect(pages[0]?.incidentId).toBe("INC-2026-0099");
  });

  it("answers [] with no declarer at all", async () => {
    // No `--store pg`: ids came from a per-process counter and name no row anywhere.
    expect(await defaultRecoverPages(gradedPolicy, undefined)(recovered())).toEqual([]);
  });

  it("answers [] for a declarer that does not implement findById", async () => {
    // The seam is optional, and absent means to a caller exactly what null means.
    const minimal: IncidentDeclarer = {
      declare: async (_request: IncidentDeclarationRequest): Promise<IncidentRecord> => {
        throw new Error("declare must not be reached by a recovery");
      },
      findOpen: async (_autoDeclaredFor: string): Promise<IncidentRecord | null> => null,
      closeOut: async (
        _incidentId: string,
        _input: IncidentCloseOutInput,
      ): Promise<IncidentCloseOut> => "unpersisted",
    };
    expect(minimal.findById).toBeUndefined();
    expect(await defaultRecoverPages(gradedPolicy, minimal)(recovered())).toEqual([]);
  });

  it("answers [] when findById finds no such incident", async () => {
    const { declarer, lookups } = declarerFor({ record: null });
    expect(await defaultRecoverPages(gradedPolicy, declarer)(recovered())).toEqual([]);
    expect(lookups).toEqual([INC]);
  });

  it("answers [] without a lookup when the decision carries no incident id", async () => {
    const { declarer, lookups } = declarerFor({ record: record("sev3") });
    const pages = await defaultRecoverPages(gradedPolicy, declarer)(
      recovered({ incidentId: null }),
    );
    expect(pages).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it("lets a throw from findById propagate rather than swallowing it", async () => {
    // `PostgresIncidentDeclarer.findById` throws only for a row that exists and no longer parses
    // (ADR-0289) — a tampered or corrupted record. Planning an alert's closure from a record the
    // contract rejects is worse than failing the pass, which `evaluateOnce` routes to `onError`.
    const { declarer } = declarerFor({ throws: new Error("incident row no longer parses") });
    await expect(defaultRecoverPages(gradedPolicy, declarer)(recovered())).rejects.toThrow(
      /no longer parses/,
    );
  });

  it("answers [] when the policy has no route for the record's grade", async () => {
    // `planPageDirective` answers null, and an ungraded route is not a licence to pick another.
    const { declarer } = declarerFor({ record: record("sev4") });
    expect(await defaultRecoverPages(gradedPolicy, declarer)(recovered())).toEqual([]);
  });
});

/**
 * The default is wired into the scheduler, and an explicit one overrides it (ADR-0327).
 *
 * Both tests breach the engine **directly**, bypassing the scheduler, so the scheduler never sees
 * the `breach_opened` decision and remembers no directives — which is precisely what a restart
 * mid-episode leaves behind. Advancing the clock past the burn windows then makes the next
 * scheduler pass a recovery with nothing remembered for it.
 */
describe("buildSloEnforcement — recoverPages", () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

  async function breachThenRecover(
    enforcement: ReturnType<typeof buildSloEnforcement>,
    clock: FixedClock,
  ): Promise<readonly ObservedEnforcementDecision[]> {
    const engine = enforcement.engines.availability;
    if (engine === null) throw new Error("expected an availability engine");
    for (let i = 0; i < 25; i += 1) {
      engine.recordOutcome({
        surface: SURFACE,
        outcome: "error",
        at: new Date(Date.parse(END) - i * 1_000).toISOString(),
        statusCode: 503,
      });
    }
    const opened = await engine.evaluate();
    expect(opened[0]?.kind).toBe("breach_opened");
    clock.advance(SEVEN_DAYS_MS);
    return enforcement.scheduler.evaluateOnce();
  }

  it("uses an explicit recoverPages when one is given", async () => {
    const clock = new FixedClock(new Date(END));
    const resolved: Array<readonly PageDirective[]> = [];
    const directive = {
      incidentId: "INC-2026-0001",
      severity: "sev2",
      alertSeverity: "P1",
      channels: [{ kind: "pagerduty_phone", serviceKey: "svc-explicit" }],
    } as unknown as PageDirective;
    let asked = 0;
    const enforcement = buildSloEnforcement(parseSloConfig(validConfig()), {
      clock,
      recoverPages: async () => {
        asked += 1;
        return [directive];
      },
      onResolvePage: async (_d, pages) => {
        resolved.push(pages);
      },
    });
    const decisions = await breachThenRecover(enforcement, clock);
    expect(decisions[0]?.kind).toBe("recovered");
    expect(asked).toBe(1);
    expect(resolved).toEqual([[directive]]);
  });

  it("defaults to the config's own policy and the shared declarer", async () => {
    const clock = new FixedClock(new Date(END));
    const resolved: Array<readonly PageDirective[]> = [];
    // The declarer must be the *shared* one: `buildSloEnforcement` only has a declarer to ask when
    // the caller supplies one (or a connection). The engine's own private fallback is unreachable
    // from here, which is why a deployment with no store recovers nothing.
    const declarer = new CountingIncidentDeclarer({ clock });
    const enforcement = buildSloEnforcement(parseSloConfig(validConfig()), {
      clock,
      declarer,
      onResolvePage: async (_d, pages) => {
        resolved.push(pages);
      },
    });
    const decisions = await breachThenRecover(enforcement, clock);
    const incidentId = decisions[0]?.incidentId ?? null;
    expect(incidentId).toMatch(/^INC-/);
    // Planned from the grade on the record the declarer still holds, routed through the config's
    // own alert policy — the P1 route, which is the one the trigger would have used.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.[0]?.alertSeverity).toBe("P1");
    expect(resolved[0]?.[0]?.channels).toEqual([
      { kind: "pagerduty_phone", serviceKey: "svc-oncall" },
    ]);
    expect(resolved[0]?.[0]?.incidentId).toBe(incidentId);
  });
});
