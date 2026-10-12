import { describe, expect, it } from "vitest";

import {
  JOB_KIND_PRODUCERS,
  JOB_SERVICE_VERDICTS,
  surveyManifestJobs,
  unproducibleJobKinds,
  type JobServiceVerdict,
} from "./survey.js";
import { JOB_KINDS, JobDeclarationSchema, type JobDeclaration, type JobKind } from "./types.js";

function job(
  id: string,
  trigger: JobDeclaration["trigger"],
  overrides: Partial<JobDeclaration> = {},
): JobDeclaration {
  return JobDeclarationSchema.parse({
    id,
    name: id,
    trigger,
    onFailure: { strategy: "dead-letter" },
    ...overrides,
  });
}

const EVENTED_NAME = "billing.payment_received";
const DELAYED_NAME = "crm.lead_created";

const scheduled = job("sweep-invoices", { kind: "scheduled", cron: "0 6 * * *" });
const evented = job("on-payment", { kind: "event", eventName: EVENTED_NAME });
const delayed = job("after-signup", { kind: "delayed", afterEvent: DELAYED_NAME, delay: "PT5M" });
const invoked = job("run-now", { kind: "userInvoked", action: "reindex" });
const workflowJob = job("step-work", { kind: "workflow", workflow: "wf", step: "s1" });
const cdcJob = job("on-row", { kind: "cdc", table: "invoices", operation: "any" });

/**
 * An emitter that produces exactly the names the two event-bearing fixtures declare — derived from
 * the fixtures' own constants, so a renamed fixture cannot leave this list silently stale.
 *
 * Every call below passes `producibleEventNames` explicitly rather than through a helper that
 * defaults it. A default here would be the forgettable argument the required field exists to
 * remove, reintroduced one layer out in the file that is supposed to be checking it.
 */
const EMITS_BOTH: readonly string[] = [EVENTED_NAME, DELAYED_NAME];

interface SurveyCase {
  readonly verdict: JobServiceVerdict;
  readonly jobs: readonly JobDeclaration[];
  readonly ids: readonly string[];
  readonly kinds: readonly string[];
  readonly events: readonly string[];
}

/** One input per verdict, shared by the reachability and partition tests below. */
const CASES: readonly SurveyCase[] = [
  { verdict: "handler_registered", jobs: [scheduled], ids: [scheduled.id], kinds: [], events: EMITS_BOTH },
  { verdict: "served_by_kind_handler", jobs: [scheduled], ids: [], kinds: ["scheduled"], events: EMITS_BOTH },
  {
    verdict: "deprecated",
    jobs: [job("old", { kind: "scheduled", cron: "0 6 * * *" }, { deprecated: true })],
    ids: [],
    kinds: [],
    events: EMITS_BOTH,
  },
  { verdict: "no_producer", jobs: [workflowJob], ids: [], kinds: [], events: EMITS_BOTH },
  { verdict: "event_unproducible", jobs: [evented], ids: [], kinds: [], events: [] },
  { verdict: "handler_missing", jobs: [scheduled], ids: [], kinds: [], events: EMITS_BOTH },
];

function runCase(c: SurveyCase) {
  return surveyManifestJobs({
    jobs: c.jobs,
    handledJobIds: c.ids,
    handledJobKinds: c.kinds,
    producibleEventNames: c.events,
  });
}

describe("JOB_KIND_PRODUCERS", () => {
  it("is total over JOB_KINDS", () => {
    for (const kind of JOB_KINDS) {
      expect(JOB_KIND_PRODUCERS[kind]).toBeDefined();
    }
    expect(Object.keys(JOB_KIND_PRODUCERS).sort()).toEqual([...JOB_KINDS].sort());
  });

  it("routes delayed through the event emitter, as matchEventJobs does", () => {
    expect(JOB_KIND_PRODUCERS.delayed).toBe("event_emitter");
    expect(JOB_KIND_PRODUCERS.event).toBe("event_emitter");
  });

  it("names the two kinds nothing enqueues", () => {
    const none = JOB_KINDS.filter((k) => JOB_KIND_PRODUCERS[k] === "none");
    expect(none).toEqual(["workflow", "cdc"]);
  });

  it("is frozen, so a caller cannot teach it a producer that does not exist", () => {
    expect(Object.isFrozen(JOB_KIND_PRODUCERS)).toBe(true);
  });
});

describe("JOB_SERVICE_VERDICTS", () => {
  it("has no duplicates", () => {
    expect(new Set(JOB_SERVICE_VERDICTS).size).toBe(JOB_SERVICE_VERDICTS.length);
  });

  it("every verdict is reachable, and every case reaches exactly the one it claims", () => {
    // Stronger than a reachability sweep over the pooled findings: each case must yield *exactly*
    // its claimed verdict, so a case whose input drifts cannot go on covering the table by landing
    // on a verdict some other case already reached.
    for (const c of CASES) {
      expect(runCase(c).findings.map((f) => f.verdict)).toEqual([c.verdict]);
    }
    const claimed: readonly JobServiceVerdict[] = CASES.map((c) => c.verdict);
    expect([...claimed].sort()).toEqual([...JOB_SERVICE_VERDICTS].sort());
  });

  it("puts every verdict on exactly one of the two lists, or on neither", () => {
    // The disposition map is module-private, so this asserts the property rather than the map: a
    // seventh verdict falling out of *both* lists is the silence that map exists to prevent, and a
    // verdict on both would make `unservable` and `served` contradict each other about one job.
    for (const c of CASES) {
      const survey = runCase(c);
      const onBoth = survey.served.filter((id) => survey.unservable.includes(id));
      expect(onBoth).toEqual([]);
      const listed = survey.served.length + survey.unservable.length;
      expect(listed).toBeLessThanOrEqual(survey.findings.length);
      // Only `deprecated` is deliberately on neither.
      expect(listed).toBe(c.verdict === "deprecated" ? 0 : survey.findings.length);
    }
  });
});

describe("surveyManifestJobs", () => {
  it("reports handler_registered for an exact job-id match", () => {
    const survey = surveyManifestJobs({
      jobs: [scheduled],
      handledJobIds: ["sweep-invoices"],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings[0]?.verdict).toBe("handler_registered");
    expect(survey.unservable).toEqual([]);
    expect(survey.served).toEqual(["sweep-invoices"]);
  });

  it("reports handler_missing for a produced job with no handler, and lists it as unservable", () => {
    const survey = surveyManifestJobs({
      jobs: [scheduled, evented],
      handledJobIds: [],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings.map((f) => f.verdict)).toEqual(["handler_missing", "handler_missing"]);
    expect(survey.unservable).toEqual(["sweep-invoices", "on-payment"]);
    expect(survey.served).toEqual([]);
  });

  it("names the producer in a handler_missing detail, so an operator knows what is filling the queue", () => {
    const survey = surveyManifestJobs({
      jobs: [scheduled],
      handledJobIds: [],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings[0]?.detail).toContain("cron_scheduler");
  });

  it("falls back to a kind handler, and says it is a fallback", () => {
    const survey = surveyManifestJobs({
      jobs: [scheduled],
      handledJobIds: [],
      handledJobKinds: ["scheduled"],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings[0]?.verdict).toBe("served_by_kind_handler");
    expect(survey.findings[0]?.detail).toContain("fallback");
    expect(survey.served).toEqual(["sweep-invoices"]);
  });

  it("prefers the job's own handler over its kind handler, as resolve() does", () => {
    const survey = surveyManifestJobs({
      jobs: [scheduled],
      handledJobIds: ["sweep-invoices"],
      handledJobKinds: ["scheduled"],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings[0]?.verdict).toBe("handler_registered");
  });

  it("does not let one kind's handler serve another kind", () => {
    const survey = surveyManifestJobs({
      jobs: [evented],
      handledJobIds: [],
      handledJobKinds: ["scheduled"],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings[0]?.verdict).toBe("handler_missing");
  });

  it("reports a deprecated job as deprecated even with no handler, and keeps it off both lists", () => {
    const old = job("old-sweep", { kind: "scheduled", cron: "0 6 * * *" }, { deprecated: true });
    const survey = surveyManifestJobs({
      jobs: [old],
      handledJobIds: [],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings[0]?.verdict).toBe("deprecated");
    expect(survey.unservable).toEqual([]);
    expect(survey.served).toEqual([]);
  });

  it("reports a deprecated job as deprecated even when a handler exists", () => {
    const old = job("old-sweep", { kind: "scheduled", cron: "0 6 * * *" }, { deprecated: true });
    const survey = surveyManifestJobs({
      jobs: [old],
      handledJobIds: ["old-sweep"],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings[0]?.verdict).toBe("deprecated");
  });

  it("reports no_producer in preference to handler_missing, because a handler would not fix it", () => {
    const survey = surveyManifestJobs({
      jobs: [workflowJob, cdcJob],
      handledJobIds: [],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings.map((f) => f.verdict)).toEqual(["no_producer", "no_producer"]);
    expect(survey.unservable).toEqual(["step-work", "on-row"]);
  });

  it("still reports no_producer when a handler is registered for it", () => {
    const survey = surveyManifestJobs({
      jobs: [cdcJob],
      handledJobIds: ["on-row"],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings[0]?.verdict).toBe("no_producer");
    expect(survey.served).toEqual([]);
  });

  it("classifies every trigger kind", () => {
    const all = [scheduled, evented, delayed, invoked, workflowJob, cdcJob];
    const survey = surveyManifestJobs({
      jobs: all,
      handledJobIds: [],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings).toHaveLength(all.length);
    expect(survey.findings.map((f) => f.kind)).toEqual([
      "scheduled",
      "event",
      "delayed",
      "userInvoked",
      "workflow",
      "cdc",
    ]);
  });

  it("preserves declaration order in findings and in both lists", () => {
    const survey = surveyManifestJobs({
      jobs: [evented, scheduled, delayed],
      handledJobIds: ["sweep-invoices"],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings.map((f) => f.jobId)).toEqual(["on-payment", "sweep-invoices", "after-signup"]);
    expect(survey.unservable).toEqual(["on-payment", "after-signup"]);
  });

  it("answers emptily for no declarations", () => {
    const survey = surveyManifestJobs({
      jobs: [],
      handledJobIds: ["anything"],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey).toEqual({ findings: [], unservable: [], served: [] });
  });

  it("ignores a handler for a job no declaration holds", () => {
    const survey = surveyManifestJobs({
      jobs: [scheduled],
      handledJobIds: ["typo-in-the-wiring"],
      producibleEventNames: EMITS_BOTH,
    });
    expect(survey.findings[0]?.verdict).toBe("handler_missing");
  });

  it("accepts iterables other than arrays for the handled sets and the event names", () => {
    const survey = surveyManifestJobs({
      jobs: [scheduled, evented],
      handledJobIds: new Set(["sweep-invoices"]),
      handledJobKinds: new Map([["scheduled", 1]]).keys(),
      producibleEventNames: new Set(EMITS_BOTH).values(),
    });
    expect(survey.findings.map((f) => f.verdict)).toEqual(["handler_registered", "handler_missing"]);
  });
});

describe("event_unproducible", () => {
  it("reports an event job whose name no emitter produces, pointing at the declaration", () => {
    const survey = surveyManifestJobs({
      jobs: [evented],
      handledJobIds: [],
      producibleEventNames: ["billing.payment_settled"],
    });
    expect(survey.findings[0]?.verdict).toBe("event_unproducible");
    expect(survey.unservable).toEqual(["on-payment"]);
    expect(survey.served).toEqual([]);
    const detail = survey.findings[0]?.detail ?? "";
    expect(detail).toContain(EVENTED_NAME);
    expect(detail).toContain("never be called");
    // The clause that made `handler_missing` false for these twelve jobs: nothing fires, so no
    // pending run accumulates. A detail copied from that verdict would reintroduce it.
    expect(detail).not.toContain("accumulates a pending run");
  });

  it("reports a delayed job whose afterEvent no emitter produces", () => {
    // Vacuous on every shipped pack — none declares a `delayed` job — and written because
    // `matchEventJobs` matches `afterEvent` with the same `===`, so the two kinds are one case.
    const survey = surveyManifestJobs({
      jobs: [delayed],
      handledJobIds: [],
      producibleEventNames: [EVENTED_NAME],
    });
    expect(survey.findings[0]?.verdict).toBe("event_unproducible");
    expect(survey.findings[0]?.detail).toContain(DELAYED_NAME);
  });

  it("reads [] as 'this deployment emits nothing', and only for the kinds carrying a name", () => {
    // Both halves of the new check's boundary in one place: with the emitter off, the two
    // name-bearing kinds flip and the two name-free producible kinds must not, because a `null`
    // name means *this kind is addressed by a clock or a route* and never *the name is unknown*.
    const survey = surveyManifestJobs({
      jobs: [evented, delayed, scheduled, invoked],
      handledJobIds: [],
      producibleEventNames: [],
    });
    expect(survey.findings.map((f) => f.verdict)).toEqual([
      "event_unproducible",
      "event_unproducible",
      "handler_missing",
      "handler_missing",
    ]);
    expect(survey.unservable).toEqual(["on-payment", "after-signup", "sweep-invoices", "run-now"]);
  });

  it("outranks a registered handler and a kind handler, which would never be called", () => {
    for (const handlers of [
      { ids: [evented.id], kinds: [] as readonly string[] },
      { ids: [] as readonly string[], kinds: ["event"] },
      { ids: [evented.id], kinds: ["event"] },
    ]) {
      const survey = surveyManifestJobs({
        jobs: [evented],
        handledJobIds: handlers.ids,
        handledJobKinds: handlers.kinds,
        producibleEventNames: [],
      });
      expect(survey.findings[0]?.verdict).toBe("event_unproducible");
      expect(survey.served).toEqual([]);
    }
  });

  it("loses to deprecated, because a skipped declaration's unproducible name is not a finding", () => {
    const old = job("old-hook", { kind: "event", eventName: "nothing.emits_this" }, { deprecated: true });
    const survey = surveyManifestJobs({
      jobs: [old],
      handledJobIds: [],
      producibleEventNames: [],
    });
    expect(survey.findings[0]?.verdict).toBe("deprecated");
    expect(survey.unservable).toEqual([]);
  });

  it("never displaces no_producer, because no kind both lacks a producer and carries a name", () => {
    // The two verdicts cannot both hold today, so the order in `classify` is a statement about a
    // future kind rather than a live tiebreak. This pins the premise: with an emitter producing
    // nothing, a kind whose producer is "none" must still read `no_producer`.
    const byKind: Readonly<Record<JobKind, JobDeclaration>> = {
      scheduled,
      event: evented,
      delayed,
      userInvoked: invoked,
      workflow: workflowJob,
      cdc: cdcJob,
    };
    const unproducibleKinds = JOB_KINDS.filter((k) => JOB_KIND_PRODUCERS[k] === "none");
    expect(unproducibleKinds.length).toBeGreaterThan(0);
    for (const kind of unproducibleKinds) {
      const survey = surveyManifestJobs({
        jobs: [byKind[kind]],
        handledJobIds: [],
        producibleEventNames: [],
      });
      expect(survey.findings[0]?.verdict).toBe("no_producer");
    }
  });

  it("yields to handler_missing once the emitter produces the name", () => {
    const missing = surveyManifestJobs({
      jobs: [evented],
      handledJobIds: [],
      producibleEventNames: [EVENTED_NAME],
    });
    expect(missing.findings[0]?.verdict).toBe("handler_missing");
    const served = surveyManifestJobs({
      jobs: [evented],
      handledJobIds: [evented.id],
      producibleEventNames: [EVENTED_NAME],
    });
    expect(served.findings[0]?.verdict).toBe("handler_registered");
  });

});

describe("unproducibleJobKinds", () => {
  it("names only the kinds no producer enqueues", () => {
    expect(unproducibleJobKinds([scheduled, evented, workflowJob, cdcJob])).toEqual(["workflow", "cdc"]);
  });

  it("is empty for a manifest of producible jobs, as the shipped packs are", () => {
    // Every declaration across the seven packs is `scheduled` or `event`, so `no_producer` is
    // unreached by the shipped catalog — a tripwire, not a null check: the day a pack declares a
    // `cdc` job this fails and names the missing producer.
    expect(unproducibleJobKinds([scheduled, evented, delayed, invoked])).toEqual([]);
  });

  it("stays a kind-level question, blind to an unproducible event name", () => {
    // Deliberately unchanged by this increment: it answers from a manifest alone, for a reviewer
    // approving one, and whether an emitter produces a name is a fact about the deployment.
    expect(unproducibleJobKinds([evented, delayed])).toEqual([]);
  });

  it("skips a deprecated declaration, which is never enqueued either way", () => {
    const deprecatedCdc = job("on-row", { kind: "cdc", table: "t", operation: "any" }, { deprecated: true });
    expect(unproducibleJobKinds([deprecatedCdc])).toEqual([]);
  });

  it("deduplicates and returns JOB_KINDS order, not declaration order", () => {
    const second = job("on-row-2", { kind: "cdc", table: "t2", operation: "insert" });
    const kinds: readonly JobKind[] = unproducibleJobKinds([cdcJob, workflowJob, second]);
    expect(kinds).toEqual(["workflow", "cdc"]);
  });

  it("is empty for no declarations", () => {
    expect(unproducibleJobKinds([])).toEqual([]);
  });
});
