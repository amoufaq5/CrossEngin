import { JOB_KINDS, type JobDeclaration, type JobKind } from "./types.js";

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

export interface ManifestJobSurvey {
  readonly findings: readonly ManifestJobFinding[];
  /**
   * The job ids that will never run, in declaration order: `handler_missing` and `no_producer`.
   * The one list a caller has to act on — a `deprecated` job is excluded because not running is
   * what was asked for.
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
 * The rule is ADR-0331's, unchanged: **a job that will never run is named with the reason, never
 * passed over.** Pure — the caller decides whether that is a log line, a boot refusal or a route.
 */
export function surveyManifestJobs(input: SurveyManifestJobsInput): ManifestJobSurvey {
  const handledIds = new Set(input.handledJobIds);
  const handledKinds = new Set(input.handledJobKinds ?? []);
  const findings = input.jobs.map((job) => classify(job, handledIds, handledKinds));
  return {
    findings,
    unservable: findings
      .filter((f) => f.verdict === "handler_missing" || f.verdict === "no_producer")
      .map((f) => f.jobId),
    served: findings
      .filter((f) => f.verdict === "handler_registered" || f.verdict === "served_by_kind_handler")
      .map((f) => f.jobId),
  };
}

/**
 * The order of these four questions is the decision.
 *
 * `deprecated` first, because it is a statement about the declaration and settles both of the
 * others: a deprecated job is not enqueued, so neither its producer nor its handler matters.
 * `no_producer` before the handler checks, because a kind nothing enqueues cannot be fixed by
 * registering a handler, and a `handler_missing` verdict would send an operator to the wrong place.
 * Own-id before kind, because that is the order `JobHandlerRegistry.resolve` searches.
 */
function classify(
  job: JobDeclaration,
  handledIds: ReadonlySet<string>,
  handledKinds: ReadonlySet<string>,
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
