import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import {
  PostgresChainCheckpointStore,
  PostgresChainLogStore,
  type ChainSigner,
} from "@crossengin/forensics-pg";
import type { PgConnection } from "@crossengin/kernel-pg";

import { verifyAuditAnchors, type AuditAnchorReport } from "./audit-anchor.js";
import { PostgresAuditEmitter } from "./audit-log-store.js";
import {
  verifyChainFromCheckpoint,
  verifyChainFull,
  type ChainVerificationReport,
} from "./chain-verify.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export const IntegrityProofConfigSchema = z
  .object({
    schema: z.string().regex(SCHEMA_RE).default("meta"),
    intervalMs: z.number().int().positive().default(3_600_000),
    /** Actor recorded on the verdict chain entry. */
    verifiedBy: z.string().min(1).default("operate-server"),
    tenants: z.array(z.string().uuid()).default([]),
    /** Also prove the platform chain. Chain half only — `audit_log.tenant_id` is NOT NULL. */
    includePlatform: z.boolean().default(false),
    allTenants: z.boolean().default(false),
    tenantStatuses: z.array(z.string().min(1)).nonempty().optional(),
    /** How many of the most recent audit rows to prove per pass (the store clamps at 500). */
    auditRowLimit: z.number().int().positive().default(500),
    /**
     * Verify only the chain suffix after the latest checkpoint rather than folding from genesis.
     * On by default so the cost of a pass stays bounded as a chain grows (ADR-0252/0255).
     */
    fromCheckpoint: z.boolean().default(true),
    /**
     * Append the verdict to the chain as a `security_event`. On by default: a verdict that lives
     * only in a log line is lost, and one in an ordinary table could be deleted by the same
     * superuser who tampered with the audit log. In the chain, *editing* it or removing an
     * earlier one breaks a link. Removing the newest one does not — see `ChainTruncationCheck`
     * — which is why a checkpoint has to cover it before it is truly beyond reach.
     */
    recordVerdict: z.boolean().default(true),
  })
  .strict();
export type IntegrityProofConfig = z.infer<typeof IntegrityProofConfigSchema>;

export function parseIntegrityProofConfig(json: unknown): IntegrityProofConfig {
  return IntegrityProofConfigSchema.parse(json);
}

export async function loadIntegrityProofConfig(path: string): Promise<IntegrityProofConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--integrity-proof-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--integrity-proof-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return parseIntegrityProofConfig(parsed);
}

/**
 * What a pass concluded about one scope.
 *
 * - `verified` — both halves proved: every audit row matches its anchor, and the chain those
 *   anchors live in is linked and signed.
 * - `unproven` — nothing is disproven, but some rows carry no anchor. The expected state of a
 *   deployment that predates ADR-0286, and **not** an alarm: absence of evidence.
 * - `compromised` — something is disproven. A row no longer matches its anchor, an anchor is
 *   gone, or the chain itself is broken or unsigned. This is the finding.
 */
export const INTEGRITY_VERDICTS = ["verified", "unproven", "compromised"] as const;
export type IntegrityVerdict = (typeof INTEGRITY_VERDICTS)[number];

/**
 * Whether entries the chain was already committed to have gone missing from its end.
 *
 * Hash chains detect modification and removal from the *middle* — both break a link. They do not
 * detect **truncation**: lopping entries off the tail leaves a shorter, perfectly-linked chain, and
 * `verifyChainSuffix` returns valid on an empty suffix. So the newest entries, including the most
 * recent verdict, could be deleted and every signature check would still pass.
 *
 * A checkpoint is the external witness that closes this. Once one exists at sequence N, the chain
 * must still hold an entry at N or beyond; a shorter chain has lost history it was committed to.
 * Before the first checkpoint there is nothing to compare against, which is why running the
 * checkpoint scheduler alongside this one is not optional.
 */
export interface ChainTruncationCheck {
  readonly checkpointSequence: number | null;
  readonly tailSequence: number | null;
  readonly truncated: boolean;
}

export interface IntegrityProofReport {
  /** Tenant id, or `null` for the platform chain. */
  readonly scope: string | null;
  readonly verdict: IntegrityVerdict;
  readonly verifiedAt: string;
  readonly chain: ChainVerificationReport;
  /** Null for the platform chain, which has no audit rows to anchor. */
  readonly anchors: AuditAnchorReport | null;
  readonly truncation: ChainTruncationCheck;
}

export interface IntegrityProofPassResult {
  readonly scope: string | null;
  readonly outcome: "proved" | "skipped_empty" | "error";
  readonly report?: IntegrityProofReport;
  /** Sequence of the verdict entry appended to the chain, when one was. */
  readonly recordedAt?: number;
  readonly error?: unknown;
}

/**
 * The whole audit-integrity proof for one scope: three checks, none sufficient alone.
 *
 * ADR-0286 anchored each audit row in the forensic chain and noted that **neither half is a
 * proof alone**: the anchor check shows each row matches what was committed to, the chain check
 * shows those commitments are linked and signed. A wholesale forgery of chain *and* rows would
 * satisfy the anchor half by itself, because the forged entry would commit to the forged row.
 *
 * Running them live revealed a third gap they share — see {@link ChainTruncationCheck}. Cutting
 * entries off the chain's end leaves every link and signature valid, so truncation is asked about
 * separately, against a checkpoint.
 *
 * The platform chain (`scope === null`) gets no anchor check — `audit_log.tenant_id` is NOT NULL,
 * so there are no platform audit rows to anchor.
 */
export async function proveScopeIntegrity(
  scope: string | null,
  deps: {
    readonly logStore: PostgresChainLogStore;
    readonly checkpoints: PostgresChainCheckpointStore;
    readonly registry: PostgresKeyRegistry;
    readonly audit: PostgresAuditEmitter;
    readonly auditRowLimit: number;
    readonly fromCheckpoint: boolean;
    readonly now: () => Date;
  },
): Promise<IntegrityProofReport> {
  const chain = deps.fromCheckpoint
    ? await verifyChainFromCheckpoint(deps.logStore, deps.registry, deps.checkpoints, scope)
    : await verifyChainFull(deps.logStore, deps.registry, scope);

  // Neither verification path notices a chain that has been cut short, so ask separately.
  const checkpoint = await deps.checkpoints.latest(scope);
  const tail = await deps.logStore.tail(scope);
  const truncation: ChainTruncationCheck = {
    checkpointSequence: checkpoint?.sequenceNumber ?? null,
    tailSequence: tail?.sequenceNumber ?? null,
    truncated:
      checkpoint !== null &&
      (tail === null || tail.sequenceNumber < checkpoint.sequenceNumber),
  };

  let anchors: AuditAnchorReport | null = null;
  if (scope !== null) {
    const rows = await deps.audit.listAnchoredForTenant(scope, { limit: deps.auditRowLimit });
    // The anchor check needs the entries the rows point at, which a checkpoint-bounded suffix
    // may not contain, so it always reads the whole chain. The chain *half* stays bounded.
    anchors = verifyAuditAnchors(scope, rows, await deps.logStore.loadChain(scope));
  }

  return {
    scope,
    verdict: integrityVerdictFor(chain, anchors, truncation),
    verifiedAt: deps.now().toISOString(),
    chain,
    anchors,
    truncation,
  };
}

/**
 * The verdict from every half. Exported because this is where the judgement lives, and the
 * distinction it draws is the one that decides whether anyone gets woken up.
 */
export function integrityVerdictFor(
  chain: ChainVerificationReport,
  anchors: AuditAnchorReport | null,
  truncation: ChainTruncationCheck,
): IntegrityVerdict {
  // Checked first: a truncated chain still passes every link and signature check, so nothing
  // else in the report would reveal it.
  if (truncation.truncated) return "compromised";
  // A broken or unsigned chain is disproven regardless of what the rows say: the anchors it
  // holds cannot be trusted to attest to anything.
  if (!chain.ok) return "compromised";
  if (anchors === null) return "verified";
  if (anchors.tampered.length > 0) return "compromised";
  // `anchors.ok` also requires nothing unanchored; that is split out here, because an unanchored
  // row is unproven rather than disproven and must not page anyone. A deployment upgrading from
  // before ADR-0286 has such rows forever, and treating them as findings would make the whole
  // scheduler undeployable.
  return anchors.unanchored > 0 ? "unproven" : "verified";
}

/** The deterministic bytes the chain commits to for one verdict. */
export function integrityVerdictPayload(report: IntegrityProofReport): string {
  return JSON.stringify({
    kind: "audit_integrity_proof",
    scope: report.scope,
    verdict: report.verdict,
    verifiedAt: report.verifiedAt,
    chain: {
      ok: report.chain.ok,
      mode: report.chain.mode,
      checkpointSequence: report.chain.checkpointSequence,
      integrityValid: report.chain.integrity.valid,
      brokenAt: report.chain.integrity.brokenAt,
      signaturesValid: report.chain.signatures.valid,
    },
    truncation: {
      checkpointSequence: report.truncation.checkpointSequence,
      tailSequence: report.truncation.tailSequence,
      truncated: report.truncation.truncated,
    },
    anchors:
      report.anchors === null
        ? null
        : {
            checked: report.anchors.checked,
            verified: report.anchors.verified,
            unanchored: report.anchors.unanchored,
            tampered: report.anchors.tampered.map((t) => ({
              auditId: t.auditId,
              verdict: t.verdict,
              sequenceNumber: t.sequenceNumber,
            })),
          },
  });
}

export type IntegrityScopeSource = () =>
  | Promise<readonly (string | null)[]>
  | readonly (string | null)[];

export interface IntegrityProofSchedulerOptions {
  /** Runs both halves for one scope. Built from the stores by `buildIntegrityProofLifecycle`. */
  readonly prove: (scope: string | null) => Promise<IntegrityProofReport>;
  /** Appends the verdict to the chain. Omitted ⇒ verdicts are computed but not recorded. */
  readonly record?: (report: IntegrityProofReport) => Promise<number>;
  readonly scopes: IntegrityScopeSource;
  readonly intervalMs: number;
  readonly scheduler?: IntervalScheduler;
  readonly runOnStart?: boolean;
  readonly onPass?: (report: IntegrityProofReport) => void;
  /** Fires only for `compromised` — the one outcome that means something is provably wrong. */
  readonly onFinding?: (report: IntegrityProofReport) => void;
  readonly onError?: (err: unknown) => void;
}

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.(); // don't keep the process alive
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Periodically runs the audit-integrity proof per scope and records the verdict in the chain.
 *
 * ADR-0286 built both halves of the proof and left them unrun: a check nobody performs proves
 * nothing, and a tamper that nothing looks for is indistinguishable from no tamper. This is the
 * thing that looks.
 *
 * The verdict is appended to the chain **after** verifying, so it sits outside what it attests to
 * and the next pass covers it — an unbroken run of verdict entries is itself the evidence that
 * checking happened, which a log line could never be. A scope with no chain entries and no audit
 * rows is skipped rather than recorded, so an idle tenant does not accrue verdicts about nothing.
 *
 * A per-scope failure is routed to `onError` and the pass continues; one tenant never blocks the
 * rest. Mirrors `CheckpointScheduler`: the timer is `unref`'d and `start()` fires an immediate pass.
 */
export class IntegrityProofScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: IntegrityProofSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    if (this.opts.runOnStart !== false) void this.runOnce();
    this.handle = this.scheduler().setInterval(() => void this.runOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  /** One proof pass over every scope. Never rejects — a per-scope error is captured + routed. */
  async runOnce(): Promise<readonly IntegrityProofPassResult[]> {
    const results: IntegrityProofPassResult[] = [];
    let scopes: readonly (string | null)[];
    try {
      scopes = await this.opts.scopes();
    } catch (err) {
      this.opts.onError?.(err);
      return results;
    }
    for (const scope of scopes) {
      try {
        const report = await this.opts.prove(scope);
        if (isEmptyScope(report)) {
          results.push({ scope, outcome: "skipped_empty" });
          continue;
        }
        this.opts.onPass?.(report);
        if (report.verdict === "compromised") this.opts.onFinding?.(report);
        const recorded = await this.opts.record?.(report);
        results.push({
          scope,
          outcome: "proved",
          report,
          ...(recorded !== undefined ? { recordedAt: recorded } : {}),
        });
      } catch (err) {
        this.opts.onError?.(err);
        results.push({ scope, outcome: "error", error: err });
      }
    }
    return results;
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}

/** Nothing to prove and nothing to record: no chain entries, and no audit rows claiming any. */
function isEmptyScope(report: IntegrityProofReport): boolean {
  // Keyed on the tail, NOT on how many signatures the chain half checked. In
  // `from_checkpoint` mode that count covers only the suffix after the checkpoint, so it is
  // legitimately 0 for a chain with plenty of entries once a checkpoint catches up to the tail
  // — and treating that as empty would silently stop proving the scope altogether.
  const chainEmpty = report.truncation.tailSequence === null;
  return chainEmpty && (report.anchors === null || report.anchors.checked === 0);
}

export function formatIntegrityProof(report: IntegrityProofReport): string {
  const scope = report.scope ?? "platform";
  const lines = [`audit integrity for ${scope}: ${report.verdict.toUpperCase()}`];
  lines.push(
    `  chain [${report.chain.mode}]: integrity ${report.chain.integrity.valid ? "valid" : `BROKEN at ${String(report.chain.integrity.brokenAt)}`}` +
      `, signatures ${report.chain.signatures.valid ? "valid" : "INVALID"}` +
      ` (${report.chain.signatures.checked.toString()} checked)`,
  );
  if (report.truncation.truncated) {
    lines.push(
      `  TRUNCATED: checkpoint at ${String(report.truncation.checkpointSequence)}` +
        ` but the chain ends at ${String(report.truncation.tailSequence)}`,
    );
  } else if (report.truncation.checkpointSequence === null) {
    // Worth saying out loud: without a checkpoint the truncation check cannot run at all.
    lines.push("  truncation: not checkable (no checkpoint yet — run the checkpoint scheduler)");
  }
  if (report.anchors !== null) {
    lines.push(
      `  anchors: checked ${report.anchors.checked.toString()}` +
        `, verified ${report.anchors.verified.toString()}` +
        `, unanchored ${report.anchors.unanchored.toString()}` +
        `, tampered ${report.anchors.tampered.length.toString()}`,
    );
    for (const t of report.anchors.tampered) {
      lines.push(`    ${t.verdict}: audit ${t.auditId}`);
    }
  }
  return lines.join("\n");
}

export interface IntegrityProofLifecycleOptions {
  readonly signer: ChainSigner;
  readonly registry: PostgresKeyRegistry;
  readonly scheduler?: IntervalScheduler;
  /** Overrides the config's static tenant list with a live source (may include `null`). */
  readonly tenants?: IntegrityScopeSource;
  readonly runOnStart?: boolean;
  readonly onPass?: (report: IntegrityProofReport) => void;
  readonly onFinding?: (report: IntegrityProofReport) => void;
  readonly onError?: (err: unknown) => void;
  readonly now?: () => Date;
}

export interface IntegrityProofLifecycle {
  readonly scheduler: IntegrityProofScheduler;
  runOnce(): Promise<readonly IntegrityProofPassResult[]>;
}

/** The scopes from a static config: its tenant ids, plus the platform chain when opted in. */
export function integrityConfigScopes(
  config: IntegrityProofConfig,
): readonly (string | null)[] {
  const scopes: (string | null)[] = [...config.tenants];
  if (config.includePlatform) scopes.push(null);
  return scopes;
}

export function buildIntegrityProofLifecycle(
  conn: PgConnection,
  config: IntegrityProofConfig,
  opts: IntegrityProofLifecycleOptions,
): IntegrityProofLifecycle {
  const logStore = new PostgresChainLogStore(conn, opts.signer, { schema: config.schema });
  const checkpoints = new PostgresChainCheckpointStore(conn, { schema: config.schema });
  // A reader, not the anchoring emitter: this verifies what was written, and must never write.
  const audit = new PostgresAuditEmitter(conn, { schema: config.schema });
  const scopes: IntegrityScopeSource = opts.tenants ?? (() => integrityConfigScopes(config));
  const now = opts.now ?? ((): Date => new Date());

  const scheduler = new IntegrityProofScheduler({
    prove: (scope) =>
      proveScopeIntegrity(scope, {
        logStore,
        checkpoints,
        registry: opts.registry,
        audit,
        auditRowLimit: config.auditRowLimit,
        fromCheckpoint: config.fromCheckpoint,
        now,
      }),
    ...(config.recordVerdict
      ? {
          record: async (report: IntegrityProofReport): Promise<number> => {
            const entry = await logStore.append({
              tenantId: report.scope,
              kind: "security_event",
              actorReference: config.verifiedBy,
              recordedAt: report.verifiedAt,
              payload: integrityVerdictPayload(report),
            });
            return entry.sequenceNumber;
          },
        }
      : {}),
    scopes,
    intervalMs: config.intervalMs,
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    ...(opts.runOnStart !== undefined ? { runOnStart: opts.runOnStart } : {}),
    ...(opts.onPass !== undefined ? { onPass: opts.onPass } : {}),
    ...(opts.onFinding !== undefined ? { onFinding: opts.onFinding } : {}),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });

  return { scheduler, runOnce: () => scheduler.runOnce() };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
