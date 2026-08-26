import { sha256 } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  AudienceSchema,
  NOTIFICATION_CHANNELS,
  PreferenceMatrixEntrySchema,
  SuppressionRecordSchema,
  UserPreferenceMatrixSchema,
  type Audience,
  type NotificationChannel,
  type PreferenceMatrixEntry,
  type SuppressionRecord,
  type UserPreferenceMatrix,
} from "@crossengin/notifications";
import { withTenantContext } from "@crossengin/operate-runtime-pg";
import { z } from "zod";

import { addressFor } from "./delivery-drain.js";

export interface ResolvedRecipient {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly primaryRole: string;
  readonly secondaryRoles: readonly string[];
}

export interface RecipientIdentity {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  /** sha256 of every address this person can be reached at, across channels. */
  readonly addressHashes: readonly string[];
}

export interface RecipientResolverOptions {
  readonly schema?: string;
  /** Roles treated as a tenant's admins for the `tenant_admins` audience. */
  readonly adminRoles?: readonly string[];
}

export const DEFAULT_ADMIN_ROLES: readonly string[] = [
  "erp_admin",
  "tenant_admin",
  "platform_admin",
];

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

const RECIPIENT_COLUMNS =
  "m.user_id, u.email, u.display_name, m.primary_role, m.secondary_roles";

const IDENTITY_COLUMNS = "m.user_id, u.email, u.display_name";

const PREFERENCE_COLUMNS = "user_id, category, channel, opted_in, source, updated_at";

const SUPPRESSION_COLUMNS =
  "suppression_id, tenant_id, channel, recipient_address, reason, applied_at, applied_by," +
  " expires_at, source_delivery_id, notes";

/**
 * The drain's own admin audience: `meta.notification_dispatches.audience` carries
 * it structurally, so it never appears in `AUDIENCE_KINDS` (which models the
 * declarative notification contract, not the membership table).
 */
const TenantAdminsAudienceSchema = z.object({
  kind: z.literal("tenant_admins"),
  tenantId: z.string().uuid(),
});

type MembershipPlan =
  | { readonly kind: "roles"; readonly roles: readonly string[] }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "all" };

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  return isoOf(value);
}

function sameTenant(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function uniqueUuids(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !UUID_RE.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function rowToRecipient(row: Record<string, unknown>): ResolvedRecipient | null {
  const userId = row["user_id"];
  const email = row["email"];
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return null;
  if (typeof email !== "string" || email.length === 0) return null;
  const displayName = row["display_name"];
  const primaryRole = row["primary_role"];
  return {
    userId,
    email,
    displayName: typeof displayName === "string" ? displayName : null,
    primaryRole: typeof primaryRole === "string" ? primaryRole : "",
    secondaryRoles: toStringArray(row["secondary_roles"]),
  };
}

/**
 * INVARIANT: these are the very hashes the delivery ledger stored when it sent
 * to this person, so the set is derived by running the drain's own
 * channel→address rule over every channel rather than restating it here — if
 * `addressFor` changes, the inbox filter follows it.
 */
export function addressHashesFor(input: {
  readonly userId: string;
  readonly email: string;
}): readonly string[] {
  const recipient: ResolvedRecipient = {
    userId: input.userId,
    email: input.email,
    displayName: null,
    primaryRole: "",
    secondaryRoles: [],
  };
  const hashes = new Set<string>();
  for (const channel of NOTIFICATION_CHANNELS) {
    const address = addressFor(channel, recipient);
    if (typeof address !== "string" || address.length === 0) continue;
    hashes.add(sha256(address));
  }
  return [...hashes].sort();
}

function rowToIdentity(row: Record<string, unknown>): RecipientIdentity | null {
  const userId = row["user_id"];
  const email = row["email"];
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return null;
  if (typeof email !== "string" || email.length === 0) return null;
  const displayName = row["display_name"];
  return {
    userId,
    email,
    displayName: typeof displayName === "string" ? displayName : null,
    addressHashes: addressHashesFor({ userId, email }),
  };
}

function rowToPreferenceEntry(row: Record<string, unknown>): PreferenceMatrixEntry | null {
  const parsed = PreferenceMatrixEntrySchema.safeParse({
    category: row["category"],
    channel: row["channel"],
    optedIn: row["opted_in"] === true,
    updatedAt: isoOrNull(row["updated_at"]) ?? EPOCH_ISO,
    source: row["source"],
  });
  return parsed.success ? parsed.data : null;
}

function buildMatrix(
  userId: string,
  tenantId: string,
  entries: readonly PreferenceMatrixEntry[],
): UserPreferenceMatrix | null {
  const updatedAt = entries.reduce<string>(
    (acc, e) => (Date.parse(e.updatedAt) > Date.parse(acc) ? e.updatedAt : acc),
    EPOCH_ISO,
  );
  const full = UserPreferenceMatrixSchema.safeParse({ userId, tenantId, entries, updatedAt });
  if (full.success) return full.data;
  const empty = UserPreferenceMatrixSchema.safeParse({
    userId,
    tenantId,
    entries: [],
    updatedAt: EPOCH_ISO,
  });
  return empty.success ? empty.data : null;
}

/**
 * Turns a dispatch's structural audience into concrete, addressable recipients
 * plus the preference and suppression facts the eligibility rules consume.
 * Recipient identities are deliberately never persisted on the dispatch, so the
 * drain re-derives them here under the caller's tenant.
 *
 * Both tenant-scoped tables carry RLS, so every method runs inside
 * `withTenantContext` (which binds `app.current_tenant_id` for the transaction)
 * AND binds `tenant_id = $1` as an explicit predicate — defense in depth. The
 * schema name is the only interpolated identifier; every value rides as a bound
 * parameter, including the role list (`$n::text[]`), the user id list
 * (`$n::uuid[]`) and `now`.
 */
export class PostgresRecipientResolver {
  private readonly conn: PgConnection;
  private readonly schema: string;
  private readonly adminRoles: readonly string[];

  constructor(conn: PgConnection, opts: RecipientResolverOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
    this.adminRoles = opts.adminRoles ?? DEFAULT_ADMIN_ROLES;
  }

  private get membershipTable(): string {
    return `${this.schema}.user_tenant_membership`;
  }

  private get usersTable(): string {
    return `${this.schema}.users`;
  }

  private get preferencesTable(): string {
    return `${this.schema}.notification_preferences`;
  }

  private get suppressionsTable(): string {
    return `${this.schema}.notification_suppressions`;
  }

  /**
   * INVARIANT: an audience the drain cannot understand resolves to "nobody to
   * notify" — never an exception, and never a widened query. The value comes
   * from a JSONB column written by another process, so an unrecognised kind, a
   * malformed shape, or a tenant id other than the caller's all degrade to an
   * empty plan rather than crashing the drain or leaking another tenant's
   * members.
   */
  private planFor(tenantId: string, audience: unknown): MembershipPlan | null {
    if (typeof audience !== "object" || audience === null) return null;
    const admins = TenantAdminsAudienceSchema.safeParse(audience);
    if (admins.success) {
      if (!sameTenant(tenantId, admins.data.tenantId)) return null;
      return { kind: "roles", roles: this.adminRoles };
    }
    const parsed = AudienceSchema.safeParse(audience);
    if (!parsed.success) return null;
    const declared: Audience = parsed.data;
    switch (declared.kind) {
      case "role_in_tenant":
        if (!sameTenant(tenantId, declared.tenantId)) return null;
        return { kind: "roles", roles: [declared.roleSlug] };
      case "tenant_all_users":
        if (!sameTenant(tenantId, declared.tenantId)) return null;
        return { kind: "all" };
      case "specific_user":
        return { kind: "user", userId: declared.userId };
      default:
        return null;
    }
  }

  private membershipQuery(
    tenantId: string,
    plan: MembershipPlan,
  ): { sql: string; params: readonly unknown[] } {
    const params: unknown[] = [tenantId];
    const conditions: string[] = ["m.tenant_id = $1", "m.status = 'active'", "u.status = 'active'"];
    if (plan.kind === "roles") {
      params.push([...plan.roles]);
      const n = params.length;
      conditions.push(`(m.primary_role = ANY($${n}::text[]) OR m.secondary_roles && $${n}::text[])`);
    } else if (plan.kind === "user") {
      params.push(plan.userId);
      conditions.push(`m.user_id = $${params.length}::uuid`);
    }
    const sql =
      `SELECT ${RECIPIENT_COLUMNS} FROM ${this.membershipTable} m` +
      ` JOIN ${this.usersTable} u ON u.id = m.user_id` +
      ` WHERE ${conditions.join(" AND ")}` +
      " ORDER BY u.email, m.user_id";
    return { sql, params };
  }

  async resolveAudience(
    tenantId: string,
    audience: unknown,
  ): Promise<readonly ResolvedRecipient[]> {
    const plan = this.planFor(tenantId, audience);
    if (plan === null) return [];
    if (plan.kind === "roles" && plan.roles.length === 0) return [];
    const { sql, params } = this.membershipQuery(tenantId, plan);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(sql, params);
      const seen = new Set<string>();
      const recipients: ResolvedRecipient[] = [];
      for (const row of result.rows) {
        const recipient = rowToRecipient(row);
        if (recipient === null || seen.has(recipient.userId)) continue;
        seen.add(recipient.userId);
        recipients.push(recipient);
      }
      return recipients;
    });
  }

  private get identityQuery(): string {
    return (
      `SELECT ${IDENTITY_COLUMNS} FROM ${this.membershipTable} m` +
      ` JOIN ${this.usersTable} u ON u.id = m.user_id` +
      " WHERE m.tenant_id = $1 AND m.status = 'active' AND u.status = 'active'" +
      " AND m.user_id = ANY($2::uuid[])" +
      " ORDER BY u.email, m.user_id"
    );
  }

  /**
   * INVARIANT: an identity is only returned for an active member of THIS
   * tenant, so a caller can never turn another tenant's user id into the
   * address hashes that would unlock that person's delivery rows.
   */
  async identityFor(tenantId: string, userId: string): Promise<RecipientIdentity | null> {
    const identities = await this.identitiesFor(tenantId, [userId]);
    return identities.get(userId) ?? null;
  }

  async identitiesFor(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, RecipientIdentity>> {
    const ids = uniqueUuids(userIds);
    const identities = new Map<string, RecipientIdentity>();
    if (ids.length === 0) return identities;
    const sql = this.identityQuery;
    const rows = await withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(sql, [tenantId, [...ids]]);
      return result.rows;
    });
    for (const row of rows) {
      const identity = rowToIdentity(row);
      if (identity === null || identities.has(identity.userId)) continue;
      identities.set(identity.userId, identity);
    }
    return identities;
  }

  async preferencesFor(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, UserPreferenceMatrix>> {
    const ids = uniqueUuids(userIds);
    const matrices = new Map<string, UserPreferenceMatrix>();
    if (ids.length === 0) return matrices;
    const sql =
      `SELECT ${PREFERENCE_COLUMNS} FROM ${this.preferencesTable}` +
      " WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])" +
      " ORDER BY user_id, category, channel";
    const rows = await withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(sql, [tenantId, [...ids]]);
      return result.rows;
    });
    const byUser = new Map<string, Map<string, PreferenceMatrixEntry>>();
    for (const row of rows) {
      const userId = row["user_id"];
      if (typeof userId !== "string") continue;
      const entry = rowToPreferenceEntry(row);
      if (entry === null) continue;
      const bucket = byUser.get(userId) ?? new Map<string, PreferenceMatrixEntry>();
      bucket.set(`${entry.category}|${entry.channel}`, entry);
      byUser.set(userId, bucket);
    }
    for (const userId of ids) {
      const entries = [...(byUser.get(userId)?.values() ?? [])];
      const matrix = buildMatrix(userId, tenantId, entries);
      if (matrix !== null) matrices.set(userId, matrix);
    }
    return matrices;
  }

  async activeSuppressions(
    tenantId: string,
    channel: NotificationChannel,
    now: Date,
  ): Promise<readonly SuppressionRecord[]> {
    const sql =
      `SELECT ${SUPPRESSION_COLUMNS} FROM ${this.suppressionsTable}` +
      " WHERE tenant_id = $1 AND channel = $2 AND (expires_at IS NULL OR expires_at > $3)" +
      " ORDER BY applied_at DESC, suppression_id";
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query(sql, [tenantId, channel, now.toISOString()]);
      const records: SuppressionRecord[] = [];
      for (const row of result.rows) {
        const parsed = SuppressionRecordSchema.safeParse({
          id: row["suppression_id"],
          tenantId: row["tenant_id"],
          channel: row["channel"],
          recipientAddress: row["recipient_address"],
          reason: row["reason"],
          appliedAt: isoOrNull(row["applied_at"]) ?? EPOCH_ISO,
          appliedBy: row["applied_by"] == null ? null : String(row["applied_by"]),
          expiresAt: isoOrNull(row["expires_at"]),
          sourceDeliveryId:
            row["source_delivery_id"] == null ? null : String(row["source_delivery_id"]),
          notes: row["notes"] == null ? undefined : String(row["notes"]),
        });
        if (parsed.success) records.push(parsed.data);
      }
      return records;
    });
  }
}
