import {
  surveyManifestJobs,
  type JobDeclaration,
  type JobKind,
  type ManifestJobSurvey,
} from "@crossengin/jobs";

import {
  JobHandlerRegistry,
  type JobHandler,
  type JobHandlerRegistration,
} from "./job-engine.js";

/**
 * Why a handler provider set was refused at build time.
 *
 * Every one of these is a wiring mistake whose silent form is a job that never runs with nothing
 * said about it — which is the defect this module exists to end, so they refuse rather than report.
 * A boot that fails naming the typo is strictly better than a boot that succeeds and quietly
 * executes nothing.
 */
export const JOB_HANDLER_BUILD_REFUSALS = [
  /** A provider names a job id no declaration in this manifest holds — a typo, or a stale wiring. */
  "undeclared_job",
  /** Two providers resolve to one job id, so one of them would be silently discarded. */
  "duplicate_provider",
  /** A kind provider covers no declaration, so it is dead code that reads as coverage. */
  "kind_serves_nothing",
  /**
   * A provider carries its own retry configuration. Refused because the declaration already carries
   * one: two sources for one promise is ADR-0331's `delivery_guarantee` defect, and the table the
   * attempt ceiling is read back from must not disagree with the manifest a reviewer approved.
   */
  "provider_overrides_declared_retry",
] as const;
export type JobHandlerBuildRefusal = (typeof JOB_HANDLER_BUILD_REFUSALS)[number];

export class JobHandlerBuildError extends Error {
  constructor(
    readonly code: JobHandlerBuildRefusal,
    message: string,
  ) {
    super(message);
    this.name = "JobHandlerBuildError";
  }
}

/**
 * One unit of behaviour the **deployment** supplies for a declared job.
 *
 * A discriminated union rather than two optional fields, so "serves this job" and "serves every job
 * of this kind" cannot both be given or both be omitted.
 *
 * There is deliberately no `retry` / `maxAttempts` here: see `provider_overrides_declared_retry`.
 */
export type JobHandlerProvider =
  | {
      readonly serves: "job";
      readonly jobId: string;
      readonly handler: JobHandler;
      /** Reserved so a mistaken retry override is a *typed* refusal rather than silently dropped. */
      readonly retry?: never;
      readonly maxAttempts?: never;
    }
  | {
      readonly serves: "kind";
      readonly jobKind: JobKind;
      readonly handler: JobHandler;
      readonly retry?: never;
      readonly maxAttempts?: never;
    };

export interface BuildJobHandlerRegistryInput {
  /** The resolved manifest's job declarations — the only place a retry policy legitimately lives. */
  readonly jobs: readonly JobDeclaration[];
  /** What this deployment knows how to run. Empty is a valid answer, and the survey says so. */
  readonly providers: readonly JobHandlerProvider[];
  /**
   * The `[0,1)` sampler backing a declared `retry.backoff.jitter`. Injected for determinism in
   * tests; `Math.random` by default, because `retryDelayMs` skips jitter entirely when no sampler is
   * supplied — so every deployment up to now declared `jitter: true` on all of its jobs and got
   * none.
   */
  readonly jitterRng?: () => number;
}

export interface JobHandlerRegistryBuild {
  readonly registry: JobHandlerRegistry;
  readonly survey: ManifestJobSurvey;
  /**
   * The job ids a worker in this process may claim: exactly the declarations that have both a
   * handler and a producer. Handed to `claimDueJobs`' `serves` filter so an unserved run is never
   * claimed at all, rather than claimed and finalized `failed` with `handler_not_found`.
   */
  readonly servedJobIds: readonly string[];
}

/**
 * Builds the job handler registry from the deployment's providers and the manifest's declarations.
 *
 * **A job handler is a deployment concern, not a manifest one.** `JobDeclaration` carries an id, a
 * trigger, a retry policy, concurrency, data classes and a prose `description` — and no field of any
 * kind that describes the work. Not even the `z.unknown()` slot an orchestration `Workflow` has. So
 * there is nothing in a manifest to compile: the behaviour is registered here, against the id, by
 * the process that holds the credentials and the code.
 *
 * What the manifest *does* own is everything about **how the run is governed** — the attempt
 * ceiling, the backoff, the data classes, the failure strategy. Those are read off the declaration
 * and a provider may not restate them, so the policy a reviewer approved is the policy the queue
 * enforces.
 *
 * A `kind` provider is **expanded into one registration per matching declaration** rather than
 * registered through `JobHandlerRegistry.registerForKind`. That is the load-bearing implementation
 * choice: a kind registration carries one retry policy for every job of that kind, and the twelve
 * `scheduled` jobs in `pack-erp-core` do not share one. Expanding keeps every registration's
 * ceiling its own declaration's. It also leaves the registry's kind map empty on purpose — the kind
 * fallback would otherwise serve a run whose `job_id` is no longer declared at all, which is the one
 * case where nothing is known about the work.
 */
export function buildJobHandlerRegistry(
  input: BuildJobHandlerRegistryInput,
): JobHandlerRegistryBuild {
  const byId = new Map<string, JobDeclaration>();
  for (const job of input.jobs) byId.set(job.id, job);

  // Resolved id → handler. A `job` provider wins over a `kind` expansion covering the same id,
  // which is the precedence `JobHandlerRegistry.resolve` already documents; two providers of the
  // *same* precedence are a refusal, because picking one silently is how a deployment ends up
  // running behaviour it did not wire.
  const fromJob = new Map<string, JobHandler>();
  const fromKind = new Map<string, JobHandler>();
  const kindsSeen = new Set<JobKind>();

  for (const provider of input.providers) {
    if (provider.retry !== undefined || provider.maxAttempts !== undefined) {
      throw new JobHandlerBuildError(
        "provider_overrides_declared_retry",
        `a handler provider carries its own retry configuration; the retry policy comes from the ` +
          `JobDeclaration so the queue cannot disagree with the approved manifest`,
      );
    }
    if (provider.serves === "job") {
      if (!byId.has(provider.jobId)) {
        throw new JobHandlerBuildError(
          "undeclared_job",
          `handler provider serves '${provider.jobId}', which no job declaration holds. Declared: ` +
            `${[...byId.keys()].join(", ") || "(none)"}`,
        );
      }
      if (fromJob.has(provider.jobId)) {
        throw new JobHandlerBuildError(
          "duplicate_provider",
          `two handler providers serve job '${provider.jobId}'`,
        );
      }
      fromJob.set(provider.jobId, provider.handler);
      continue;
    }
    if (kindsSeen.has(provider.jobKind)) {
      throw new JobHandlerBuildError(
        "duplicate_provider",
        `two handler providers serve every '${provider.jobKind}' job`,
      );
    }
    kindsSeen.add(provider.jobKind);
    // A deprecated declaration is deliberately *not* covered: no producer enqueues it, so a
    // registration for it is dead, and counting it would make the kind provider look broader than
    // it is.
    const covered = input.jobs.filter(
      (j) => j.trigger.kind === provider.jobKind && j.deprecated !== true,
    );
    if (covered.length === 0) {
      throw new JobHandlerBuildError(
        "kind_serves_nothing",
        `handler provider serves every '${provider.jobKind}' job and no declaration has that ` +
          `trigger kind, so it would never be called`,
      );
    }
    for (const job of covered) fromKind.set(job.id, provider.handler);
  }

  const registry = new JobHandlerRegistry();
  const jitterRng = input.jitterRng ?? Math.random;
  const handled: string[] = [];
  for (const [jobId, declaration] of byId) {
    const handler = fromJob.get(jobId) ?? fromKind.get(jobId);
    if (handler === undefined) continue;
    registry.register(jobId, registrationFor(declaration, handler, jitterRng));
    handled.push(jobId);
  }

  const survey = surveyManifestJobs({ jobs: input.jobs, handledJobIds: handled });
  return { registry, survey, servedJobIds: survey.served };
}

/**
 * The registration for one declaration: its handler plus the governance the manifest declared.
 *
 * `maxAttempts` is only set when the declaration has no `retry` policy, because
 * `JobHandlerRegistration` prefers `retry.maxAttempts` and setting both would be two spellings of
 * one ceiling. A declaration with no policy at all gets 1 — the engine's own default, restated here
 * so the absence is visible rather than inherited silently.
 *
 * A `jitterRng` is attached **only** when the declared backoff asks for jitter: `retryDelayMs`
 * applies jitter iff both the flag and a sampler are present, so passing one unconditionally would
 * add spread the manifest did not ask for, and passing none leaves `jitter: true` inert.
 */
function registrationFor(
  declaration: JobDeclaration,
  handler: JobHandler,
  jitterRng: () => number,
): JobHandlerRegistration {
  const wantsJitter = declaration.retry?.backoff?.jitter === true;
  return {
    handler,
    ...(declaration.retry !== undefined ? { retry: declaration.retry } : { maxAttempts: 1 }),
    ...(wantsJitter ? { jitterRng } : {}),
    onFailure: declaration.onFailure,
  };
}
