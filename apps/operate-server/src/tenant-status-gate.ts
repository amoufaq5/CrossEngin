import { SAFE_HTTP_METHODS } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, HandlerRegistry } from "@crossengin/api-gateway-runtime";
import {
  TENANT_LIFECYCLE_STATES,
  TenantLifecycleStateSchema,
  blocksReads,
  blocksWrites,
  type TenantLifecycleState,
} from "@crossengin/tenant-lifecycle";

import type { TenantRecord } from "./platform-tenants.js";

/**
 * What a tenant's lifecycle state is, as far as the request path is concerned.
 *
 * `null` means **no such tenant row**, which is a distinct answer from "could not look it up" — the
 * latter is an exception, and the two are handled asymmetrically below.
 */
export interface TenantStatusDirectory {
  statusFor(tenantId: string): Promise<TenantLifecycleState | null>;
}

/** The subset of `PostgresTenantStore` a directory reads. */
export interface TenantByIdReader {
  getById(id: string): Promise<TenantRecord | null>;
}

/**
 * The directory over the one existing reader of `meta.tenants`, rather than a second `SELECT status`
 * of its own. `getById` re-parses the row through `TenantRecordSchema`, so a row edited into a state
 * the contract forbids and the column CHECK permits raises here instead of being gated against
 * (ADR-0289), and there is one place that knows the table's shape.
 */
export function tenantStatusDirectoryFromStore(store: TenantByIdReader): TenantStatusDirectory {
  return {
    async statusFor(tenantId: string): Promise<TenantLifecycleState | null> {
      const record = await store.getById(tenantId);
      if (record === null) return null;
      return TenantLifecycleStateSchema.parse(record.status);
    },
  };
}

export interface CachedTenantStatusDirectoryOptions {
  /**
   * How long a resolved status is served without re-reading. A tenant's state changes a handful of
   * times in its life, so a per-request query would be paid on every request for a value that is
   * almost always the same one.
   */
  readonly ttlMs?: number;
  /**
   * How long an **absence** is served. Shorter than `ttlMs`, and deliberately a separate figure:
   * the two mistakes are not symmetric. A stale status delays an enforcement by the TTL; a stale
   * absence keeps refusing a tenant that an operator has just provisioned.
   */
  readonly absenceTtlMs?: number;
  /**
   * How long a value already past its TTL may be served when the refresh **fails**. Serving the
   * last known answer through a database blip is right — "we knew a minute ago" is real evidence —
   * but it cannot mean forever: a `deleted` tenant whose status nobody can re-read would otherwise
   * go on being served for as long as the outage lasts.
   */
  readonly maxStaleMs?: number;
  readonly now?: () => Date;
  /** Called when a refresh throws. The gate's decision is reported separately, by its own events. */
  readonly onRefreshError?: (tenantId: string, err: unknown, servedStale: boolean) => void;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_ABSENCE_TTL_MS = 5_000;
/**
 * How long a value past its TTL may be served when the refresh fails. Exported because the ABAC
 * attribute directory bounds the same thing for the same reason — "we knew a minute ago" is
 * evidence and cannot mean forever — and two copies of one figure drift.
 */
export const DEFAULT_MAX_STALE_MS = 300_000;

interface CacheEntry {
  readonly status: TenantLifecycleState | null;
  readonly readAtMs: number;
}

/**
 * A TTL cache in front of a directory, with the two failure modes separated.
 *
 * A **first** lookup that throws propagates: the gate has never known this tenant's state and must
 * not guess, in either direction. A **refresh** that throws serves the last known answer until
 * `maxStaleMs`, then propagates.
 */
export class CachedTenantStatusDirectory implements TenantStatusDirectory {
  private readonly inner: TenantStatusDirectory;
  private readonly entries: Map<string, CacheEntry> = new Map();
  private readonly inflight: Map<string, Promise<TenantLifecycleState | null>> = new Map();
  private readonly ttlMs: number;
  private readonly absenceTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly now: () => Date;
  private readonly onRefreshError: ((t: string, e: unknown, s: boolean) => void) | null;

  constructor(inner: TenantStatusDirectory, opts: CachedTenantStatusDirectoryOptions = {}) {
    this.inner = inner;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.absenceTtlMs = opts.absenceTtlMs ?? DEFAULT_ABSENCE_TTL_MS;
    this.maxStaleMs = opts.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
    this.now = opts.now ?? (() => new Date());
    this.onRefreshError = opts.onRefreshError ?? null;
  }

  private ttlFor(status: TenantLifecycleState | null): number {
    return status === null ? this.absenceTtlMs : this.ttlMs;
  }

  async statusFor(tenantId: string): Promise<TenantLifecycleState | null> {
    const nowMs = this.now().getTime();
    const cached = this.entries.get(tenantId);
    if (cached !== undefined && nowMs - cached.readAtMs < this.ttlFor(cached.status)) {
      return cached.status;
    }
    // Concurrent requests for one tenant share a single read. Without this, a cold cache under load
    // issues one query per in-flight request for the same answer — and the gate runs on every
    // request, so that is the whole request rate.
    const existing = this.inflight.get(tenantId);
    if (existing !== undefined) return existing;
    const promise = this.refresh(tenantId, cached, nowMs).finally(() => {
      this.inflight.delete(tenantId);
    });
    this.inflight.set(tenantId, promise);
    return promise;
  }

  private async refresh(
    tenantId: string,
    cached: CacheEntry | undefined,
    nowMs: number,
  ): Promise<TenantLifecycleState | null> {
    try {
      const status = await this.inner.statusFor(tenantId);
      this.entries.set(tenantId, { status, readAtMs: this.now().getTime() });
      return status;
    } catch (err) {
      const servable = cached !== undefined && nowMs - cached.readAtMs <= this.maxStaleMs;
      this.onRefreshError?.(tenantId, err, servable);
      if (servable) return cached.status;
      throw err;
    }
  }

  /** Test/diagnostic seam: forget everything, so the next lookup re-reads. */
  clear(): void {
    this.entries.clear();
  }
}

export const TENANT_GATE_DECISIONS = [
  "allowed",
  "no_tenant",
  "exempt",
  "writes_blocked",
  "reads_blocked",
  "tenant_unknown",
  "status_unavailable",
] as const;
export type TenantGateDecision = (typeof TENANT_GATE_DECISIONS)[number];

export interface TenantGateEvents {
  readonly onRefused?: (input: {
    readonly decision: TenantGateDecision;
    readonly operationId: string;
    readonly tenantId: string;
    readonly status: TenantLifecycleState | null;
  }) => void;
}

/**
 * Operation-id prefixes the gate does not apply to.
 *
 * `platform.` is exempt on a rule rather than for convenience: **the gate answers for the tenant a
 * request acts on, and a platform route acts on the deployment.** A platform credential names some
 * tenant because every credential does, and gating on it would mean a deployment whose platform
 * tenant went `suspended` could not reach the route that reactivates it — the console locking itself
 * out of the only surface that unlocks it. Platform routes carry their own role grants, four-eyes
 * and (for the destructive ones) confirmation fields; that is their access control, not this.
 */
export const DEFAULT_EXEMPT_OPERATION_PREFIXES: readonly string[] = ["platform."];

export interface TenantStatusGateOptions {
  readonly directory: TenantStatusDirectory;
  readonly exemptOperationPrefixes?: readonly string[];
  readonly events?: TenantGateEvents;
}

const PROBLEM_TYPE = "https://crossengin.dev/problems/tenant-lifecycle-state";
const UNAVAILABLE_PROBLEM_TYPE = "https://crossengin.dev/problems/tenant-status-unavailable";

function detailFor(status: TenantLifecycleState, write: boolean): string {
  switch (status) {
    case "deleted":
      return "This workspace has been deleted.";
    case "pending_deletion":
      return write
        ? "This workspace is queued for deletion; it is read-only until the erasure runs."
        : "This workspace is queued for deletion.";
    case "suspended":
      return "This workspace is suspended; reads are allowed but changes are blocked.";
    case "archived":
      return "This workspace is archived; reads are allowed but changes are blocked.";
    default:
      return `This workspace is ${status}.`;
  }
}

/** The 403 problem for a request a tenant's lifecycle state forbids. */
export function tenantStateProblem(status: TenantLifecycleState, write: boolean): HandlerOutput {
  return {
    kind: "json",
    status: 403,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: PROBLEM_TYPE,
      title: "Workspace unavailable",
      status: 403,
      detail: detailFor(status, write),
      tenantStatus: status,
      reason: write ? "tenant_writes_blocked" : "tenant_reads_blocked",
    },
  };
}

/**
 * The 503 for a tenant whose state could not be established.
 *
 * **503 and not 403**, because the two assert different things: a 403 says the state forbids this,
 * which is a claim about the tenant, and here there is no state in hand to make a claim from. It is
 * also the difference a client acts on — a 503 is retryable and a 403 is not.
 */
export function tenantStatusUnavailableProblem(): HandlerOutput {
  return {
    kind: "json",
    status: 503,
    headers: { "content-type": "application/problem+json", "retry-after": "5" },
    body: {
      type: UNAVAILABLE_PROBLEM_TYPE,
      title: "Workspace state unavailable",
      status: 503,
      detail: "This workspace's lifecycle state could not be established; the request was not run.",
      reason: "tenant_status_unavailable",
    },
  };
}

/** The 403 for a credential naming a tenant that has no `meta.tenants` row. */
export function tenantUnknownProblem(): HandlerOutput {
  return {
    kind: "json",
    status: 403,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: PROBLEM_TYPE,
      title: "Workspace unavailable",
      status: 403,
      detail: "This workspace is not provisioned.",
      tenantStatus: null,
      reason: "tenant_not_provisioned",
    },
  };
}

/**
 * Wraps one handler with the tenant lifecycle gate.
 *
 * Read-vs-write comes from `SAFE_HTTP_METHODS` on the route's own method rather than from a
 * declaration at registration, so it is total by construction — every route has a method, and a
 * route added later cannot omit itself from a classification list. The two rules themselves are
 * `blocksWrites` / `blocksReads` **called**, not restated: the contract has carried the policy since
 * Phase 1 (`pending_deletion` has been in `READ_ONLY_STATES` all along) and nothing asked it.
 *
 * A request with no resolved tenant passes through untouched, following `withEntitlement`: the gate
 * answers for a tenant and there is none, and auth already decided whether the request may proceed.
 */
export function withTenantStatus(
  handler: Handler,
  operationId: string,
  opts: TenantStatusGateOptions,
): Handler {
  const prefixes = opts.exemptOperationPrefixes ?? DEFAULT_EXEMPT_OPERATION_PREFIXES;
  if (prefixes.some((p) => operationId.startsWith(p))) return handler;
  return async (input) => {
    const tenantId = input.principal?.tenantId ?? null;
    if (tenantId === null) return handler(input);
    let status: TenantLifecycleState | null;
    try {
      status = await opts.directory.statusFor(tenantId);
    } catch {
      opts.events?.onRefused?.({
        decision: "status_unavailable",
        operationId,
        tenantId,
        status: null,
      });
      return tenantStatusUnavailableProblem();
    }
    if (status === null) {
      opts.events?.onRefused?.({ decision: "tenant_unknown", operationId, tenantId, status: null });
      return tenantUnknownProblem();
    }
    const write = !SAFE_HTTP_METHODS.has(input.route.method);
    if (blocksReads(status)) {
      opts.events?.onRefused?.({
        decision: "reads_blocked",
        operationId,
        tenantId,
        status,
      });
      return tenantStateProblem(status, write);
    }
    if (write && blocksWrites(status)) {
      opts.events?.onRefused?.({ decision: "writes_blocked", operationId, tenantId, status });
      return tenantStateProblem(status, true);
    }
    return handler(input);
  };
}

/**
 * Applies the gate to **every** registered handler, in place.
 *
 * Over `registry.operationIds()` rather than a list the caller supplies, which is the whole reason
 * that method now exists: a cross-cutting refusal that covers "the routes we remembered" is the
 * shape of defect this repo keeps finding. Must be called after every registration — the snapshot is
 * taken once — and is idempotent per boot only in the sense that calling it twice double-wraps, so
 * the one caller is `node.ts`.
 */
export function applyTenantStatusGate(
  registry: HandlerRegistry,
  opts: TenantStatusGateOptions,
): number {
  let wrapped = 0;
  for (const operationId of registry.operationIds()) {
    const handler = registry.resolve(operationId);
    if (handler === null) continue;
    const gated = withTenantStatus(handler, operationId, opts);
    if (gated === handler) continue;
    registry.register(operationId, gated);
    wrapped += 1;
  }
  return wrapped;
}

/**
 * Tenant ids a deployment's credentials name that have no `meta.tenants` row.
 *
 * The gate refuses those with a 403, so a deployment that enables it with unprovisioned API-key
 * tenants would answer 403 to every request — and `--api-key 'key:role:tenant'` specs name arbitrary
 * UUIDs that nothing requires to exist. That is why the gate is opt-in: the survey runs at boot and
 * names them *before* the first request, rather than leaving an operator to infer it from a 403.
 *
 * A lookup that throws is reported as `unreachable` and not as absent: at boot the database may
 * simply not be up yet, and calling that "not provisioned" would print a list of tenants that are.
 */
export interface TenantStatusCoverage {
  readonly checked: readonly string[];
  readonly missing: readonly string[];
  readonly unreachable: readonly string[];
  readonly blocked: readonly { readonly tenantId: string; readonly status: TenantLifecycleState }[];
}

export async function surveyTenantStatusCoverage(
  directory: TenantStatusDirectory,
  tenantIds: readonly string[],
): Promise<TenantStatusCoverage> {
  const checked = [...new Set(tenantIds)].sort();
  const missing: string[] = [];
  const unreachable: string[] = [];
  const blocked: { tenantId: string; status: TenantLifecycleState }[] = [];
  for (const tenantId of checked) {
    try {
      const status = await directory.statusFor(tenantId);
      if (status === null) missing.push(tenantId);
      else if (blocksWrites(status)) blocked.push({ tenantId, status });
    } catch {
      unreachable.push(tenantId);
    }
  }
  return { checked, missing, unreachable, blocked };
}

/** Every state the gate refuses a write in — derived, so a sixth state cannot be forgotten. */
export const WRITE_BLOCKING_STATES: readonly TenantLifecycleState[] =
  TENANT_LIFECYCLE_STATES.filter((s) => blocksWrites(s));

/** Every state the gate refuses a read in. */
export const READ_BLOCKING_STATES: readonly TenantLifecycleState[] =
  TENANT_LIFECYCLE_STATES.filter((s) => blocksReads(s));
