import { createHash } from "node:crypto";

/** The default advisory-lock namespace serializing the workflow tick across worker processes. */
export const DEFAULT_WORKFLOW_TICK_NAMESPACE = "crossengin.workflow.tick";

/**
 * Derives a stable Postgres advisory-lock key (a **signed** 64-bit bigint, which
 * is what `pg_advisory_lock` takes) from a namespace string. All worker
 * processes that pass the same namespace contend for the same lock, so only one
 * runs the tick at a time; a different namespace (e.g. per shard) is an
 * independent lock.
 */
export function advisoryLockKey(namespace: string): bigint {
  const digest = createHash("sha256").update(namespace).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}
