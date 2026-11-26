import type { RouteDefinition } from "@crossengin/api-gateway";
import {
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
  INCIDENT_TRANSITIONS,
  SEVERITIES,
  type IncidentRecord,
  type IncidentStatus,
  type Severity,
} from "@crossengin/incident-response";
import {
  FixedClock,
  IncidentExecutor,
  cancelIfUntriaged,
  type IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import { PostgresIncidentDeclarer } from "@crossengin/incident-response-runtime-pg";

import type { DeletionEscalationConfig } from "./deletion-escalation-config.js";
import type { DeletionEvidenceEscalator } from "./deletion-evidence-escalation.js";
import type { IntegrityEscalationConfig } from "./integrity-escalation-config.js";
import type { IntegrityEscalator } from "./integrity-escalation.js";
import type { IntegrityProofConfig } from "./integrity-proof.js";
import type { SloEnforcement } from "./slo-config.js";

/**
 * The `[incident]` boot line: what a deployment that declares an incident does with it afterwards.
 *
 * Every field of the input is an object only the construction site can hold — a built
 * `SloEnforcement`, an escalator instance and the declarer it was given, the parsed config the
 * escalator was built from — so the line cannot be filled from the flags, and cannot come to
 * disagree with the wiring it describes (ADR-0361). The route-absence half is read off the live
 * registry for the same reason: the day an incident route is registered, the line changes by itself.
 *
 * The lifecycle figure is **derived**, not declared: the automated writers this binary wires are run
 * against a declared record until nothing new is reached, and the edges they caused are counted
 * against `INCIDENT_TRANSITIONS`. Which writers exist is fenced by a workspace census in the test.
 *
 * It names no remedy for closing an incident, deliberately: the contract permits closing every grade,
 * and what is missing is a caller of `transition`, which no flag supplies (ADR-0334).
 */

/** The flag that built the integrity proof, because the remedy for "no escalation" differs by it. */
export type IntegrityProofFlag = "--integrity-proof" | "--integrity-proof-config";

export interface IntegrityEscalationWiring {
  /** The built escalator: proof it exists, which a flag is not. */
  readonly escalator: IntegrityEscalator;
  /** The declarer it was given — `PostgresIncidentDeclarer` is what makes the record durable. */
  readonly declarer: IncidentDeclarer;
  /** `proof.escalation`, narrowed: the config the escalator was built from. */
  readonly config: IntegrityEscalationConfig;
}

export interface DeletionEscalationWiring {
  readonly escalator: DeletionEvidenceEscalator;
  readonly declarer: IncidentDeclarer;
  readonly config: DeletionEscalationConfig;
}

export interface IntegrityProofWiring {
  readonly flag: IntegrityProofFlag;
  /** The parsed proof config the lifecycle was built from. */
  readonly proof: IntegrityProofConfig;
  /** Null exactly when `proof.escalation` was absent and no escalator was built. */
  readonly escalation: IntegrityEscalationWiring | null;
}

export interface IncidentLifecycleSurveyInput {
  /** The built SLO enforcement, from `--slo-config` or `--slo-defaults`, or null. */
  readonly slo: Pick<SloEnforcement, "engines" | "persisted" | "escalationGrades"> | null;
  /** The built integrity proof, or null when it was not built. */
  readonly integrity: IntegrityProofWiring | null;
  readonly deletion: DeletionEscalationWiring | null;
  /** The live registry's routes (`gateway.routes.list()`), not a declaration of them. */
  readonly routes: readonly Pick<RouteDefinition, "operationId" | "pathSegments">[];
}

/**
 * Where an escalator's declared record ends up. Three values, not a boolean (ADR-0483): the
 * integrity escalator wraps its store-backed declarer in a `FallbackIncidentDeclarer`, so its
 * record is stored when the store accepts the declaration and **held in process memory when the
 * store refuses it** — reading that as "stored" (the old `instanceof PostgresIncidentDeclarer`)
 * claimed durability for the one escalator whose design is to page anyway when the store fails.
 */
export type EscalatorStorage = "stored" | "stored_unless_refused" | "memory";

/** The clause each storage adds to the boot line; empty for the plain stored case. */
const STORAGE_CLAUSE: Readonly<Record<EscalatorStorage, string>> = Object.freeze({
  stored: "",
  stored_unless_refused: " (stored when the store accepts it, held in process memory on refusal)",
  memory: " (held in process memory, never stored)",
});

export interface SurveyedEscalator {
  readonly name: string;
  /** The grades it can declare at, in severity order. */
  readonly grades: readonly Severity[];
  /** Whether its declarer writes `meta.incidents`, and under what condition. */
  readonly storage: EscalatorStorage;
}

export interface IncidentEdge {
  readonly from: IncidentStatus;
  readonly to: IncidentStatus;
  /** The writers that cause it. */
  readonly by: readonly AutomatedIncidentWriter[];
}

export interface IncidentLifecycleSurvey {
  readonly escalators: readonly SurveyedEscalator[];
  /** Set when the integrity proof runs with no escalation, which pages nobody. */
  readonly integrityWithoutEscalation: { readonly flag: IntegrityProofFlag; readonly recordsVerdict: boolean } | null;
  /** The automated writers of `meta.incidents` this wiring constructs. */
  readonly writers: readonly AutomatedIncidentWriter[];
  /** Edges of `INCIDENT_TRANSITIONS` those writers can cause on a stored record. */
  readonly reachableEdges: readonly IncidentEdge[];
  readonly totalEdges: number;
  /** Registered routes that read or move an incident record. */
  readonly incidentRoutes: readonly string[];
}

/** `platform` and `meta` are the non-entity namespaces: an entity named `Incident` is `/v1/incidents`. */
const RESERVED_NAMESPACES: ReadonlySet<string> = new Set(["platform", "meta"]);
const INCIDENT_NOUN = /^incidents?$/;

function isIncidentRoute(route: Pick<RouteDefinition, "operationId" | "pathSegments">): boolean {
  const ops = route.operationId.split(".");
  if (RESERVED_NAMESPACES.has(ops[0] ?? "") && ops.slice(1).some((s) => INCIDENT_NOUN.test(s))) {
    return true;
  }
  const literals = route.pathSegments.flatMap((s) => (s.kind === "literal" ? [s.value] : []));
  const ns = literals.findIndex((v) => RESERVED_NAMESPACES.has(v));
  // Index 0 or 1: a version segment may precede the namespace.
  return ns !== -1 && ns <= 1 && literals.slice(ns + 1).some((v) => INCIDENT_NOUN.test(v));
}

function sortedGrades(grades: Iterable<Severity>): readonly Severity[] {
  const set = new Set(grades);
  return SEVERITIES.filter((s) => set.has(s));
}

function surveyEscalators(input: IncidentLifecycleSurveyInput): readonly SurveyedEscalator[] {
  const out: SurveyedEscalator[] = [];
  // The grades come off the engines' own `declaredSeverities` — the thresholds each engine actually
  // runs on — and not the package defaults, which were right only while no caller passed
  // `thresholds` and were pinned by a text fence rather than read (ADR-0483). The SLO declarer has
  // no fallback (slo-config.ts says why), so a persisted engine's record is stored or not declared.
  const sloStorage: EscalatorStorage = input.slo?.persisted === true ? "stored" : "memory";
  if (input.slo !== null && input.slo.engines.availability !== null) {
    out.push({
      name: "slo-availability",
      grades: sortedGrades([
        ...input.slo.engines.availability.declaredSeverities,
        ...input.slo.escalationGrades.availability,
      ]),
      storage: sloStorage,
    });
  }
  if (input.slo !== null && input.slo.engines.latency !== null) {
    out.push({
      name: "slo-latency",
      grades: sortedGrades([
        ...input.slo.engines.latency.declaredSeverities,
        ...input.slo.escalationGrades.latency,
      ]),
      storage: sloStorage,
    });
  }
  const integrity = input.integrity?.escalation ?? null;
  if (integrity !== null) {
    out.push({
      name: "integrity-proof",
      grades: [integrity.config.severity],
      // `IntegrityEscalator` always wraps its declarer in a `FallbackIncidentDeclarer`, so a
      // store-backed primary is durable only while the store accepts the declaration.
      storage:
        integrity.declarer instanceof PostgresIncidentDeclarer ? "stored_unless_refused" : "memory",
    });
  }
  if (input.deletion !== null) {
    const c = input.deletion.config;
    out.push({
      name: "deletion-evidence",
      // `config.severity` stays reachable even when every defect is overridden: a finding reported
      // with no defects grades at it (`severityForDefects`).
      grades: sortedGrades([c.severity, ...Object.values(c.severityByDefect ?? {}), c.sweepStallSeverity]),
      // Store-backed with no fallback declarer (node.ts), so a store-backed declarer is stored.
      storage: input.deletion.declarer instanceof PostgresIncidentDeclarer ? "stored" : "memory",
    });
  }
  return out;
}

const PROBE_AT = "2026-01-01T00:00:00.000Z";
const PROBE_ACTOR = "incident-lifecycle-survey";

/** The automated writers of `meta.incidents` this binary can construct. */
export const AUTOMATED_INCIDENT_WRITERS = ["declarer", "paged_note", "stall_note", "regrader"] as const;
export type AutomatedIncidentWriter = (typeof AUTOMATED_INCIDENT_WRITERS)[number];

interface WriterSpec {
  readonly label: string;
  /** How an edge it causes is attributed in the line. */
  readonly short: string;
  /** The status change it makes to a stored record, or null when it declines. */
  readonly step: (record: IncidentRecord, ex: IncidentExecutor) => IncidentRecord | null;
}

/**
 * Each writer's effect, by calling the same function the live writer does:
 * `PostgresIncidentDeclarer.closeOut` is `cancelIfUntriaged` (its `declare` only ever creates a
 * `declared` row), `appendPagedNote` is `IncidentExecutor.notePage`, and `appendIncidentNote` — the
 * deletion escalator's stall-kind note — is `IncidentExecutor.note`, and the SLO engines' escalation
 * regrade (`incidentRegrader`) is `IncidentExecutor.changeSeverity`. A total map, so a fifth writer
 * is a compile error until it says what it does to a status.
 */
const WRITERS: Readonly<Record<AutomatedIncidentWriter, WriterSpec>> = Object.freeze({
  declarer: {
    label: "PostgresIncidentDeclarer (declare; cancel on recovery)",
    short: "the declarer's close-out",
    step: (r) => cancelIfUntriaged(r, { at: PROBE_AT, actorUserId: PROBE_ACTOR, reason: "probe" }),
  },
  paged_note: {
    label: "the paged-timeline note (appendPagedNote)",
    short: "the paged note",
    step: (r, ex) =>
      ex.notePage(r, {
        facts: { channels: [], delivered: 0, attempted: 0 },
        actorUserId: PROBE_ACTOR,
        at: PROBE_AT,
      }),
  },
  stall_note: {
    label: "the deletion stall-kind note (appendIncidentNote)",
    short: "the stall-kind note",
    step: (r, ex) =>
      ex.note(r, { kind: "observation", message: "probe", actorUserId: PROBE_ACTOR, at: PROBE_AT }),
  },
  regrader: {
    label: "the SLO escalation regrade (changeSeverity)",
    short: "the escalation regrade",
    step: (r, ex) =>
      ex.changeSeverity(r, { severity: "sev1", reason: "probe", actorUserId: PROBE_ACTOR, at: PROBE_AT }),
  },
});

/**
 * Runs the writers against a freshly declared record of each grade until no new status is reached,
 * collecting every status change and who made it. A writer that throws or declines causes no edge,
 * which is what the live writer would cause too.
 */
function deriveEdges(
  writers: readonly AutomatedIncidentWriter[],
  grades: readonly Severity[],
): readonly IncidentEdge[] {
  const ex = new IncidentExecutor({ clock: new FixedClock(new Date(PROBE_AT)) });
  const edges = new Map<string, { from: IncidentStatus; to: IncidentStatus; by: Set<AutomatedIncidentWriter> }>();
  for (const severity of grades) {
    const declared = ex.declare({
      id: "INC-2026-0001",
      title: "probe",
      severity,
      category: INCIDENT_CATEGORIES[0],
      declaredBy: PROBE_ACTOR,
      detail: "probe",
      declaredAt: PROBE_AT,
    });
    const reached = new Set<IncidentStatus>([declared.status]);
    const frontier: IncidentRecord[] = [declared];
    for (let record = frontier.pop(); record !== undefined; record = frontier.pop()) {
      for (const writer of writers) {
        let next: IncidentRecord | null;
        try {
          next = WRITERS[writer].step(record, ex);
        } catch {
          next = null;
        }
        if (next === null || next.status === record.status) continue;
        const key = `${record.status}>${next.status}`;
        const edge = edges.get(key) ?? { from: record.status, to: next.status, by: new Set() };
        edge.by.add(writer);
        edges.set(key, edge);
        if (!reached.has(next.status)) {
          reached.add(next.status);
          frontier.push(next);
        }
      }
    }
  }
  const rank = (s: IncidentStatus): number => INCIDENT_STATUSES.indexOf(s);
  return [...edges.values()]
    .map((e) => ({ from: e.from, to: e.to, by: AUTOMATED_INCIDENT_WRITERS.filter((w) => e.by.has(w)) }))
    .sort((a, b) => rank(a.from) - rank(b.from) || rank(a.to) - rank(b.to));
}

export function surveyIncidentLifecycle(input: IncidentLifecycleSurveyInput): IncidentLifecycleSurvey {
  const escalators = surveyEscalators(input);
  const stored = escalators.filter((e) => e.storage !== "memory");
  // The paged note writes only through the store `node.ts` builds beside a connection, which every
  // stored escalator implies; the stall note only through the deletion escalator.
  const writers: AutomatedIncidentWriter[] = [];
  if (stored.length > 0) writers.push("declarer", "paged_note");
  if (input.deletion !== null && input.deletion.declarer instanceof PostgresIncidentDeclarer) {
    writers.push("stall_note");
  }
  // The persisting SLO engines build their regrader whenever they persist; it writes only for a
  // registration that declares an `escalation`, which is what puts a grade in `escalationGrades`.
  const slo = input.slo;
  if (
    slo !== null &&
    slo.persisted &&
    slo.escalationGrades.availability.length + slo.escalationGrades.latency.length > 0
  ) {
    writers.push("regrader");
  }
  const integrity = input.integrity;
  return {
    escalators,
    integrityWithoutEscalation:
      integrity !== null && integrity.escalation === null
        ? { flag: integrity.flag, recordsVerdict: integrity.proof.recordVerdict }
        : null,
    writers,
    reachableEdges: deriveEdges(writers, sortedGrades(stored.flatMap((e) => e.grades))),
    totalEdges: INCIDENT_STATUSES.reduce((n, s) => n + INCIDENT_TRANSITIONS[s].length, 0),
    incidentRoutes: input.routes.filter(isIncidentRoute).map((r) => r.operationId),
  };
}

function integrityClause(i: NonNullable<IncidentLifecycleSurvey["integrityWithoutEscalation"]>): string {
  const what = i.recordsVerdict ? "an error line and a stored verdict row" : "an error line";
  const how =
    i.flag === "--integrity-proof"
      ? "escalation needs --integrity-proof-config with an `escalation` block, which is mutually exclusive with --integrity-proof"
      : "escalation needs an `escalation` block in that file";
  return `${i.flag} runs with no escalation, so a COMPROMISED verdict is ${what}, declares no incident and pages nobody — ${how}`;
}

/** One info-level line. */
export function formatIncidentLifecycle(s: IncidentLifecycleSurvey): string {
  const clauses: string[] = [];
  if (s.escalators.length === 0) {
    clauses.push("no incident escalator is built, so nothing in this process declares an incident");
  } else {
    const list = s.escalators
      .map((e) => `${e.name} at ${e.grades.join("/")}${STORAGE_CLAUSE[e.storage]}`)
      .join(", ");
    clauses.push(`incidents are declared by ${list}`);
  }
  if (s.integrityWithoutEscalation !== null) clauses.push(integrityClause(s.integrityWithoutEscalation));

  const anyStored = s.writers.length > 0;
  if (anyStored) {
    const edges = s.reachableEdges
      .map((e) => `${e.from}->${e.to}, by ${e.by.map((w) => WRITERS[w].short).join(" and ")}`)
      .join("; ");
    const silent = s.writers.filter((w) => !s.reachableEdges.some((e) => e.by.includes(w)));
    clauses.push(
      `the automated writers of meta.incidents are ${s.writers.map((w) => WRITERS[w].label).join(", ")}; ` +
        `they reach ${s.reachableEdges.length.toString()} of ${s.totalEdges.toString()} lifecycle edges` +
        `${edges.length > 0 ? ` (${edges})` : ""}` +
        `${silent.length > 0 ? ` and ${silent.map((w) => WRITERS[w].short).join(" and ")} ${silent.length === 1 ? "moves" : "move"} no status` : ""}`,
    );
  }
  if (s.escalators.length > 0) {
    if (s.incidentRoutes.length === 0) {
      clauses.push(
        "no HTTP route, and so no console page, can acknowledge, assign, advance, attach a postmortem to or close an incident" +
          (anyStored
            ? "; the one operator-run reader is `operate-server replay --all-tenants`, which reports drift rather than the record"
            : ""),
      );
      clauses.push(
        anyStored
          ? "an incident is cancelled, and any alert it paged resolved, only when its signal recovers; while it does not, or if that close-out fails, the record stays declared and the alert stays open at the paging provider, where it has to be resolved by hand"
          : "any alert an incident paged is resolved only when its signal recovers; while it does not, the alert stays open at the paging provider, where it has to be resolved by hand",
      );
    } else {
      clauses.push(
        `${s.incidentRoutes.length.toString()} incident route(s) are registered (${s.incidentRoutes.join(", ")}); ` +
          "the edge count above covers automated writers only and does not say what those routes reach",
      );
    }
  }
  return `[incident] ${clauses.join("; ")}`;
}
