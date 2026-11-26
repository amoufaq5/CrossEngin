import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import type { RouteDefinition } from "@crossengin/api-gateway";
import {
  INCIDENT_STATUSES,
  INCIDENT_TRANSITIONS,
  profileFor,
  requiresPostmortem,
  type Severity,
} from "@crossengin/incident-response";
import {
  CountingIncidentDeclarer,
  closeOutClosesAlert,
} from "@crossengin/incident-response-runtime";
import { PostgresIncidentDeclarer } from "@crossengin/incident-response-runtime-pg";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DEFAULT_BURN_RATE_THRESHOLDS,
  DEFAULT_LATENCY_THRESHOLDS,
  SloEnforcementEngine,
} from "@crossengin/observability-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";

import { parseReplayArgs, parseServeArgs } from "./cli.js";
import { DeletionEscalationConfigSchema } from "./deletion-escalation-config.js";
import { DeletionEvidenceEscalator } from "./deletion-evidence-escalation.js";
import {
  AUTOMATED_INCIDENT_WRITERS,
  formatIncidentLifecycle,
  surveyIncidentLifecycle,
  type IncidentLifecycleSurveyInput,
} from "./incident-lifecycle-survey.js";
import { IntegrityEscalationConfigSchema } from "./integrity-escalation-config.js";
import { IntegrityEscalator } from "./integrity-escalation.js";
import { DEFAULT_INTEGRITY_PROOF_CONFIG } from "./integrity-proof.js";
import { scopeRefusal } from "./replay.js";
import { buildSloEnforcement } from "./slo-config.js";
import { DEFAULT_SLO_ALERT_POLICY, deriveSloConfig } from "./slo-defaults.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../../..");

/** A connection nothing in these tests queries: the declarer only needs one to exist. */
function idleConnection(): PgConnection {
  const conn: PgConnection = {
    query: vi.fn(async () => {
      throw new Error("the survey must not query");
    }) as PgConnection["query"],
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as
      PgConnection["transaction"],
    withAdvisoryLock: vi.fn(async <T>(_key: bigint, fn: () => Promise<T>) => fn()) as
      PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return conn;
}

const integrityConfig = IntegrityEscalationConfigSchema.parse({ alertPolicy: DEFAULT_SLO_ALERT_POLICY });
const deletionConfig = DeletionEscalationConfigSchema.parse({ alertPolicy: DEFAULT_SLO_ALERT_POLICY });

function storedDeclarer(): PostgresIncidentDeclarer {
  return new PostgresIncidentDeclarer({ conn: idleConnection() });
}

function sloFromDefaults(persisted: boolean): IncidentLifecycleSurveyInput["slo"] {
  // `--slo-defaults`' own path: the manifest-derived config, built exactly as `node.ts` builds it.
  const built = buildSloEnforcement(deriveSloConfig(buildErpCorePack()), {
    onDeclarationError: () => undefined,
  });
  return { engines: built.engines, persisted, escalationGrades: built.escalationGrades };
}

const NOTHING: IncidentLifecycleSurveyInput = {
  slo: null,
  integrity: null,
  deletion: null,
  routes: [],
};

/** The shipped compose: `--integrity-proof`, which resolves to the default proof config. */
const SHIPPED: IncidentLifecycleSurveyInput = {
  ...NOTHING,
  integrity: { flag: "--integrity-proof", proof: DEFAULT_INTEGRITY_PROOF_CONFIG, escalation: null },
};

const EVERYTHING: IncidentLifecycleSurveyInput = {
  // With an escalation declared on the availability engine, so the regrade writer is wired too.
  slo: { ...sloFromDefaults(true)!, escalationGrades: { availability: ["sev1"], latency: [] } },
  integrity: {
    flag: "--integrity-proof-config",
    proof: DEFAULT_INTEGRITY_PROOF_CONFIG,
    escalation: (() => {
      const declarer = storedDeclarer();
      return { escalator: new IntegrityEscalator({ config: integrityConfig, declarer }), declarer, config: integrityConfig };
    })(),
  },
  deletion: (() => {
    const declarer = storedDeclarer();
    return {
      escalator: new DeletionEvidenceEscalator({ config: deletionConfig, declarer }),
      declarer,
      config: deletionConfig,
    };
  })(),
  routes: [],
};

function route(operationId: string, literals: readonly string[]): Pick<RouteDefinition, "operationId" | "pathSegments"> {
  return { operationId, pathSegments: literals.map((value) => ({ kind: "literal" as const, value })) };
}

describe("the shipped stack", () => {
  it("rests on the default proof config carrying no escalation block", () => {
    expect(DEFAULT_INTEGRITY_PROOF_CONFIG.escalation).toBeUndefined();
    expect(DEFAULT_INTEGRITY_PROOF_CONFIG.recordVerdict).toBe(true);
  });

  it("says a COMPROMISED verdict declares no incident and pages nobody, naming the flag that adds escalation", () => {
    const line = formatIncidentLifecycle(surveyIncidentLifecycle(SHIPPED));
    expect(line).toContain("no incident escalator is built");
    expect(line).toContain(
      "--integrity-proof runs with no escalation, so a COMPROMISED verdict is an error line and a stored verdict row, declares no incident and pages nobody",
    );
    expect(line).toContain("mutually exclusive with --integrity-proof");
    // With nothing declaring, there is no lifecycle to describe.
    expect(line).not.toContain("lifecycle edges");
  });

  it("is right that the two integrity flags are mutually exclusive", () => {
    expect(() =>
      parseServeArgs(["--pack", "erp-core", "--integrity-proof", "--integrity-proof-config", "x.json"]),
    ).toThrow(/mutually exclusive/);
  });

  it("names the file, not the other flag, when the proof came from --integrity-proof-config", () => {
    const line = formatIncidentLifecycle(
      surveyIncidentLifecycle({
        ...NOTHING,
        integrity: {
          flag: "--integrity-proof-config",
          proof: { ...DEFAULT_INTEGRITY_PROOF_CONFIG, recordVerdict: false },
          escalation: null,
        },
      }),
    );
    expect(line).toContain("a COMPROMISED verdict is an error line, declares no incident");
    expect(line).toContain("needs an `escalation` block in that file");
    expect(line).not.toContain("mutually exclusive");
  });

  it("says nothing declares when nothing is built, in one clause", () => {
    expect(formatIncidentLifecycle(surveyIncidentLifecycle(NOTHING))).toBe(
      "[incident] no incident escalator is built, so nothing in this process declares an incident",
    );
  });
});

describe("the grades each escalator declares at come from the configs actually built", () => {
  // Replaces `lifecycle-prerequisites.test.ts`' block that read no escalator and claimed every
  // declarable incident was uncloseable — false for the SLO loop's sev3 thresholds.
  const survey = surveyIncidentLifecycle(EVERYTHING);
  const grades = (name: string): readonly Severity[] =>
    survey.escalators.find((e) => e.name === name)?.grades ?? [];

  it("builds all four routes to a declarer, the fileless --slo-defaults among them", () => {
    expect(survey.escalators.map((e) => e.name)).toEqual([
      "slo-availability",
      "slo-latency",
      "integrity-proof",
      "deletion-evidence",
    ]);
  });

  it("reads the SLO grades off the thresholds the engines run on", () => {
    const burn = new Set(DEFAULT_BURN_RATE_THRESHOLDS.map((t) => t.severity));
    const latency = new Set(DEFAULT_LATENCY_THRESHOLDS.map((t) => t.severity));
    // EVERYTHING declares an availability escalation to sev1, which the engine can re-page at.
    expect(new Set(grades("slo-availability"))).toEqual(new Set([...burn, "sev1"]));
    expect(new Set(grades("slo-latency"))).toEqual(latency);
  });

  it("adds an escalation grade, and the regrade writer, only from a built escalation", () => {
    const plain = surveyIncidentLifecycle({ ...NOTHING, slo: sloFromDefaults(true) });
    expect(plain.writers).not.toContain("regrader");
    expect(new Set(plain.escalators[0]?.grades)).toEqual(
      new Set(DEFAULT_BURN_RATE_THRESHOLDS.map((t) => t.severity)),
    );
    const memory = surveyIncidentLifecycle({
      ...NOTHING,
      slo: { ...sloFromDefaults(false)!, escalationGrades: { availability: ["sev1"], latency: [] } },
    });
    // No store, so no regrade can write a row.
    expect(memory.writers).not.toContain("regrader");
  });

  it("reads the integrity grade off its parsed config, and the deletion grades off severity, overrides and the stall grade", () => {
    expect(grades("integrity-proof")).toEqual([integrityConfig.severity]);
    expect(new Set(grades("deletion-evidence"))).toEqual(
      new Set([deletionConfig.severity, deletionConfig.sweepStallSeverity]),
    );
    const graded = surveyIncidentLifecycle({
      ...EVERYTHING,
      deletion: EVERYTHING.deletion === null
        ? null
        : {
            ...EVERYTHING.deletion,
            config: { ...deletionConfig, severityByDefect: { unwitnessed: "sev4" } },
          },
    });
    expect(graded.escalators.find((e) => e.name === "deletion-evidence")?.grades).toEqual([
      "sev1",
      "sev2",
      "sev4",
    ]);
  });

  it("includes grades on both sides of the postmortem rule — the SLO loop declares closeable sev3s", () => {
    const slo = [...grades("slo-availability"), ...grades("slo-latency")];
    expect(slo.some((g) => !requiresPostmortem(g) && !profileFor(g).requiresStatusPage)).toBe(true);
    expect(grades("integrity-proof").every((g) => requiresPostmortem(g))).toBe(true);
    expect(grades("deletion-evidence").every((g) => requiresPostmortem(g))).toBe(true);
  });

  it("reads the grades off the engines' own thresholds, so an injected set is described as it runs", () => {
    // ADR-0483: this used to read the package defaults and pin, with a text fence over
    // slo-config.ts, that no caller passed `thresholds`. It reads `declaredSeverities` now.
    const custom = new SloEnforcementEngine({
      alertPolicy: DEFAULT_SLO_ALERT_POLICY,
      systemActorUserId: "00000000-0000-0000-0000-000000000001",
      registrations: [],
      thresholds: DEFAULT_BURN_RATE_THRESHOLDS.map((t) => ({ ...t, severity: "sev5" as const })),
      onDeclarationError: () => undefined,
    });
    const s = surveyIncidentLifecycle({
      ...NOTHING,
      slo: {
        engines: { availability: custom, latency: null },
        persisted: true,
        escalationGrades: { availability: [], latency: [] },
      },
    });
    expect(s.escalators).toEqual([{ name: "slo-availability", grades: ["sev5"], storage: "stored" }]);
    expect(formatIncidentLifecycle(s)).toContain("slo-availability at sev5;");
  });

  it("marks an in-memory SLO loop as never stored and derives no stored lifecycle from it", () => {
    const s = surveyIncidentLifecycle({ ...NOTHING, slo: sloFromDefaults(false) });
    expect(s.escalators.every((e) => e.storage === "memory")).toBe(true);
    expect(s.writers).toEqual([]);
    expect(s.reachableEdges).toEqual([]);
    const line = formatIncidentLifecycle(s);
    expect(line).toContain("held in process memory, never stored");
    expect(line).not.toContain("meta.incidents");
    expect(line).toContain("any alert an incident paged is resolved only when its signal recovers");
  });

  it("derives storage from the declarer's class, not from a flag", () => {
    const counting = new CountingIncidentDeclarer();
    const s = surveyIncidentLifecycle({
      ...NOTHING,
      deletion: {
        escalator: new DeletionEvidenceEscalator({ config: deletionConfig, declarer: counting }),
        declarer: counting,
        config: deletionConfig,
      },
    });
    expect(s.escalators[0]?.storage).toBe("memory");
    expect(s.writers).toEqual([]);
  });

  it("says the integrity escalator's record is stored only while the store accepts it", () => {
    // `IntegrityEscalator` wraps its declarer in a `FallbackIncidentDeclarer`: a refused
    // declaration is held in process memory so the page still goes out. "stored" was a claim the
    // wrapper does not make (ADR-0483).
    const integrity = surveyIncidentLifecycle(EVERYTHING).escalators.find((e) => e.name === "integrity-proof");
    expect(integrity?.storage).toBe("stored_unless_refused");
    expect(formatIncidentLifecycle(surveyIncidentLifecycle(EVERYTHING))).toContain(
      "integrity-proof at sev1 (stored when the store accepts it, held in process memory on refusal)",
    );
    // The deletion escalator has no fallback, so it stays plainly stored.
    expect(surveyIncidentLifecycle(EVERYTHING).escalators.find((e) => e.name === "deletion-evidence")?.storage).toBe(
      "stored",
    );
  });
});

describe("the reachable lifecycle is derived by running the writers", () => {
  const survey = surveyIncidentLifecycle(EVERYTHING);

  it("reaches exactly declared->cancelled, by the declarer's close-out, of every edge in the map", () => {
    const total = INCIDENT_STATUSES.reduce((n, s) => n + INCIDENT_TRANSITIONS[s].length, 0);
    expect(survey.totalEdges).toBe(total);
    expect(total).toBeGreaterThan(1);
    expect(survey.reachableEdges).toEqual([{ from: "declared", to: "cancelled", by: ["declarer"] }]);
  });

  it("wires every writer when every stored escalator is built, so the derivation is not vacuous", () => {
    expect(survey.writers).toEqual([...AUTOMATED_INCIDENT_WRITERS]);
  });

  it("is a close-out that resolves the alert, which is why only an unrecovered signal leaves one up", () => {
    expect(closeOutClosesAlert("cancelled")).toBe(true);
    expect(closeOutClosesAlert("failed")).toBe(false);
  });

  it("prints the derived figure and every verb it is entitled to", () => {
    const line = formatIncidentLifecycle(survey);
    expect(line).toContain(
      "incidents are declared by slo-availability at sev1/sev2/sev3, slo-latency at sev2/sev3, integrity-proof at sev1 (stored when the store accepts it, held in process memory on refusal), deletion-evidence at sev1/sev2",
    );
    expect(line).toContain("they reach 1 of 12 lifecycle edges (declared->cancelled, by the declarer's close-out) and the paged note and the stall-kind note and the escalation regrade move no status");
    expect(line).toContain(
      "no HTTP route, and so no console page, can acknowledge, assign, advance, attach a postmortem to or close an incident",
    );
    expect(line).toContain("`operate-server replay --all-tenants`");
    expect(line).toContain("the record stays declared and the alert stays open at the paging provider");
    // Names no remedy for closing: the contract permits closing every grade and no flag supplies a
    // caller of `transition` (ADR-0334). A status page or a postmortem id offered here would be the
    // attribution error this line exists to avoid.
    expect(line).not.toMatch(/status page|postmortem id|pass --|set --/i);
    // "read" is not among the verbs: replay reads, and the line says so instead.
    expect(line).not.toMatch(/\bread a declared\b|\bor read\b/);
  });

  it("names `operate-server replay --all-tenants` because no other scope reads meta.incidents", () => {
    expect(scopeRefusal("incidents", { kind: "unscoped" })).toBeNull();
    expect(scopeRefusal("incidents", { kind: "platform" })).not.toBeNull();
    expect(scopeRefusal("incidents", { kind: "tenant", tenantId: "t" })).not.toBeNull();
    // Unscoped is reachable only through --all-tenants: a scopeless invocation is a usage error.
    expect(() => parseReplayArgs(["--subsystem", "incidents"])).toThrow();
  });
});

describe("the route half is read off the live registry", () => {
  it("changes the line by itself the day a platform incident route is registered", () => {
    const line = formatIncidentLifecycle(
      surveyIncidentLifecycle({
        ...EVERYTHING,
        routes: [
          route("platform.incidents.list", ["v1", "platform", "incidents"]),
          route("invoice.list", ["v1", "invoices"]),
        ],
      }),
    );
    expect(line).toContain("1 incident route(s) are registered (platform.incidents.list)");
    expect(line).not.toContain("no HTTP route");
    expect(line).not.toContain("the record stays declared");
  });

  it("matches by path as well as by operation id", () => {
    const s = surveyIncidentLifecycle({
      ...EVERYTHING,
      routes: [route("platform.oncall.ack", ["v1", "meta", "incident", "ack"])],
    });
    expect(s.incidentRoutes).toEqual(["platform.oncall.ack"]);
  });

  it("does not mistake an entity named Incident for the incident record", () => {
    const s = surveyIncidentLifecycle({
      ...EVERYTHING,
      routes: [route("incident.list", ["v1", "incidents"]), route("incident.read", ["v1", "incidents", "x"])],
    });
    expect(s.incidentRoutes).toEqual([]);
  });
});

describe("the writer table is the whole set of automated writers of meta.incidents", () => {
  // The derivation above runs only the writers this module knows. If an incident route lands in a
  // new file holding its own engine or store, this census names it — so the line cannot keep printing
  // "1 of 12" over a deployment that can now triage.
  const PATTERNS: Readonly<Record<string, RegExp>> = {
    engine: /new PersistentIncidentEngine\(/,
    store: /new PostgresIncidentStore\(/,
    declarer: /new PostgresIncidentDeclarer\(/,
    pagedNote: /\.appendPagedNote\(/,
    observationNote: /\bappendIncidentNote\(/,
  };
  const EXPECTED: Readonly<Record<string, readonly string[]>> = {
    engine: [
      "packages/incident-response-runtime-pg/src/declarer.ts",
      "packages/observability-runtime-pg/src/persisting-engine.ts",
    ],
    store: [
      "apps/operate-server/src/node.ts",
      "packages/incident-response-runtime-pg/src/persisting-engine.ts",
    ],
    declarer: [
      "apps/operate-server/src/node.ts",
      "apps/operate-server/src/slo-config.ts",
      "packages/observability-runtime-pg/src/latency-persisting-engine.ts",
      "packages/observability-runtime-pg/src/persisting-engine.ts",
    ],
    pagedNote: ["apps/operate-server/src/node.ts"],
    observationNote: ["apps/operate-server/src/incident-note.ts", "apps/operate-server/src/node.ts"],
  };
  const files = sourceFiles();

  it("scans the workspace's source and not its build output", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.includes("/dist/") || f.includes("node_modules"))).toBe(false);
  });

  it.each(Object.keys(PATTERNS))("finds %s exactly where the survey's writer table expects it", (key) => {
    const pattern = PATTERNS[key];
    if (pattern === undefined) throw new Error(key);
    const hits = files
      .filter((f) => pattern.test(stripComments(readFileSync(join(REPO, f), "utf8"))))
      .sort();
    expect(hits).toEqual(EXPECTED[key]);
  });
});

function sourceFiles(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".next" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "test-fakes.ts") {
        out.push(relative(REPO, full));
      }
    }
  };
  for (const root of ["packages", "apps"]) walk(join(REPO, root));
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
