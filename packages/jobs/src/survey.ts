import { JOB_KINDS, type JobDeclaration, type JobKind, type JobTrigger } from "./types.js";

/**
 * Which producer in a deployment turns a declaration of each kind into a `pending` run.
 *
 * A **total** map over `JOB_KINDS` rather than an `if`-chain, so a seventh kind added to
 * `JobTriggerSchema` is a compile error here instead of a declaration that silently reads as
 * unproducible — ADR-0330's rule for the design-output shapes and ADR-0329's for the cancellation
 * effects, which is the same mistake in a third enum.
 *
 * `"none"` is not a gap in this map; it is the answer. Nothing enqueues a `workflow`- or
 * `cdc`-triggered job: the workflow engine schedules *activities*, not job runs, and no CDC pipeline
 * exists. So registering a handler for one would not make it run, which is why
 * `surveyManifestJobs` reports `no_producer` in preference to `handler_missing` — naming the fix
 * that would not work is worse than naming none.
 *
 * What this map **cannot** answer is the question its key is one coarsening away from: the key is a
 * trigger *kind* and an event job is addressed by its *name*, so `event_emitter` here means "a
 * producer for this kind exists in the deployment" and never "that producer can emit this
 * declaration". A declaration whose name no emitter produces therefore read `handler_missing` —
 * the rule above, broken by granularity, in the one survey written to uphold it. The name-level
 * answer is `event_unproducible`, and it needs an input this map has no room for.
 */
export const JOB_KIND_PRODUCERS: Readonly<
  Record<JobKind, "event_emitter" | "cron_scheduler" | "invoke_route" | "none">
> = Object.freeze({
  event: "event_emitter",
  /** Matched by `matchEventJobs` too — a `delayed` trigger fires off an event, after its delay. */
  delayed: "event_emitter",
  scheduled: "cron_scheduler",
  userInvoked: "invoke_route",
  workflow: "none",
  cdc: "none",
});

export const JOB_SERVICE_VERDICTS = [
  /** A handler is registered for this job's own id. The one verdict that means "this job runs". */
  "handler_registered",
  /**
   * No handler names this job, but one is registered for its *kind*, which `JobHandlerRegistry`
   * resolves as a fallback. Named separately rather than folded into `handler_registered` because a
   * kind handler serves every job of that kind — including ones nobody considered when writing it —
   * so "this job runs" and "this job runs through a catch-all" are different facts to an operator.
   */
  "served_by_kind_handler",
  /**
   * The declaration is `deprecated`. All three producers skip it (`matchEventJobs`,
   * `matchUserInvokedJobs`, `scheduledJobsDue`), so it is not enqueued and needs no handler. Not a
   * finding — reported so a deployment is not left wondering why it is absent from both lists.
   */
  "deprecated",
  /**
   * Nothing in this deployment enqueues this trigger kind, so the job never becomes a run at all.
   * Registering a handler would change nothing.
   */
  "no_producer",
  /**
   * A producer for this *kind* exists and cannot emit this declaration's *name*, so the job never
   * becomes a run — `matchEventJobs` compares the name with `===`, and no event this deployment
   * emits is equal to it.
   *
   * Its own verdict and not a shade of `handler_missing`, because the remedy is the opposite one:
   * `handler_missing` is answered by registering a handler, and here a registered handler would
   * never be called, so the fix is the declaration's event name (or an emitter that produces it).
   * That is `no_producer`'s rule read at name granularity — naming the fix that would not work is
   * worse than naming none.
   */
  "event_unproducible",
  /**
   * A producer enqueues this job and no handler serves it. **This job will never run**, and every
   * tick/event accumulates a durable `pending` row. Reported rather than skipped: a skipped job is
   * one nothing would say anything about, which is exactly how 23 declared jobs went unexecuted
   * through every release.
   */
  "handler_missing",
] as const;
export type JobServiceVerdict = (typeof JOB_SERVICE_VERDICTS)[number];

export interface ManifestJobFinding {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly verdict: JobServiceVerdict;
  readonly detail: string;
}

/**
 * Which of the survey's two lists each verdict lands on, or neither.
 *
 * A total map over `JOB_SERVICE_VERDICTS` rather than the two `||` chains it replaces, because those
 * chains were a hand-maintained list of the verdicts that mean "will never run" — ADR-0288's shape,
 * and the one place a new verdict falling out of *both* lists would be silent. A seventh verdict is
 * a compile error here, which is where it has to be decided.
 */
const VERDICT_DISPOSITION: Readonly<
  Record<JobServiceVerdict, "served" | "unservable" | "as_declared">
> = Object.freeze({
  handler_registered: "served",
  served_by_kind_handler: "served",
  /** Not running is what the declaration asked for, so it belongs on neither list. */
  deprecated: "as_declared",
  no_producer: "unservable",
  event_unproducible: "unservable",
  handler_missing: "unservable",
});

export interface ManifestJobSurvey {
  readonly findings: readonly ManifestJobFinding[];
  /**
   * The job ids that will never run, in declaration order — every verdict `VERDICT_DISPOSITION`
   * calls `unservable`. The one list a caller has to act on; a `deprecated` job is excluded because
   * not running is what was asked for.
   */
  readonly unservable: readonly string[];
  /** Job ids with a handler of their own or via their kind: what this deployment actually executes. */
  readonly served: readonly string[];
}

export interface SurveyManifestJobsInput {
  readonly jobs: readonly JobDeclaration[];
  /** Job ids a handler is registered for, exactly as `JobHandlerRegistry.register` was called. */
  readonly handledJobIds: Iterable<string>;
  /** Trigger kinds a catch-all handler is registered for (`registerForKind`). */
  readonly handledJobKinds?: Iterable<string>;
  /**
   * Every event name this deployment can emit, as the emitter spells it — the names
   * `matchEventJobs` will compare an `event` trigger's `eventName` and a `delayed` trigger's
   * `afterEvent` against.
   *
   * **Required, with no default.** `[]` is the claim *this deployment emits no entity events*,
   * which is literally true whenever the emitter is switched off, and it is a different fact from
   * *nobody gathered the names*. A default could only be "assume producible", which is the wrong
   * answer this field exists to retire, kept as the value every caller who forgets the argument
   * gets — ADR-0334's `probeJobQueueVisibility` precedent, where a scope-shaped parameter with a
   * default let a caller go on not naming one.
   */
  readonly producibleEventNames: Iterable<string>;
}

/**
 * Classifies a manifest's job declarations against the handlers that actually exist.
 *
 * The job counterpart of `surveyManifestWorkflows`, and it exists for the same reason: the answer to
 * "where does the behaviour behind a declaration come from" is *not* the manifest, and that answer
 * has a cost. A `JobDeclaration` carries an id, a trigger, a retry policy, data classes and a prose
 * `description` — and no field of any kind that describes what the job *does*. So the behaviour is
 * registered by the deployment, keyed on the job's id, and a declaration whose id nothing registers
 * is a job that will never run.
 *
 * A handler is only half the question, and the half that was asked. The other half is whether
 * anything can *address* the declaration: an event job is reached by name, so a name no emitter
 * produces is a job that never becomes a run however many handlers name its id. Hence
 * `producibleEventNames`, and `event_unproducible` beside `no_producer`.
 *
 * The rule is ADR-0331's, unchanged: **a job that will never run is named with the reason, never
 * passed over.** Pure — the caller decides whether that is a log line, a boot refusal or a route.
 */
export function surveyManifestJobs(input: SurveyManifestJobsInput): ManifestJobSurvey {
  const handledIds = new Set(input.handledJobIds);
  const handledKinds = new Set(input.handledJobKinds ?? []);
  const producibleEvents = new Set(input.producibleEventNames);
  const findings = input.jobs.map((job) =>
    classify(job, handledIds, handledKinds, producibleEvents),
  );
  const idsWhere = (disposition: "served" | "unservable"): readonly string[] =>
    findings.filter((f) => VERDICT_DISPOSITION[f.verdict] === disposition).map((f) => f.jobId);
  return { findings, unservable: idsWhere("unservable"), served: idsWhere("served") };
}

/**
 * The event name a trigger is addressed by, or `null` for a kind that is not addressed by one.
 *
 * A `switch` over the discriminated union rather than a total map from `JobKind`, because the field
 * holding the name differs per member (`eventName` / `afterEvent`) and a map keyed on the kind
 * could only reach it through a cast — which would assert the very correspondence the compiler is
 * here to check. With an explicit return type that excludes `undefined`, a seventh union member is
 * a compile error at the missing `case`, so this is exhaustive in the same way a total map is.
 *
 * `null` is "this kind carries no event name", never "the name is unknown": the two kinds that
 * return it with a producer (`scheduled`, `userInvoked`) are addressed by a clock and a route, so
 * there is no name for an emitter to fail to produce.
 */
function triggerEventName(trigger: JobTrigger): string | null {
  switch (trigger.kind) {
    case "event":
      return trigger.eventName;
    case "delayed":
      return trigger.afterEvent;
    case "scheduled":
    case "userInvoked":
    case "workflow":
    case "cdc":
      return null;
  }
}

/**
 * The order of these five questions is the decision.
 *
 * `deprecated` first, because it is a statement about the declaration and settles all of the
 * others: a deprecated job is skipped by every producer, so neither its producer, nor whether an
 * emitter could address it, nor its handler matters — an unproducible name on a job that was never
 * going to be enqueued is not a finding.
 *
 * `no_producer` before `event_unproducible`, because it is the **stronger** statement: nothing
 * enqueues this kind at all, where `event_unproducible` says only that this one declaration is
 * unaddressable. The two cannot both hold today — `JOB_KIND_PRODUCERS` answers `event_emitter` for
 * both name-bearing kinds — so the order is not covering an overlap, it is fixing which answer a
 * future kind gets: a name-bearing kind whose producer is removed must read `no_producer`, the
 * verdict whose remedy is the deployment, not `event_unproducible`, whose remedy is the name.
 *
 * Both before the handler checks, and `event_unproducible` before `handler_registered` as well as
 * before `handler_missing`: a job nothing can address does not run because a handler exists, so
 * reporting it as served would be the reassuring half of the truth. That is `no_producer`'s own
 * precedence over a registered handler, at name granularity.
 *
 * Own-id before kind, because that is the order `JobHandlerRegistry.resolve` searches.
 */
function classify(
  job: JobDeclaration,
  handledIds: ReadonlySet<string>,
  handledKinds: ReadonlySet<string>,
  producibleEvents: ReadonlySet<string>,
): ManifestJobFinding {
  const kind = job.trigger.kind;
  if (job.deprecated === true) {
    return {
      jobId: job.id,
      kind,
      verdict: "deprecated",
      detail: `'${job.id}' is deprecated, so no producer enqueues it and no handler is needed`,
    };
  }
  if (JOB_KIND_PRODUCERS[kind] === "none") {
    return {
      jobId: job.id,
      kind,
      verdict: "no_producer",
      detail:
        `nothing enqueues a '${kind}'-triggered job, so '${job.id}' never becomes a run. ` +
        "Registering a handler would not change that",
    };
  }
  const eventName = triggerEventName(job.trigger);
  if (eventName !== null && !producibleEvents.has(eventName)) {
    return {
      jobId: job.id,
      kind,
      verdict: "event_unproducible",
      detail:
        `'${job.id}' is triggered by the event '${eventName}', which nothing in this deployment ` +
        "emits — so it never becomes a run, and no pending row accumulates either. The remedy is " +
        "the declaration's event name, or an emitter that produces it; a handler registered for " +
        "this job would never be called",
    };
  }
  if (handledIds.has(job.id)) {
    return {
      jobId: job.id,
      kind,
      verdict: "handler_registered",
      detail: `a handler is registered for '${job.id}'`,
    };
  }
  if (handledKinds.has(kind)) {
    return {
      jobId: job.id,
      kind,
      verdict: "served_by_kind_handler",
      detail:
        `no handler names '${job.id}', but one is registered for every '${kind}' job and will ` +
        "serve it as a fallback",
    };
  }
  return {
    jobId: job.id,
    kind,
    verdict: "handler_missing",
    detail:
      `no handler is registered for '${job.id}', and ${JOB_KIND_PRODUCERS[kind]} enqueues it — so ` +
      "every fire accumulates a pending run nothing can execute. A JobDeclaration carries no " +
      "executable content (its only description of the work is prose), so the behaviour has to be " +
      "registered by the deployment before this job can run",
  };
}

/**
 * Every kind some declaration uses that no producer enqueues — the deployment-independent half of
 * the survey, answerable from a manifest alone with no registry in hand.
 *
 * Separate from `surveyManifestJobs` because it is the one finding a *reviewer* can act on while
 * approving a manifest: a job of an unproducible kind is a declaration that could never run in any
 * deployment, which is a defect in the manifest rather than in the wiring.
 */
export function unproducibleJobKinds(jobs: readonly JobDeclaration[]): readonly JobKind[] {
  const seen = new Set<JobKind>();
  for (const job of jobs) {
    if (job.deprecated === true) continue;
    if (JOB_KIND_PRODUCERS[job.trigger.kind] === "none") seen.add(job.trigger.kind);
  }
  return JOB_KINDS.filter((k) => seen.has(k));
}
