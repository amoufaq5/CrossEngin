import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";

abstract class NaturalIdUuidResolver {
  private readonly cache: Map<string, string> = new Map();

  protected abstract readonly table: string;
  protected abstract readonly naturalColumn: string;
  protected abstract readonly kind: string;

  register(naturalId: string, uuid: string): void {
    this.cache.set(naturalId, uuid);
  }

  invalidate(naturalId: string): void {
    this.cache.delete(naturalId);
  }

  peek(naturalId: string): string | undefined {
    return this.cache.get(naturalId);
  }

  size(): number {
    return this.cache.size;
  }

  async resolve(tx: PgConnection, naturalId: string): Promise<string | null> {
    const cached = this.cache.get(naturalId);
    if (cached !== undefined) return cached;
    const result = await tx.query<{ id: string }>(
      `SELECT id FROM ${SCHEMA}.${this.table} WHERE ${this.naturalColumn} = $1 LIMIT 1`,
      [naturalId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    this.cache.set(naturalId, row.id);
    return row.id;
  }

  async requireResolve(tx: PgConnection, naturalId: string): Promise<string> {
    const uuid = await this.resolve(tx, naturalId);
    if (uuid === null) {
      throw new Error(`${this.kind} not found in database: ${naturalId}`);
    }
    return uuid;
  }
}

export class CampaignUuidResolver extends NaturalIdUuidResolver {
  protected readonly table = "access_review_campaigns";
  protected readonly naturalColumn = "campaign_id";
  protected readonly kind = "access review campaign";
}

export class ItemUuidResolver extends NaturalIdUuidResolver {
  protected readonly table = "access_review_items";
  protected readonly naturalColumn = "item_id";
  protected readonly kind = "access review item";
}
