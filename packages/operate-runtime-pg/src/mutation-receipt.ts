import type { PgConnection } from "@crossengin/kernel-pg";

/** The receipt is committed in the SAME transaction as the mutation and all financial effects. */
export async function mutationReceipt<T>(tx: PgConnection, tenantId: string, key: string, fingerprint: string, body: () => Promise<T>): Promise<T> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`mutation:${tenantId}:${key}`]);
  const found = await tx.query<{ fingerprint: string; response: T }>(
    "SELECT fingerprint, response FROM meta.operate_mutation_receipts WHERE tenant_id = $1 AND request_key = $2", [tenantId, key]);
  const prior = found.rows[0];
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw Object.assign(new Error("Idempotency key belongs to another request"), { status: 409 });
    return prior.response;
  }
  const response = await body();
  await tx.query("INSERT INTO meta.operate_mutation_receipts (tenant_id, request_key, fingerprint, response) VALUES ($1, $2, $3, $4::jsonb)", [tenantId, key, fingerprint, JSON.stringify(response)]);
  return response;
}
