import type { PgConnection } from "@crossengin/kernel-pg";

const SCHEMA = "meta";

export class WorkflowInstanceIdResolver {
  private readonly conn: PgConnection;
  private readonly cache: Map<string, string> = new Map();

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  register(instanceId: string, uuid: string): void {
    this.cache.set(instanceId, uuid);
  }

  invalidate(instanceId: string): void {
    this.cache.delete(instanceId);
  }

  async resolve(instanceId: string): Promise<string | null> {
    const cached = this.cache.get(instanceId);
    if (cached !== undefined) return cached;
    const result = await this.conn.query<{ id: string }>(
      `SELECT id FROM ${SCHEMA}.workflow_instances WHERE instance_id = $1 LIMIT 1`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    this.cache.set(instanceId, row.id);
    return row.id;
  }

  async requireResolve(instanceId: string): Promise<string> {
    const uuid = await this.resolve(instanceId);
    if (uuid === null) {
      throw new Error(`workflow instance not found in database: ${instanceId}`);
    }
    return uuid;
  }

  size(): number {
    return this.cache.size;
  }
}

export class WorkflowDefinitionIdResolver {
  private readonly conn: PgConnection;
  private readonly cache: Map<string, string> = new Map();

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  register(definitionId: string, uuid: string): void {
    this.cache.set(definitionId, uuid);
  }

  invalidate(definitionId: string): void {
    this.cache.delete(definitionId);
  }

  async resolve(definitionId: string): Promise<string | null> {
    const cached = this.cache.get(definitionId);
    if (cached !== undefined) return cached;
    const result = await this.conn.query<{ id: string }>(
      `SELECT id FROM ${SCHEMA}.workflow_definitions WHERE definition_id = $1 LIMIT 1`,
      [definitionId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    this.cache.set(definitionId, row.id);
    return row.id;
  }

  async requireResolve(definitionId: string): Promise<string> {
    const uuid = await this.resolve(definitionId);
    if (uuid === null) {
      throw new Error(`workflow definition not found in database: ${definitionId}`);
    }
    return uuid;
  }

  size(): number {
    return this.cache.size;
  }
}
