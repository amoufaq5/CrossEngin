/**
 * Which chains the two periodic passes will actually cover, said at boot.
 *
 * Both schedulers resolve their scope set from `allTenants` — the live tenant registry — or else
 * from the config's static `tenants` list plus the platform chain. Measured on the pinned schemas,
 * an **empty config** resolves to `{tenants: [], allTenants: false, includePlatform: true}`, so its
 * scope set is `[null]`: the platform chain alone, and not one tenant's. On a deployment that
 * declares no escalation flag the platform chain holds nothing at all, and ADR-0399's
 * `isEmptyScope` discards an empty scope's report entirely — zero callbacks, no stored verdict, no
 * finding. So `--integrity-proof-config` over `{}` mounts an hourly pass that prints **nothing,
 * ever**, while every tenant's audit chain goes unanchored and unverified.
 *
 * Verified live rather than reasoned, both arms on one cluster at a two-second tick: with `{}` the
 * three passes produced 0 anchors, 0 verdicts and **0 log lines** while the tenant's chain held an
 * entry, and with `allTenants` the same binary produced 4 anchors, 4 verdicts and 8 lines.
 *
 * That is a control reporting healthy over a population it never looked at, and nothing in the
 * binary said so: of the eighteen bracketed boot surfaces here, `[audit-chain]`, `[checkpoint]` and
 * `[integrity-proof]` were the three with **no affirmative line** — only `--store pg` warns and
 * per-event lines. The absence of the line is what made the vacuity invisible, which is why it
 * ships in the same change as the defaults rather than as a follow-up.
 *
 * It **reports and never refuses**, on ADR-0359's split: covering the platform chain alone is a
 * coherent request (a deployment may handle its tenants elsewhere) and the degraded state is not
 * itself the defect — the silence was. An empty scope set is not coherent, and it is reported at
 * error level rather than refused for a stated reason: the measured member count is zero, no
 * shipped deployment can reach it now that the compose declares its scope, and a refusal with no
 * member is a judgement this increment did not need to make.
 *
 * The survey is handed the scope list its caller's **own** resolver produced (`configScopes` /
 * `integrityConfigScopes`, both exported) rather than re-deriving it from the config, so it cannot
 * come to disagree with the thing it describes.
 */
import { TENANT_STATUSES } from "./platform-tenants.js";

/**
 * Which tenant statuses a **chain** pass covers under `allTenants`: every one of them.
 *
 * `PostgresTenantSource` defaults to `['active']` and that default is right for the thing it was
 * written for — you do not fire cron for a deleted tenant — and wrong here, which is one constant
 * answering two different questions (ADR-0334's shape, resolved the same way: the second question
 * gets its own constant). All four chain tables are `PLATFORM_RECORD_TABLES` members, retained by
 * the Article 17 erasure on that constant's own stated ground that *"an auditor or a regulator
 * reads these **after** the tenant is gone, and a deletion must not be able to destroy them"* — and
 * retirement is `UPDATE … SET status = 'deleted'`, so the `meta.tenants` row survives and the id
 * stays enumerable. So with `['active']` the two passes never cover a suspended, archived,
 * `pending_deletion` or `deleted` tenant, while those are exactly the tenants whose chains are kept
 * for ever: `pending_deletion` is the status whose data is about to be destroyed, so its trail is
 * the one that matters most, and `deleted` is the status the retention set *exists for*.
 *
 * Derived from `TENANT_STATUSES` and never listed, so a sixth status is covered by arriving
 * (ADR-0334's reason `TenantCounts` is derived — a hand-written four of five is how that census came
 * to omit `pending_deletion`).
 *
 * The cost of the wider set is one full fold per newly-covered scope, **once** — measured at 107 µs
 * per entry, so ~1.1 s at 10k entries — after which every pass is bounded from the anchor
 * (ADR-0371). A deployment that wants the narrow set declares `tenantStatuses` explicitly.
 */
export const CHAIN_SCOPE_TENANT_STATUSES: readonly string[] = Object.freeze([...TENANT_STATUSES]);

/**
 * The one spelling of *which statuses this chain pass covers*, read by both schedulers' wiring and
 * by the survey that describes them.
 *
 * A helper rather than a `z.default()` on the two schemas, for one reason that is not style:
 * `tenantStatuses` is `.nonempty()`, so a schema default has to be a non-empty **tuple** and
 * `CHAIN_SCOPE_TENANT_STATUSES` is derived from a constant, so the default could only be written
 * with a cast — and a cast standing in for a check is ADR-0362's class. Keeping the field
 * `.optional()` also keeps *absent* meaning "not stated", which is what lets this function be the
 * single place that decides what silence buys.
 *
 * Silence buys the **wide** set, which is a behaviour change for a deployment already passing
 * `allTenants` with no `tenantStatuses`, and it is the fix rather than a change to weigh: that
 * deployment is covering `['active']` today while the chains it does not cover are precisely the
 * ones kept for ever, so widening can only find more and never fewer (ADR-0338's rule — refusing,
 * or here tightening, must break nothing that worked, and a pass skipping a retained population was
 * not working). A deployment that wants the narrow set says so, and the boot line names whichever
 * set is in force.
 */
export function chainScopeStatuses(
  configured: readonly string[] | undefined,
): readonly string[] {
  return configured ?? CHAIN_SCOPE_TENANT_STATUSES;
}

/** What a pass will cover. */
export const CHAIN_SCOPE_COVERAGES = [
  "every_active_tenant",
  "named_tenants",
  "platform_only",
  "nothing",
] as const;
export type ChainScopeCoverage = (typeof CHAIN_SCOPE_COVERAGES)[number];

/**
 * Whether a coverage leaves tenant chains unexamined.
 *
 * A total map so a fifth coverage cannot be added without saying which side of the question it
 * falls on, and read by the boot line's level rather than by a comparison against two names.
 */
export const COVERAGE_REACHES_A_TENANT: Readonly<Record<ChainScopeCoverage, boolean>> =
  Object.freeze({
    every_active_tenant: true,
    named_tenants: true,
    platform_only: false,
    nothing: false,
  });

export interface ChainScopeSurveyInput {
  /** Whether the live tenant registry supplies the scopes, re-queried each pass. */
  readonly allTenants: boolean;
  /** What the caller's own static resolver answered — `null` is the platform chain. */
  readonly staticScopes: readonly (string | null)[];
  readonly includePlatform: boolean;
  readonly intervalMs: number;
  /** Which statuses the registry is asked for, under `allTenants`. */
  readonly tenantStatuses: readonly string[];
}

export interface ChainScopeSurvey {
  readonly coverage: ChainScopeCoverage;
  /** Tenants named statically; 0 under `allTenants`, where the count is a runtime answer. */
  readonly namedTenants: number;
  readonly includesPlatform: boolean;
  readonly intervalMs: number;
  readonly tenantStatuses: readonly string[];
}

export function surveyChainScopes(input: ChainScopeSurveyInput): ChainScopeSurvey {
  // 0 under `allTenants`, because there the static list is **replaced** rather than merged:
  // `node.ts` passes `tenants: tenantSourceScopes(...)`, which `buildCheckpointLifecycle` takes in
  // preference to `configScopes`. So a stale `tenants` entry beside `allTenants` is read by
  // nothing, and reporting it would be a figure describing a list no pass consults. (It is also
  // redundant rather than lost: `allTenants` over the wide status set covers every tenant the
  // registry holds.)
  const namedTenants = input.allTenants
    ? 0
    : input.staticScopes.filter((s) => s !== null).length;
  const coverage: ChainScopeCoverage = input.allTenants
    ? "every_active_tenant"
    : namedTenants > 0
      ? "named_tenants"
      : input.staticScopes.length > 0
        ? "platform_only"
        : "nothing";
  return {
    coverage,
    namedTenants,
    // Under `allTenants` the platform rides along iff `includePlatform`, which is what
    // `tenantSourceScopes` pushes; statically it is already in `staticScopes`.
    includesPlatform: input.allTenants ? input.includePlatform : input.staticScopes.includes(null),
    intervalMs: input.intervalMs,
    tenantStatuses: input.tenantStatuses,
  };
}

/**
 * The boot line. Names the scope set, because that is the fact whose absence let an empty config
 * read as covering, and names the remedy only on the arms where one exists.
 *
 * The status set is named on the `allTenants` arm and nowhere else: it is the one arm where the
 * population is a runtime answer, so an operator cannot otherwise tell whether a retired tenant's
 * trail is covered — and naming a status set beside a static tenant list would describe a filter
 * that arm does not apply.
 */
export function formatChainScopes(label: string, survey: ChainScopeSurvey): string {
  const every = `${(survey.intervalMs / 1000).toString()}s`;
  const platform = survey.includesPlatform ? " + the platform chain" : "";
  switch (survey.coverage) {
    case "every_active_tenant":
      return `${label}: every tenant with status ${survey.tenantStatuses.join("/")}${platform}, every ${every}`;
    case "named_tenants":
      return `${label}: ${survey.namedTenants.toString()} configured tenant(s)${platform}, every ${every} — a tenant provisioned later is NOT covered until it is added; set allTenants for the live registry`;
    case "platform_only":
      return `${label}: the platform chain ONLY, every ${every} — no tenant's chain is covered, so this pass reports healthy over a population it never reads. Set allTenants, or name tenants`;
    case "nothing":
      return `${label}: NO scope at all, every ${every} — the pass will fire and read nothing. Set allTenants, name tenants, or drop the flag`;
  }
}
