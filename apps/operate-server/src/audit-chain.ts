import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { PipelineExecution } from "@crossengin/api-gateway";
import { ed25519PublicKeyFingerprint, signEd25519 } from "@crossengin/crypto";
import {
  PostgresChainLogStore,
  type ChainAppendInput,
  type ChainedLogEntry,
  type ChainSigner,
} from "@crossengin/forensics-pg";
import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export const AuditChainConfigSchema = z
  .object({
    schema: z.string().regex(SCHEMA_RE).default("meta"),
    actorReference: z.string().min(1).default("operate-server"),
    privateKeyBase64: z.string().min(1),
    publicKeyBase64: z.string().min(1),
  })
  .strict();
export type AuditChainConfig = z.infer<typeof AuditChainConfigSchema>;

export function parseAuditChainConfig(json: unknown): AuditChainConfig {
  return AuditChainConfigSchema.parse(json);
}

export async function loadAuditChainConfig(path: string): Promise<AuditChainConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--audit-chain-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--audit-chain-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return parseAuditChainConfig(parsed);
}

/** A `ChainSigner` backed directly by an Ed25519 keypair (no key store needed for the serving edge). */
export function ed25519ChainSigner(keypair: {
  readonly privateKeyBase64: string;
  readonly publicKeyBase64: string;
}): ChainSigner {
  return {
    fingerprint: ed25519PublicKeyFingerprint(keypair.publicKeyBase64),
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

export interface AuditChainObserverOptions {
  readonly onAppend?: (entry: ChainedLogEntry) => void;
  readonly onError?: (err: unknown) => void;
}

/**
 * Appends one `audit_event` chain entry per completed request. Appends are pushed through an internal
 * promise queue so they run strictly one-at-a-time — the hash chain must be linear, and serializing here
 * keeps ordering deterministic and avoids piling concurrent transactions onto the per-tenant advisory
 * lock. The queue never rejects (both outcomes are handled), so one failed append never stalls the next.
 */
export class AuditChainObserver {
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;

  constructor(
    private readonly store: PostgresChainLogStore,
    private readonly config: AuditChainConfig,
    private readonly opts: AuditChainObserverOptions = {},
  ) {}

  record(execution: PipelineExecution): void {
    const input = auditAppendInputFrom(execution, this.config);
    this.inFlight += 1;
    this.queue = this.queue.then(async () => {
      try {
        const entry = await this.store.append(input);
        this.opts.onAppend?.(entry);
      } catch (err) {
        this.opts.onError?.(err);
      } finally {
        this.inFlight -= 1;
      }
    });
  }

  asExecutionSink(): (execution: PipelineExecution) => void {
    return (execution) => this.record(execution);
  }

  /** Resolves once every queued append has settled — for graceful shutdown / tests. */
  async drain(): Promise<void> {
    await this.queue;
  }

  pending(): number {
    return this.inFlight;
  }
}

export interface AuditChain {
  readonly observer: AuditChainObserver;
  readonly store: PostgresChainLogStore;
}

export function buildAuditChain(
  conn: PgConnection,
  config: AuditChainConfig,
  opts: AuditChainObserverOptions = {},
): AuditChain {
  const store = new PostgresChainLogStore(conn, ed25519ChainSigner(config), {
    schema: config.schema,
  });
  return { observer: new AuditChainObserver(store, config, opts), store };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
