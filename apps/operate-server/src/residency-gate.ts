import {
  residencyRefusal,
  type Handler,
  type HandlerOutput,
  type HandlerRegistry,
  type ResidencyRefusalInput,
} from "@crossengin/api-gateway-runtime";
import type { Region, ResidencyProfile } from "@crossengin/residency";
import { decideRegionRouting, type TenantResidencyDirectory } from "@crossengin/residency-runtime";

/**
 * The residency decision on the **verified** tenant, after authentication.
 *
 * `OperateHttpServer.checkResidency` runs before the gateway and reads the unverified `x-tenant-id`
 * hint, so it can only ever be advisory routing: a request that sends no hint, or a hint naming a
 * tenant with no profile, reached the handler whatever the credential's tenant required — an eu-only
 * tenant's token was served from a us-east instance by simply omitting the header. This gate asks the
 * same question of `input.principal.tenantId`, the tenant the auth stage established, on every
 * registered handler, so the hint can no longer decide whether a request is served.
 *
 * Three answers, and each is a decision:
 *
 * - **A profile that forbids this region refuses** — 421 naming the home region when the profile
 *   allows one, 403 when it allows none. This is the fail-closed half.
 * - **A directory that cannot answer refuses** with a retryable 503. "We could not establish the
 *   tenant's profile" is not "the tenant has none", and serving on the second reading of the first
 *   would be the open failure this gate exists to remove.
 * - **A tenant with no profile is served.** Refusing it would refuse every tenant of a deployment
 *   whose residency file names only some of them, which works today (ADR-0338's rule read the other
 *   way), and a profile is opt-in per tenant. `formatResidencyGate` says so at boot.
 *
 * What this gate cannot do is the honest bound: it decides which *instance* answers, and nothing
 * about where the tenant's rows physically live. That is the database's region, its replicas and its
 * backups — infrastructure this process neither chooses nor can observe. A deployment whose one
 * database sits in us-east serves an eu-only tenant's data from us-east even when every request is
 * answered by an eu-central instance.
 *
 * A `system` principal — a job writing through `buildSystemEntityAccess`, which resolves the same
 * registry this gate wraps — is served: the job queue is cross-tenant, so placing background work by
 * region is the fleet's question and not this gate's.
 *
 * `platform.` routes are exempt for the tenant-status gate's reason: they act on the deployment, and
 * gating them on the operator's own tenant would let the operator's residency profile lock them out
 * of the console that administers every tenant.
 */
export const DEFAULT_RESIDENCY_EXEMPT_PREFIXES: readonly string[] = ["platform."];

export const RESIDENCY_GATE_DECISIONS = [
  "misdirected",
  "forbidden",
  "unresolved",
] as const;
export type ResidencyGateDecision = (typeof RESIDENCY_GATE_DECISIONS)[number];

export interface ResidencyGateRefusal {
  readonly decision: ResidencyGateDecision;
  readonly operationId: string;
  readonly tenantId: string;
  readonly region: Region;
}

export interface ResidencyGateOptions {
  readonly region: Region;
  readonly directory: TenantResidencyDirectory;
  readonly exemptOperationPrefixes?: readonly string[];
  readonly onRefused?: (refusal: ResidencyGateRefusal) => void;
}

/**
 * The gate's refusal, built by the same function the pre-auth hint check calls (ADR-0457), so a
 * client cannot tell from the body or the residency headers which of the two answered.
 */
function residencyProblem(input: ResidencyRefusalInput): HandlerOutput {
  const env = residencyRefusal(input);
  // The length is the dispatcher's to compute from the body it serializes, not the handler's.
  const { "content-length": _length, ...headers } = env.response.headers;
  return { kind: "json", status: env.body.status, headers, body: env.body };
}

export function withResidency(
  handler: Handler,
  operationId: string,
  opts: ResidencyGateOptions,
): Handler {
  const prefixes = opts.exemptOperationPrefixes ?? DEFAULT_RESIDENCY_EXEMPT_PREFIXES;
  if (prefixes.some((p) => operationId.startsWith(p))) return handler;
  return async (input) => {
    const tenantId = input.principal?.tenantId ?? null;
    if (tenantId === null) return handler(input);
    // A job's write reaches this handler through `buildSystemEntityAccess`, with a `system` principal
    // and no request behind it. The job queue is claimed cross-tenant by whichever instance's worker
    // gets there first, so refusing here would fail — and eventually dead-letter — a profiled
    // tenant's jobs on every instance outside its home region, where before this gate they ran.
    // Where background work runs is fleet placement, which this gate does not decide; the boot line
    // says so.
    if (input.principal?.principalKind === "system") return handler(input);
    const refuse = (decision: ResidencyGateDecision): void =>
      opts.onRefused?.({ decision, operationId, tenantId, region: opts.region });
    let profile: ResidencyProfile | null;
    try {
      profile = await opts.directory.resolve(tenantId);
    } catch {
      refuse("unresolved");
      return residencyProblem({ decision: "unresolved" });
    }
    if (profile === null) return handler(input);
    const decision = decideRegionRouting(profile, opts.region);
    if (decision.action === "serve") return handler(input);
    if (decision.action === "redirect") {
      refuse("misdirected");
      return residencyProblem({
        decision: "misdirected",
        detail: decision.reason,
        correctRegion: decision.region,
      });
    }
    refuse("forbidden");
    return residencyProblem({ decision: "forbidden", detail: decision.reason });
  };
}

/**
 * Wraps every registered handler, over `registry.operationIds()` for the reason
 * `applyTenantStatusGate` does: a refusal covering only the routes somebody remembered is not a
 * refusal. Called once per compiled gateway, after every registration.
 */
export function applyResidencyGate(registry: HandlerRegistry, opts: ResidencyGateOptions): number {
  let wrapped = 0;
  for (const operationId of registry.operationIds()) {
    const handler = registry.resolve(operationId);
    if (handler === null) continue;
    const gated = withResidency(handler, operationId, opts);
    if (gated === handler) continue;
    registry.register(operationId, gated);
    wrapped += 1;
  }
  return wrapped;
}

/** The boot line: what the gate decides and the two things it does not. */
export function formatResidencyGate(region: Region): string {
  return (
    `[residency] serving region ${region}: the residency profile of each request's authenticated ` +
    `tenant is enforced on every non-platform route — a forbidding profile is refused (421 to the home ` +
    `region, else 403) and an unreadable directory is refused 503; a tenant with no profile is ` +
    `served; a background job's write (a system principal) is not gated, because any instance's ` +
    `worker may claim it; this decides which instance answers a request, not where the database ` +
    `keeps the rows, which is infrastructure`
  );
}
