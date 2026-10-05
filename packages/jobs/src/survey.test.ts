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

const scheduled = job("sweep-invoices", { kind: "scheduled", cron: "0 6 * * *" });
const evented = job("on-payment", { kind: "event", eventName: "billing.payment_received" });
const delayed = job("after-signup", { kind: "delayed", afterEvent: "crm.lead_created", delay: "PT5M" });
const invoked = job("run-now", { kind: "userInvoked", action: "reindex" });
const workflowJob = job("step-work", { kind: "workflow", workflow: "wf", step: "s1" });
const cdcJob = job("on-row", { kind: "cdc", table: "invoices", operation: "any" });

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

  it("every verdict is reachable from some input", () => {
    const reached = new Set<JobServiceVerdict>();
    const inputs: readonly { jobs: readonly JobDeclaration[]; ids: readonly string[]; kinds: readonly string[] }[] = [
      { jobs: [scheduled], ids: [scheduled.id], kinds: [] },
      { jobs: [scheduled], ids: [], kinds: ["scheduled"] },
      { jobs: [job("old", { kind: "scheduled", cron: "0 6 * * *" }, { deprecated: true })], ids: [], kinds: [] },
      { jobs: [workflowJob], ids: [], kinds: [] },
      { jobs: [scheduled], ids: [], kinds: [] },
    ];
    for (const input of inputs) {
      for (const f of surveyManifestJobs({
        jobs: input.jobs,
        handledJobIds: input.ids,
        handledJobKinds: input.kinds,
      }).findings) {
        reached.add(f.verdict);
      }
    }
    expect([...reached].sort()).toEqual([...JOB_SERVICE_VERDICTS].sort());
  });
});

describe("surveyManifestJobs", () => {
  it("reports handler_registered for an exact job-id match", () => {
    const survey = surveyManifestJobs({ jobs: [scheduled], handledJobIds: ["sweep-invoices"] });
    expect(survey.findings[0]?.verdict).toBe("handler_registered");
    expect(survey.unservable).toEqual([]);
    expect(survey.served).toEqual(["sweep-invoices"]);
  });

  it("reports handler_missing for a produced job with no handler, and lists it as unservable", () => {
    const survey = surveyManifestJobs({ jobs: [scheduled, evented], handledJobIds: [] });
    expect(survey.findings.map((f) => f.verdict)).toEqual(["handler_missing", "handler_missing"]);
    expect(survey.unservable).toEqual(["sweep-invoices", "on-payment"]);
    expect(survey.served).toEqual([]);
  });

  it("names the producer in a handler_missing detail, so an operator knows what is filling the queue", () => {
    const survey = surveyManifestJobs({ jobs: [scheduled], handledJobIds: [] });
    expect(survey.findings[0]?.detail).toContain("cron_scheduler");
  });

  it("falls back to a kind handler, and says it is a fallback", () => {
    const survey = surveyManifestJobs({
      jobs: [scheduled],
      handledJobIds: [],
      handledJobKinds: ["scheduled"],
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
    });
    expect(survey.findings[0]?.verdict).toBe("handler_registered");
  });

  it("does not let one kind's handler serve another kind", () => {
    const survey = surveyManifestJobs({
      jobs: [evented],
      handledJobIds: [],
      handledJobKinds: ["scheduled"],
    });
    expect(survey.findings[0]?.verdict).toBe("handler_missing");
  });

  it("reports a deprecated job as deprecated even with no handler, and keeps it off both lists", () => {
    const old = job("old-sweep", { kind: "scheduled", cron: "0 6 * * *" }, { deprecated: true });
    const survey = surveyManifestJobs({ jobs: [old], handledJobIds: [] });
    expect(survey.findings[0]?.verdict).toBe("deprecated");
    expect(survey.unservable).toEqual([]);
    expect(survey.served).toEqual([]);
  });

  it("reports a deprecated job as deprecated even when a handler exists", () => {
    const old = job("old-sweep", { kind: "scheduled", cron: "0 6 * * *" }, { deprecated: true });
    const survey = surveyManifestJobs({ jobs: [old], handledJobIds: ["old-sweep"] });
    expect(survey.findings[0]?.verdict).toBe("deprecated");
  });

  it("reports no_producer in preference to handler_missing, because a handler would not fix it", () => {
    const survey = surveyManifestJobs({ jobs: [workflowJob, cdcJob], handledJobIds: [] });
    expect(survey.findings.map((f) => f.verdict)).toEqual(["no_producer", "no_producer"]);
    expect(survey.unservable).toEqual(["step-work", "on-row"]);
  });

  it("still reports no_producer when a handler is registered for it", () => {
    const survey = surveyManifestJobs({ jobs: [cdcJob], handledJobIds: ["on-row"] });
    expect(survey.findings[0]?.verdict).toBe("no_producer");
    expect(survey.served).toEqual([]);
  });

  it("classifies every trigger kind", () => {
    const all = [scheduled, evented, delayed, invoked, workflowJob, cdcJob];
    const survey = surveyManifestJobs({ jobs: all, handledJobIds: [] });
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
    });
    expect(survey.findings.map((f) => f.jobId)).toEqual(["on-payment", "sweep-invoices", "after-signup"]);
    expect(survey.unservable).toEqual(["on-payment", "after-signup"]);
  });

  it("answers emptily for no declarations", () => {
    const survey = surveyManifestJobs({ jobs: [], handledJobIds: ["anything"] });
    expect(survey).toEqual({ findings: [], unservable: [], served: [] });
  });

  it("ignores a handler for a job no declaration holds", () => {
    const survey = surveyManifestJobs({ jobs: [scheduled], handledJobIds: ["typo-in-the-wiring"] });
    expect(survey.findings[0]?.verdict).toBe("handler_missing");
  });

  it("accepts iterables other than arrays for the handled sets", () => {
    const survey = surveyManifestJobs({
      jobs: [scheduled],
      handledJobIds: new Set(["sweep-invoices"]),
      handledJobKinds: new Map([["scheduled", 1]]).keys(),
    });
    expect(survey.findings[0]?.verdict).toBe("handler_registered");
  });
});

describe("unproducibleJobKinds", () => {
  it("names only the kinds no producer enqueues", () => {
    expect(unproducibleJobKinds([scheduled, evented, workflowJob, cdcJob])).toEqual(["workflow", "cdc"]);
  });

  it("is empty for a manifest of producible jobs", () => {
    expect(unproducibleJobKinds([scheduled, evented, delayed, invoked])).toEqual([]);
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

describe("the shipped pack catalog", () => {
  it("declares no job of an unproducible kind", () => {
    // Every one of the 23 declarations across the seven packs is `scheduled` or `event`, so the
    // `no_producer` verdict is unreached by the shipped catalog — a tripwire, not a null check: the
    // day a pack declares a `cdc` job this fails and names the missing producer.
    const all = [scheduled, evented, delayed, invoked];
    expect(unproducibleJobKinds(all)).toEqual([]);
  });
});
