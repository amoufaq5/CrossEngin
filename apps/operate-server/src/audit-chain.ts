
import { z } from "zod";
import { STAGE_OUTCOMES, type PipelineExecution } from "@crossengin/api-gateway";
import {
  ed25519PublicKeyFingerprint,
  ed25519PublicKeyFromSeed,
  isEd25519PrivateSeedBase64,
  isEd25519PublicKeyBase64,
  sha256,
  signEd25519,
} from "@crossengin/crypto";
import {
  PostgresChainLogStore,
  type ChainAppendInput,
  type ChainedLogEntry,
  type ChainSigner,
} from "@crossengin/forensics-pg";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export const TenantAuditPolicySchema = z
  .object({
    outcomes: z.array(z.enum(STAGE_OUTCOMES)).optional(),
    operations: z.array(z.string().min(1)).optional(),
    sampleRate: z.number().min(0).max(1).optional(),
  })
  .strict();
export type TenantAuditPolicy = z.infer<typeof TenantAuditPolicySchema>;

export const AuditChainConfigSchema = z
  .object({
    schema: z.string().regex(SCHEMA_RE).default("meta"),
    actorReference: z.string().min(1).default("operate-server"),
    /**
     * Both halves are checked **here** rather than only where they are used, on ADR-0348's split:
     * whether a string is a 32-byte Ed25519 key is a property of the config alone, so it is
     * decidable at parse time — where `loadAuditChainConfig` already names the file and zod names
     * the field, which is the house refusal shape by construction instead of by a hand-written
     * string. The predicates are `@crossengin/crypto`'s own, imported rather than restated.
     *
     * The alternative — catch the decode where the signer derives — closes only one arm and reads
     * worse: `publicKeyBase64: "x"` passed `.min(1)` and then threw a bare
     * `public key must decode to 32 bytes, got 0` at boot, naming neither the flag nor the field
     * (ADR-0364's addendum class). `ed25519ChainSigner` keeps its try as a backstop for a direct
     * caller that never parsed, which is `dischargeAbac`'s shape.
     */
    privateKeyBase64: z
      .string()
      .min(1)
      .refine(isEd25519PrivateSeedBase64, "must be a 32-byte Ed25519 private seed, base64"),
    publicKeyBase64: z
      .string()
      .min(1)
      .refine(isEd25519PublicKeyBase64, "must be a 32-byte Ed25519 public key, base64"),
    outcomes: z.array(z.enum(STAGE_OUTCOMES)).optional(),
    operations: z.array(z.string().min(1)).optional(),
    sampleRate: z.number().min(0).max(1).default(1),
    tenantOverrides: z.record(z.string().uuid(), TenantAuditPolicySchema).optional(),
  })
  .strict();
export type AuditChainConfig = z.infer<typeof AuditChainConfigSchema>;

/** Effective sampling/filter policy for a single scope — the base policy after any per-tenant merge. */
export interface EffectiveAuditPolicy {
  readonly outcomes?: readonly (typeof STAGE_OUTCOMES)[number][];
  readonly operations?: readonly string[];
  readonly sampleRate: number;
}

/**
 * Resolves the effective sampling/filter policy for a scope: a per-field merge of the tenant's override
 * OVER the base policy (each of `outcomes` / `operations` / `sampleRate` taken from the override when
 * present, else the base). A null (platform) tenant, or a tenant with no override, uses the base unchanged.
 */
export function resolveAuditPolicy(
  tenantId: string | null,
  config: Pick<AuditChainConfig, "outcomes" | "operations" | "sampleRate" | "tenantOverrides">,
): EffectiveAuditPolicy {
  const override = tenantId === null ? undefined : config.tenantOverrides?.[tenantId];
  return {
    outcomes: override?.outcomes ?? config.outcomes,
    operations: override?.operations ?? config.operations,
    sampleRate: override?.sampleRate ?? config.sampleRate,
  };
}

/** Deterministic sample position in [0, 1) for a request id — a fixed hex prefix of its sha256 digest. */
export function sampleValue(requestId: string): number {
  const prefix = sha256(requestId).slice(0, 13);
  return parseInt(prefix, 16) / 0x10000000000000;
}

/**
 * Applies an already-resolved effective policy to one execution: its `finalOutcome` must be in `outcomes`
 * (if set), its `routeOperationId` in `operations` (if set — a null operation is excluded whenever an
 * allowlist is configured), and its deterministic sample of `requestId` must fall under `sampleRate`.
 */
export function applyEffectiveAuditPolicy(
  execution: PipelineExecution,
  policy: EffectiveAuditPolicy,
): boolean {
  if (policy.outcomes && !policy.outcomes.includes(execution.finalOutcome)) return false;
  if (policy.operations) {
    if (execution.routeOperationId === null) return false;
    if (!policy.operations.includes(execution.routeOperationId)) return false;
  }
  if (policy.sampleRate >= 1) return true;
  return sampleValue(execution.requestId) < policy.sampleRate;
}

/**
 * Pure filter deciding whether a completed request should be appended to the audit chain. The effective
 * policy is resolved per-tenant (base, then any `tenantOverrides` merge): its `finalOutcome` must be in
 * `outcomes` (if set), its `routeOperationId` in `operations` (if set — a null operation is excluded
 * whenever an allowlist is configured), and its deterministic sample of `requestId` must fall under
 * `sampleRate`. All three default to recording everything.
 */
export function shouldRecordAudit(
  execution: PipelineExecution,
  config: Pick<AuditChainConfig, "outcomes" | "operations" | "sampleRate" | "tenantOverrides">,
): boolean {
  return applyEffectiveAuditPolicy(execution, resolveAuditPolicy(execution.tenantId, config));
}

/** The three knobs a tenant's live policy carries, each of which can only widen (M-19). */
export const LIVE_AUDIT_POLICY_FIELDS = ["sampleRate", "outcomes", "operations"] as const;
export type LiveAuditPolicyField = (typeof LIVE_AUDIT_POLICY_FIELDS)[number];

/**
 * A tenant's live policy merged over the deployment's, **widening only** (M-19).
 *
 * The live policy is written by the tenant's own administrator through the settings route, and the
 * request-level chain entry it governs is the only tamper-evident record of that tenant's reads,
 * its denied and failed requests and every non-entity route — C-05 records a successful entity
 * write in its own transaction and marks the request superseded, so what is left for sampling to
 * decide is precisely the conduct an administrator might prefer unrecorded. A per-field override
 * let them set `sampleRate: 0` or an `outcomes: ["pass"]` allowlist and silence it.
 *
 * So the deployment's policy (the config's base plus any `tenantOverrides`, both the operator's to
 * set) is the floor: a live `sampleRate` counts only above it, a live `outcomes` or `operations`
 * list is unioned with the deployment's allowlist and ignored outright when the deployment records
 * every outcome or operation. `narrowingIgnored` names the fields whose live value tried to record
 * less, so the refresh can say so instead of leaving a stored setting silently inert.
 */
export function widenWithLivePolicy(
  base: EffectiveAuditPolicy,
  live: TenantAuditPolicy | undefined,
): { readonly effective: EffectiveAuditPolicy; readonly narrowingIgnored: readonly LiveAuditPolicyField[] } {
  if (live === undefined) return { effective: base, narrowingIgnored: [] };
  const narrowingIgnored: LiveAuditPolicyField[] = [];
  let sampleRate = base.sampleRate;
  if (live.sampleRate !== undefined) {
    if (live.sampleRate < base.sampleRate) narrowingIgnored.push("sampleRate");
    sampleRate = Math.max(live.sampleRate, base.sampleRate);
  }
  const widenList = <T extends string>(
    field: "outcomes" | "operations",
    baseList: readonly T[] | undefined,
    liveList: readonly T[] | undefined,
  ): readonly T[] | undefined => {
    if (liveList === undefined) return baseList;
    if (baseList === undefined || baseList.some((v) => !liveList.includes(v))) {
      narrowingIgnored.push(field);
    }
    return baseList === undefined ? undefined : [...new Set([...baseList, ...liveList])];
  };
  const outcomes = widenList("outcomes", base.outcomes, live.outcomes);
  const operations = widenList("operations", base.operations, live.operations);
  return { effective: { outcomes, operations, sampleRate }, narrowingIgnored };
}

/**
 * Cache-aware variant: the tenant's **live** policy (from `meta.operate_tenant_settings`) widens the
 * config-resolved policy and never narrows it — see {@link widenWithLivePolicy}. A `null` (platform)
 * tenant or a tenant with no live policy behaves exactly like {@link shouldRecordAudit}.
 */
export function shouldRecordAuditWithLive(
  execution: PipelineExecution,
  config: Pick<AuditChainConfig, "outcomes" | "operations" | "sampleRate" | "tenantOverrides">,
  live: TenantAuditPolicy | undefined,
): boolean {
  const base = resolveAuditPolicy(execution.tenantId, config);
  return applyEffectiveAuditPolicy(execution, widenWithLivePolicy(base, live).effective);
}

export function parseAuditChainConfig(json: unknown): AuditChainConfig {
  return AuditChainConfigSchema.parse(json);
}

// `loadAuditChainConfig` lived here and is **deleted** rather than kept beside its replacement.
// It parsed the *resolved* schema, so it refused a policy-only file — the one shape ADR-0406 exists
// to admit — which makes it a second spelling that disagrees with the live one rather than a
// narrower sibling (ADR-0337's test for a deletion). `loadAuditChainFile` in `audit-chain-env.ts`
// is the reader, and it keeps both of this function's named errors verbatim, because those name the
// flag and the path an operator edits where zod's own message names neither.
//
// `parseAuditChainConfig` stays: it is the resolved-shape parse that `resolveAuditChain` composes
// through, so the two routes cannot produce objects a consumer could tell apart.

/**
 * A `ChainSigner` backed directly by an Ed25519 keypair (no key store needed for the serving edge).
 *
 * The pair is checked against itself first, because node will not do it: an OKP private key is
 * built from `d` and an inconsistent `x` is **silently discarded**, so `signEd25519(seedA, pubB, …)`
 * returns a signature valid under A while this signer announces B's fingerprint on every entry it
 * writes. Nothing downstream recovers from that — the entries resolve to a registered public key
 * that cannot verify them, so each reads `bad_signature` for ever and the full-chain proof reports
 * `compromised` at a 100% false-positive rate, which pages. Observed live on three entries left by
 * an ordinary boot that announced nothing.
 *
 * Refused rather than warned: a deployment in this state cannot verify a single entry it writes,
 * and no later configuration repairs the ones already signed.
 */
export function ed25519ChainSigner(keypair: {
  readonly privateKeyBase64: string;
  readonly publicKeyBase64: string;
}): ChainSigner {
  // Compared as fingerprints rather than as the two base64 strings: each is the sha256 of the
  // decoded 32 bytes, so an unpadded-but-correct public key is not reported as a mismatch. The
  // fingerprint is also what every entry records, so the refusal names the identifier an operator
  // can find in the chain — and it is a digest of public material, never key material.
  //
  // Both decodes are wrapped as a BACKSTOP: `AuditChainConfigSchema` refuses a malformed half at
  // parse time, so a config that reached here through `parseAuditChainConfig` cannot take these
  // arms. They exist for a direct caller that built the pair by hand, and they say what the
  // underlying refusal does not — the flag and the field an operator would edit, rather than
  // another package's sentence about a "private seed" (ADR-0364's addendum class).
  let fingerprint: string;
  try {
    fingerprint = ed25519PublicKeyFingerprint(keypair.publicKeyBase64);
  } catch (err) {
    throw new Error(
      "--audit-chain-config: publicKeyBase64 is not a usable Ed25519 public key" +
        ` (expected a 32-byte Ed25519 public key, base64): ${errMessage(err)}`,
    );
  }
  let derivedPublicKey: string;
  try {
    derivedPublicKey = ed25519PublicKeyFromSeed(keypair.privateKeyBase64);
  } catch (err) {
    throw new Error(
      "--audit-chain-config: privateKeyBase64 is not a usable Ed25519 private key" +
        ` (expected a 32-byte Ed25519 seed, base64): ${errMessage(err)}`,
    );
  }
  const derived = ed25519PublicKeyFingerprint(derivedPublicKey);
  if (derived !== fingerprint) {
    throw new Error(
      "--audit-chain-config: publicKeyBase64 is not the public half of privateKeyBase64" +
        ` (configured fingerprint ${fingerprint}, derived ${derived}) — entries would be signed` +
        " under the derived key and announced under the configured one, so none could verify",
    );
  }
  return {
    fingerprint,
    sign: async (bytes) =>
      signEd25519(keypair.privateKeyBase64, keypair.publicKeyBase64, bytes),
  };
}

/** Projects a completed request's `PipelineExecution` into an append for the tenant's audit chain. */
export function auditAppendInputFrom(
  execution: PipelineExecution,
  config: Pick<AuditChainConfig, "actorReference">,
): ChainAppendInput {
  return {
    tenantId: execution.tenantId,
    kind: "audit_event",
    actorReference: execution.principalId ?? config.actorReference,
    recordedAt: execution.completedAt,
    payload: JSON.stringify({
      requestId: execution.requestId,
      operationId: execution.routeOperationId,
      outcome: execution.finalOutcome,
      status: execution.finalResponseStatus,
      principalId: execution.principalId,
      correlationId: execution.correlationId,
      completedAt: execution.completedAt,
    }),
  };
}

/** A live per-tenant audit-policy snapshot the observer consults on each request (satisfied by `TenantAuditPolicyCache`). */
export interface LiveAuditPolicySource {
  get(tenantId: string): TenantAuditPolicy | undefined;
}

export interface AuditChainObserverOptions {
  readonly onAppend?: (entry: ChainedLogEntry) => void;
  readonly onError?: (err: unknown) => void;
  /**
   * Optional live policy cache. When present, a tenant's live sampling/filter policy is merged OVER the
   * config-resolved policy (live wins per-field); a `null` tenant or a tenant with no live policy falls
   * back to the config path unchanged.
   */
  readonly policyCache?: LiveAuditPolicySource;
  /**
   * Whether this request's entry is already in the chain in a richer form — an entity write recorded
   * and anchored in its own transaction (`EntityAuditRecorder.supersedes`). Asked for every
   * request, including one the sampling policy excludes, because answering consumes the recorder's
   * mark. Absent, nothing is skipped.
   */
  readonly supersedes?: (execution: PipelineExecution) => boolean;
}

const PLATFORM_SCOPE = "\u0000platform";

/**
 * Appends one `audit_event` chain entry per completed request. Appends are pushed through a **per-scope**
 * promise queue (keyed by tenant, with a distinct queue for the platform chain) so a tenant's own appends
 * run strictly one-at-a-time — the hash chain must be linear per scope — while different tenants append in
 * parallel. Only the same-tenant serialization is required (each chain links to its own tail, and the
 * producer's advisory lock is per-tenant), so a single global queue would needlessly block one tenant on
 * another's slow append. A scope's queue is dropped once it drains, so the map doesn't grow without bound.
 * A queue never rejects (both outcomes are handled), so one failed append never stalls the next.
 */
export class AuditChainObserver {
  private readonly queues = new Map<string, Promise<void>>();
  private inFlight = 0;

  constructor(
    private readonly store: PostgresChainLogStore,
    private readonly config: AuditChainConfig,
    private readonly opts: AuditChainObserverOptions = {},
  ) {}

  record(execution: PipelineExecution): void {
    const live =
      this.opts.policyCache !== undefined && execution.tenantId !== null
        ? this.opts.policyCache.get(execution.tenantId)
        : undefined;
    // Asked whatever the policy says, so a mark left by an entity write is consumed rather than
    // held until eviction; the order of the two tests decides nothing else.
    const superseded = this.opts.supersedes?.(execution) ?? false;
    if (!shouldRecordAuditWithLive(execution, this.config, live)) return;
    if (superseded) return;
    const input = auditAppendInputFrom(execution, this.config);
    const scope = input.tenantId ?? PLATFORM_SCOPE;
    this.inFlight += 1;
    const prev = this.queues.get(scope) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        const entry = await this.store.append(input);
        this.opts.onAppend?.(entry);
      } catch (err) {
        this.opts.onError?.(err);
      } finally {
        this.inFlight -= 1;
      }
    });
    this.queues.set(scope, next);
    // Drop the scope's queue once it settles, unless a newer append has already chained onto it.
    void next.finally(() => {
      if (this.queues.get(scope) === next) this.queues.delete(scope);
    });
  }

  asExecutionSink(): (execution: PipelineExecution) => void {
    return (execution) => this.record(execution);
  }

  /** Resolves once every scope's queued appends have settled — for graceful shutdown / tests. */
  async drain(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all([...this.queues.values()]);
    }
  }

  pending(): number {
    return this.inFlight;
  }

  /** Number of scopes with in-flight or queued appends (for tests / metrics). */
  activeScopes(): number {
    return this.queues.size;
  }
}

export interface AuditChain {
  readonly observer: AuditChainObserver;
  readonly store: PostgresChainLogStore;
}

/**
 * The chain producer alone, without the per-request observer around it. Split out because the
 * audit-log emitter needs the store at wiring time — earlier than the observer, whose live
 * policy cache is built later — and both must append into the *same* chain per tenant.
 */
export function auditChainStore(
  conn: PgConnection,
  config: AuditChainConfig,
): PostgresChainLogStore {
  return new PostgresChainLogStore(conn, ed25519ChainSigner(config), { schema: config.schema });
}

export interface BuildAuditChainOptions extends AuditChainObserverOptions {
  /** Reuse an already-built producer (from {@link auditChainStore}) instead of making a second. */
  readonly store?: PostgresChainLogStore;
}

export function buildAuditChain(
  conn: PgConnection,
  config: AuditChainConfig,
  opts: BuildAuditChainOptions = {},
): AuditChain {
  const store = opts.store ?? auditChainStore(conn, config);
  return { observer: new AuditChainObserver(store, config, opts), store };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
