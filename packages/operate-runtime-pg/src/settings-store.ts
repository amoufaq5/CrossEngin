import type { PgConnection } from "@crossengin/kernel-pg";
import {
  EMPTY_TENANT_SETTINGS,
  TenantSettingsSchema,
  mergeUnsetFinanceAccountCodes,
  type FinanceAccountCodeFiller,
  type FinanceAccountCodeFill,
  type FinanceAccountCodeKey,
  type SettingsStore,
  type TenantSettings,
} from "@crossengin/operate-runtime";

import { withTenantContext } from "./tenant-context.js";

/**
 * Persists per-tenant operational settings as a singleton JSONB document in
 * `meta.operate_tenant_settings`, one row per tenant, confined by RLS. Reads
 * validate the stored document so a hand-edited row can't widen the contract.
 */
export class PostgresSettingsStore implements SettingsStore, FinanceAccountCodeFiller {
  constructor(
    private readonly conn: PgConnection,
    private readonly schema = "meta",
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
  }

  async get(tenantId: string): Promise<TenantSettings> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<{ settings: unknown }>(
        `SELECT settings FROM ${this.schema}.operate_tenant_settings WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      const raw = res.rows[0]?.settings;
      if (raw === undefined || raw === null) return EMPTY_TENANT_SETTINGS;
      const parsed = TenantSettingsSchema.safeParse(storedDocument(raw));
      return parsed.success ? parsed.data : EMPTY_TENANT_SETTINGS;
    });
  }

  async put(
    tenantId: string,
    settings: TenantSettings,
    updatedBy: string | null = null,
  ): Promise<TenantSettings> {
    // Parsed before the transaction opens, as it was before `putWithin` existed: an invalid
    // document costs no round trip. `putWithin` parses again, which is idempotent.
    const parsed = TenantSettingsSchema.parse(settings);
    return withTenantContext(this.conn, tenantId, (tx) =>
      this.putWithin(tx, tenantId, parsed, updatedBy),
    );
  }

  /**
   * The `put` statement inside a transaction the caller holds, for a write that
   * must commit with others (an approved access request creates the tenant and
   * its settings together). The caller must already have set this tenant's
   * context on `tx`: the table's isolation policy is its only write arm.
   */
  async putWithin(
    tx: PgConnection,
    tenantId: string,
    settings: TenantSettings,
    updatedBy: string | null = null,
  ): Promise<TenantSettings> {
    const parsed = TenantSettingsSchema.parse(settings);
    await tx.query(
      `INSERT INTO ${this.schema}.operate_tenant_settings
         (tenant_id, settings, updated_at, updated_by)
       VALUES ($1::uuid, $2::jsonb, now(), $3)
       ON CONFLICT (tenant_id)
       DO UPDATE SET settings = EXCLUDED.settings, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [tenantId, JSON.stringify(parsed), updatedBy],
    );
    return parsed;
  }

  /**
   * Fills only the finance account-code keys that are unset, under a row lock, so an admin's code
   * written between this read and this write cannot be replaced (a get-then-put by the caller
   * could). A stored document the contract no longer accepts is **refused** rather than read as
   * empty the way `get` reads it: writing a merge of `{}` over an unreadable row would replace every
   * setting the tenant has with the few this fills.
   */
  async fillUnsetFinanceAccountCodes(
    tenantId: string,
    codes: Readonly<Partial<Record<FinanceAccountCodeKey, string>>>,
    updatedBy: string | null = null,
  ): Promise<FinanceAccountCodeFill> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      // Two passes at most: a tenant with no settings row has nothing to lock, so the row is
      // inserted with `DO NOTHING`, and losing that race to another writer means the row now exists
      // and the second pass locks it instead of overwriting what that writer saved.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await tx.query<{ settings: unknown }>(
          `SELECT settings FROM ${this.schema}.operate_tenant_settings WHERE tenant_id = $1::uuid FOR UPDATE`,
          [tenantId],
        );
        const row = res.rows[0];
        if (row === undefined) {
          const merged = mergeUnsetFinanceAccountCodes(EMPTY_TENANT_SETTINGS, codes);
          if (merged.filled.length === 0) return { filled: [], inEffect: merged.inEffect };
          const inserted = await tx.query<{ tenant_id: string }>(
            `INSERT INTO ${this.schema}.operate_tenant_settings (tenant_id, settings, updated_at, updated_by)
             VALUES ($1::uuid, $2::jsonb, now(), $3)
             ON CONFLICT (tenant_id) DO NOTHING
             RETURNING tenant_id`,
            [tenantId, JSON.stringify(merged.settings), updatedBy],
          );
          if (inserted.rows.length > 0) return { filled: merged.filled, inEffect: merged.inEffect };
          continue;
        }
        let current: TenantSettings = EMPTY_TENANT_SETTINGS;
        if (row.settings !== null) {
          const parsed = TenantSettingsSchema.safeParse(storedDocument(row.settings));
          if (!parsed.success) throw new SettingsRowUnreadable(tenantId);
          current = parsed.data;
        }
        const merged = mergeUnsetFinanceAccountCodes(current, codes);
        if (merged.filled.length > 0) await this.putWithin(tx, tenantId, merged.settings, updatedBy);
        return { filled: merged.filled, inEffect: merged.inEffect };
      }
      throw new Error(`tenant ${tenantId}'s settings row appeared and disappeared during one fill`);
    });
  }
}

/**
 * The stored document, or a value the contract refuses: a text column holding malformed JSON is the
 * same "unreadable row" as a well-formed one the contract refuses, and must not escape as a raw
 * `SyntaxError` a caller cannot tell apart from a fault.
 */
function storedDocument(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** A stored settings row the contract no longer accepts; names the tenant and never the document. */
export class SettingsRowUnreadable extends Error {
  constructor(readonly tenantId: string) {
    super(`tenant ${tenantId}'s stored settings do not satisfy the settings contract`);
    this.name = "SettingsRowUnreadable";
  }
}
