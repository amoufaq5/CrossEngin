import { randomUUID } from "node:crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import { withTenantContext } from "@crossengin/operate-runtime-pg";
import type { DesignResultLike } from "./ai-design-routes.js";

function denied(status: number, message: string): Error { return Object.assign(new Error(message), { status }); }
/** dollars_used includes spent dollars AND outstanding reservations. Unknown usage stays charged. */
export class PostgresDesignReservations {
  constructor(private readonly conn: PgConnection, readonly monthlyLimit: number, readonly perRequestLimit: number, private readonly concurrentPerTenant = 2, private readonly globalSlots = 4) {
    if (![monthlyLimit, perRequestLimit].every(n => Number.isFinite(n) && n > 0) || perRequestLimit > monthlyLimit) throw new Error("Invalid AI limits");
  }
  async reserve(tenantId: string, id: string): Promise<void> {
    await withTenantContext(this.conn, tenantId, async tx => {
      const period = new Date().toISOString().slice(0, 7);
      await tx.query("INSERT INTO meta.architect_tenant_cost (tenant_id, period_key, dollars_used) VALUES ($1, $2, 0) ON CONFLICT (tenant_id, period_key) DO NOTHING", [tenantId, period]);
      await tx.query("SELECT dollars_used FROM meta.architect_tenant_cost WHERE tenant_id = $1 AND period_key = $2 FOR UPDATE", [tenantId, period]);
      const pending = await tx.query<{ count: string }>("SELECT count(*) AS count FROM meta.operate_ai_reservations WHERE tenant_id = $1 AND settled_at IS NULL AND created_at > now() - interval '15 minutes'", [tenantId]);
      if (Number(pending.rows[0]?.count ?? 0) >= this.concurrentPerTenant) throw denied(429, "Tenant AI concurrency limit reached");
      const updated = await tx.query("UPDATE meta.architect_tenant_cost SET dollars_used = dollars_used + $3::numeric, updated_at = now() WHERE tenant_id = $1 AND period_key = $2 AND dollars_used + $3::numeric <= $4::numeric RETURNING dollars_used", [tenantId, period, this.perRequestLimit, this.monthlyLimit]);
      if (!updated.rowCount) throw denied(402, "Insufficient unreserved monthly AI budget");
      await tx.query("INSERT INTO meta.operate_ai_reservations (tenant_id, id, period_key, reserved_usd) VALUES ($1, $2, $3, $4)", [tenantId, id, period, this.perRequestLimit]);
    });
  }
  async settle(tenantId: string, id: string, actual: number): Promise<void> {
    if (!Number.isFinite(actual) || actual < 0) throw new Error("Invalid actual AI cost");
    await withTenantContext(this.conn, tenantId, async tx => {
      const result = await tx.query<{ period_key: string; reserved_usd: string; settled_at: unknown }>("SELECT period_key, reserved_usd, settled_at FROM meta.operate_ai_reservations WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, id]);
      const reservation = result.rows[0];
      if (!reservation) throw new Error("AI reservation missing");
      if (reservation.settled_at !== null) return;
      // Use the reservation's month, even if the request crossed a month boundary.
      await tx.query("UPDATE meta.architect_tenant_cost SET dollars_used = dollars_used + $3::numeric - $4::numeric, updated_at = now() WHERE tenant_id = $1 AND period_key = $2", [tenantId, reservation.period_key, actual, Number(reservation.reserved_usd)]);
      await tx.query("UPDATE meta.operate_ai_reservations SET actual_usd = $3, settled_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id, actual]);
    });
  }
  async run<T extends DesignResultLike>(tenantId: string, invoke: () => Promise<T>): Promise<T> {
    if (!this.conn.tryWithAdvisoryLock) throw new Error("Distributed AI admission requires session advisory locks");
    for (let slot = 0; slot < this.globalSlots; slot++) {
      const admitted = await this.conn.tryWithAdvisoryLock(78654000n + BigInt(slot), async () => {
        const id = randomUUID();
        await this.reserve(tenantId, id);
        // A crash or failure before final usage intentionally leaves the full reservation charged.
        const result = await invoke();
        await this.settle(tenantId, id, result.usage?.cost ?? this.perRequestLimit);
        return result;
      });
      if (admitted.acquired) return admitted.result;
    }
    throw denied(429, "Global AI capacity is busy; retry later");
  }
}
