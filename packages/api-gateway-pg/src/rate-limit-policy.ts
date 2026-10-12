import type { RouteDefinition } from "@crossengin/api-gateway";

/**
 * **A rate-limit policy is configuration, and the catalog already said so.**
 *
 * `@crossengin/rate-limiting` models a policy as a governance object — a five-state lifecycle,
 * four-eyes activation, `supersededByPolicyId` — and `meta.rate_limit_policies` is its table. That
 * table has never held a row, which is why `rate-limit-checker.ts` hardcoded
 * `meta.rate_limit_decisions.policy_id` to NULL: a `RESTRICT` reference into an empty table has
 * exactly one writable value.
 *
 * The question ADR-0334 left open was whether the fix is a store or a declaration. Four things in
 * the repository answer it, and none of them is an opinion:
 *
 * 1. **The declaration site already exists.** `RouteDefinition.rateLimitPolicyId` is
 *    `z.string().regex(/^rlp_.../).nullable()` in `@crossengin/api-gateway`, present at every one of
 *    the ~20 places a route is built, and read by nothing. Which policy governs a route is a
 *    property of the route, and the route is compiled, not stored.
 * 2. **The catalog spells a policy reference as TEXT almost everywhere.** `meta.gateway_routes`
 *    carries `rate_limit_policy_id TEXT` with a `^rlp_` check and **no foreign key** — the one table
 *    that persists "which policy governs this route" treats the id as an opaque declared identifier.
 *    So do `meta.throttle_events` (for *both* `policy_id` and `quota_definition_id`),
 *    `meta.autoscaling_events` and `meta.backup_records`. `meta.rate_limit_decisions` and
 *    `meta.rate_limit_exceptions` are the only two UUID-surrogate references in the whole catalog.
 * 3. **A policy store could not write a row today.** `created_by` is `NOT NULL` and references
 *    `meta.users`, which has no writer, and `status = 'active'` demands
 *    `activatedBy !== createdBy` — two fabricated, distinct UUIDs. That is ADR-0331's refused
 *    argument for compiling workflow definitions from a manifest, one notch more absolute.
 * 4. **A stored limit would be a second copy of a number with no first copy.** The limit today is a
 *    constructor argument on a class nothing constructs.
 *
 * **The argument for the store side, which is real.** A five-state lifecycle with four-eyes
 * activation is an authored artifact, and the catalog gave `rate_limit_policies` a platform
 * `UPDATE` arm — it is *mutable*, unlike `quota_definitions`. And
 * `meta.rate_limit_exceptions.policy_id` is a `NOT NULL RESTRICT` reference: a duration-capped
 * exemption granted by a human at runtime points at a row, not at a line in argv. The honest
 * resolution is that both are true of different questions, and that **TEXT is the spelling which
 * keeps both futures open**: a decision row needs the policy's *identifier*, which is stable whether
 * the policy was declared here or authored into `meta.rate_limit_policies` later. The UUID surrogate
 * foreclosed the declared answer and is empty in the authored one.
 *
 * So: declared, in the shape `JOB_HANDLER_PROVIDERS` and `DeletionCapabilities` established — the
 * deployment names it, nothing defaults it, and the absence is said out loud rather than filled in.
 */

export const RATE_LIMIT_POLICY_ID_PATTERN = /^rlp_[a-z0-9]{8,40}$/;

/** The smallest thing a request path needs from a policy: who it is, and what it permits. */
export interface DeclaredRateLimitPolicy {
  /** The `rlp_` identifier written to `meta.rate_limit_decisions.policy_id`. */
  readonly policyId: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitPolicyDeclaration {
  /** Applied to a route that names no policy of its own — which today is every route. */
  readonly defaultPolicy: DeclaredRateLimitPolicy;
  /** Keyed by `policyId`, for routes whose `rateLimitPolicyId` names one. */
  readonly byPolicyId: Readonly<Record<string, DeclaredRateLimitPolicy>>;
}

/**
 * An exported **starting point**, never a `z.default()` — ADR-0328's rule. A schema default is
 * applied to silence, and which limit a deployment permits is not something silence may answer:
 * guessing high lets a scraper through and guessing low refuses a legitimate client. It carries a
 * real `rlp_` id because an audit row naming `rlp_conservativedefault` is a traceable claim about
 * where the limit came from, where a NULL is not.
 */
export const CONSERVATIVE_RATE_LIMIT_POLICY: DeclaredRateLimitPolicy = Object.freeze({
  policyId: "rlp_conservativedefault",
  limit: 600,
  windowSeconds: 60,
});

export type PolicyDeclarationDefect =
  | "policy_id_malformed"
  | "limit_out_of_range"
  | "window_out_of_range"
  | "map_key_disagrees_with_policy_id"
  | "duplicate_policy_id";

export class RateLimitPolicyDeclarationError extends Error {
  readonly defect: PolicyDeclarationDefect;

  constructor(defect: PolicyDeclarationDefect, detail: string) {
    super(`${defect}: ${detail}`);
    this.name = "RateLimitPolicyDeclarationError";
    this.defect = defect;
  }
}

/** The ceiling is the contract's own: `RateLimitPolicySchema` caps nothing, but a window past a day is not a window. */
const MAX_WINDOW_SECONDS = 86_400;

function assertPolicy(policy: DeclaredRateLimitPolicy): void {
  if (!RATE_LIMIT_POLICY_ID_PATTERN.test(policy.policyId)) {
    throw new RateLimitPolicyDeclarationError(
      "policy_id_malformed",
      `${policy.policyId} does not match ${RATE_LIMIT_POLICY_ID_PATTERN.source}`,
    );
  }
  if (!Number.isInteger(policy.limit) || policy.limit < 1) {
    throw new RateLimitPolicyDeclarationError(
      "limit_out_of_range",
      `${policy.policyId} declares limit ${String(policy.limit)}; an integer >= 1 is required`,
    );
  }
  if (
    !Number.isInteger(policy.windowSeconds) ||
    policy.windowSeconds < 1 ||
    policy.windowSeconds > MAX_WINDOW_SECONDS
  ) {
    throw new RateLimitPolicyDeclarationError(
      "window_out_of_range",
      `${policy.policyId} declares windowSeconds ${String(policy.windowSeconds)}; an integer in 1..${String(MAX_WINDOW_SECONDS)} is required`,
    );
  }
}

/**
 * Validates a declaration and freezes it.
 *
 * The map-key check is not pedantry: the key is what a route's `rateLimitPolicyId` is looked up by
 * and the value's `policyId` is what lands in the audit row, so a disagreement between them records
 * one policy while applying another's limit — a wrong answer that no later check could detect,
 * because both halves are individually well-formed.
 */
export function declareRateLimitPolicies(input: {
  readonly defaultPolicy: DeclaredRateLimitPolicy;
  readonly policies?: readonly DeclaredRateLimitPolicy[];
}): RateLimitPolicyDeclaration {
  assertPolicy(input.defaultPolicy);
  const byPolicyId: Record<string, DeclaredRateLimitPolicy> = {};
  for (const policy of input.policies ?? []) {
    assertPolicy(policy);
    if (byPolicyId[policy.policyId] !== undefined) {
      throw new RateLimitPolicyDeclarationError(
        "duplicate_policy_id",
        `${policy.policyId} is declared twice`,
      );
    }
    byPolicyId[policy.policyId] = Object.freeze({ ...policy });
  }
  if (byPolicyId[input.defaultPolicy.policyId] === undefined) {
    byPolicyId[input.defaultPolicy.policyId] = Object.freeze({ ...input.defaultPolicy });
  } else if (
    byPolicyId[input.defaultPolicy.policyId]?.limit !== input.defaultPolicy.limit ||
    byPolicyId[input.defaultPolicy.policyId]?.windowSeconds !== input.defaultPolicy.windowSeconds
  ) {
    throw new RateLimitPolicyDeclarationError(
      "map_key_disagrees_with_policy_id",
      `${input.defaultPolicy.policyId} is declared twice with different limits`,
    );
  }
  return Object.freeze({
    defaultPolicy: byPolicyId[input.defaultPolicy.policyId] as DeclaredRateLimitPolicy,
    byPolicyId: Object.freeze(byPolicyId),
  });
}

export type PolicyResolution =
  | { readonly kind: "declared"; readonly policy: DeclaredRateLimitPolicy }
  | { readonly kind: "default"; readonly policy: DeclaredRateLimitPolicy }
  | { readonly kind: "undeclared"; readonly policyId: string };

/**
 * Which policy governs this request.
 *
 * A route naming a policy the deployment did not declare resolves `undeclared` rather than falling
 * back to the default, and the two are not interchangeable: the fallback would apply a *different*
 * limit than the route declares and then write the default's id into the audit row — a decision row
 * that names a policy whose terms were not the ones applied. `surveyRoutePolicies` exists so that
 * this is a boot-time finding rather than a per-request one.
 */
export function resolvePolicyForRoute(
  declaration: RateLimitPolicyDeclaration,
  route: RouteDefinition | null,
): PolicyResolution {
  const named = route?.rateLimitPolicyId ?? null;
  if (named === null) return { kind: "default", policy: declaration.defaultPolicy };
  const declared = declaration.byPolicyId[named];
  if (declared === undefined) return { kind: "undeclared", policyId: named };
  return { kind: "declared", policy: declared };
}

export type RoutePolicyVerdict = "declared" | "default_applies" | "undeclared";

export interface RoutePolicyFinding {
  readonly operationId: string;
  readonly verdict: RoutePolicyVerdict;
  readonly policyId: string;
}

export interface RoutePolicySurvey {
  readonly findings: readonly RoutePolicyFinding[];
  /** The routes whose declared policy does not exist — the only verdict that denies a request. */
  readonly undeclared: readonly RoutePolicyFinding[];
  readonly declaredPolicyIds: readonly string[];
  /** Declared and named by no route. Not a defect; a deployment may declare a policy ahead of the route that uses it. */
  readonly unusedPolicyIds: readonly string[];
}

/**
 * `surveyManifestJobs`' shape for routes: every route classified against the declaration, so a
 * deployment learns at boot which requests its gateway would refuse, rather than at the first one.
 */
export function surveyRoutePolicies(
  declaration: RateLimitPolicyDeclaration,
  routes: readonly RouteDefinition[],
): RoutePolicySurvey {
  const findings: RoutePolicyFinding[] = [];
  const used = new Set<string>();
  for (const route of routes) {
    const resolution = resolvePolicyForRoute(declaration, route);
    if (resolution.kind === "undeclared") {
      findings.push({
        operationId: route.operationId,
        verdict: "undeclared",
        policyId: resolution.policyId,
      });
      continue;
    }
    used.add(resolution.policy.policyId);
    findings.push({
      operationId: route.operationId,
      verdict: resolution.kind === "declared" ? "declared" : "default_applies",
      policyId: resolution.policy.policyId,
    });
  }
  const declaredPolicyIds = Object.keys(declaration.byPolicyId).sort();
  return {
    findings,
    undeclared: findings.filter((f) => f.verdict === "undeclared"),
    declaredPolicyIds,
    unusedPolicyIds: declaredPolicyIds.filter((id) => !used.has(id)),
  };
}

/**
 * `<policyId>:<limit>:<windowSeconds>` — the argv form, parsed here rather than in the app, the way
 * `parseApiKeySpec` is. A malformed field is refused by name instead of being coerced: `Number()`
 * accepts `"0x10"`, `"1e3"` and `" 10 "`, and a limit silently read as 16 from `"0x10"` is a
 * ceiling the operator did not configure (ADR-0334's `FIELD_TYPE_CHECKS` finding, in miniature).
 */
export function parseRateLimitPolicySpec(spec: string): DeclaredRateLimitPolicy {
  const parts = spec.split(":");
  if (parts.length !== 3) {
    throw new RateLimitPolicyDeclarationError(
      "policy_id_malformed",
      `expected <policyId>:<limit>:<windowSeconds>, got ${String(parts.length)} field(s)`,
    );
  }
  const [policyId, limitRaw, windowRaw] = parts as [string, string, string];
  const policy: DeclaredRateLimitPolicy = {
    policyId,
    limit: parseIntegerField(policyId, "limit", limitRaw),
    windowSeconds: parseIntegerField(policyId, "windowSeconds", windowRaw),
  };
  assertPolicy(policy);
  return Object.freeze(policy);
}

function parseIntegerField(policyId: string, field: string, raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new RateLimitPolicyDeclarationError(
      field === "limit" ? "limit_out_of_range" : "window_out_of_range",
      `${policyId} declares ${field} ${JSON.stringify(raw)}; decimal digits only`,
    );
  }
  return Number.parseInt(raw, 10);
}
