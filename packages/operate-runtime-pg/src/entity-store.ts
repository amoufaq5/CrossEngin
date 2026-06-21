import type { PgConnection } from "@crossengin/kernel-pg";
import {
  type EntityRecord,
  type EntityStore,
  type ListPage,
  type ListQuery,
  type TransactionalEntityStore,
} from "@crossengin/operate-runtime";

import { createOp, getOp, listOp, listPageOp, removeOp, updateOp } from "./entity-ops.js";
import { withTenantContext } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export interface PostgresEntityStoreOptions {
  /** Schema holding `operate_entity_records` (default `meta`). */
  readonly schema?: string;
}

/**
 * EntityStore bound to a single open transaction (`tx`) and tenant. The tenant
 * RLS context is already set by `withTransaction`, so each op runs on the shared
 * connection without opening a new transaction — letting a handler's guard →
 * write → effect sequence commit (or roll back) as one unit. A call for a
 * different tenant than the bound one is rejected (RLS would deny it anyway).
 */
class TxEntityStore implements EntityStore {
  constructor(
    private readonly tx: PgConnection,
    private readonly table: string,
    private readonly boundTenant: string,
  ) {}

  private assertTenant(tenantId: string): void {
    if (tenantId !== this.boundTenant) {
      throw new Error("cross-tenant access inside a transaction is not allowed");
    }
  }

  list(tenantId: string, entity: string): Promise<readonly EntityRecord[]> {
    this.assertTenant(tenantId);
    return listOp(this.tx, this.table, tenantId, entity);
  }

  listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    this.assertTenant(tenantId);
    return listPageOp(this.tx, this.table, tenantId, entity, query);
  }

  get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
    this.assertTenant(tenantId);
    return getOp(this.tx, this.table, tenantId, entity, id);
  }

  create(tenantId: string, entity: string, record: EntityRecord): Promise<EntityRecord> {
    this.assertTenant(tenantId);
    return createOp(this.tx, this.table, tenantId, entity, record);
  }

  update(tenantId: string, entity: string, id: string, patch: EntityRecord): Promise<EntityRecord | null> {
    this.assertTenant(tenantId);
    return updateOp(this.tx, this.table, tenantId, entity, id, patch);
  }

  remove(tenantId: string, entity: string, id: string): Promise<boolean> {
    this.assertTenant(tenantId);
    return removeOp(this.tx, this.table, tenantId, entity, id);
  }
}

/**
 * Postgres-backed `EntityStore` over `meta.operate_entity_records` — a
 * tenant-scoped JSONB document table under row-level security. Every operation
 * runs through `withTenantContext`, so the RLS policy (not just the `WHERE
 * tenant_id = $1` clause) confines the query to the caller's tenant. Records are
 * stored as a `document` JSONB blob keyed by `(tenant_id, entity, record_id)`.
 * Implements `TransactionalEntityStore`, so the serving runtime can run a write
 * + its guards + its effects (e.g. an auto-reversal) atomically.
 */
export class PostgresEntityStore implements TransactionalEntityStore {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: PostgresEntityStoreOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    }
    this.table = `${schema}.operate_entity_records`;
  }

  list(tenantId: string, entity: string): Promise<readonly EntityRecord[]> {
    return withTenantContext(this.conn, tenantId, (tx) => listOp(tx, this.table, tenantId, entity));
  }

  listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    return withTenantContext(this.conn, tenantId, (tx) => listPageOp(tx, this.table, tenantId, entity, query));
  }

  get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
    return withTenantContext(this.conn, tenantId, (tx) => getOp(tx, this.table, tenantId, entity, id));
  }

  create(tenantId: string, entity: string, record: EntityRecord): Promise<EntityRecord> {
    return withTenantContext(this.conn, tenantId, (tx) => createOp(tx, this.table, tenantId, entity, record));
  }

  update(tenantId: string, entity: string, id: string, patch: EntityRecord): Promise<EntityRecord | null> {
    return withTenantContext(this.conn, tenantId, (tx) => updateOp(tx, this.table, tenantId, entity, id, patch));
  }

  remove(tenantId: string, entity: string, id: string): Promise<boolean> {
    return withTenantContext(this.conn, tenantId, (tx) => removeOp(tx, this.table, tenantId, entity, id));
  }

  /** Runs `fn` in one tenant-scoped transaction; every op on the supplied store shares it. */
  withTransaction<T>(tenantId: string, fn: (tx: EntityStore) => Promise<T>): Promise<T> {
    return withTenantContext(this.conn, tenantId, (tx) => fn(new TxEntityStore(tx, this.table, tenantId)));
  }

  /** Admin/audit count of records for one entity in a tenant (not part of `EntityStore`). */
  async count(tenantId: string, entity: string): Promise<number> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${this.table} WHERE tenant_id = $1 AND entity = $2`,
        [tenantId, entity],
      );
      return Number(res.rows[0]?.n ?? "0");
    });
  }
}
