import type { PgConnection } from "@crossengin/kernel-pg";
import type {
  Entitlement,
  EntitlementResolver,
  EntitlementStatus,
} from "@crossengin/operate-runtime";

import { withTenantContext } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

const ENTITLEMENT_STATUSES: readonly EntitlementStatus[] = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "unpaid",
  "incomplete",
];

interface SubscriptionRow {
  readonly plan_id: unknown;
  readonly status: unknown;
  readonly max_records_per_entity: unknown;
  readonly features: unknown;
}

export interface PostgresEntitlementResolverOptions {
  /** Schema holding `billing_subscriptions` (default `meta`). */
  readonly schema?: string;
}

/**
 * `EntitlementResolver` backed by `meta.billing_subscriptions`. Reads the tenant's
 * most-recently-updated subscription row under RLS (via `withTenantContext`) and maps
 * it to an `Entitlement`. A tenant with no subscription row resolves to `null`, which
 * the subscription gate treats as "no entitlement" (blocks everything).
 */
export class PostgresEntitlementResolver implements EntitlementResolver {
  private readonly schema: string;

  constructor(
    private readonly conn: PgConnection,
    opts: PostgresEntitlementResolverOptions = {},
  ) {
    this.schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
  }

  async resolve(tenantId: string): Promise<Entitlement | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<SubscriptionRow>(
        `SELECT plan_id, status, max_records_per_entity, features
           FROM ${this.schema}.billing_subscriptions
          WHERE tenant_id = $1::uuid
          ORDER BY updated_at DESC
          LIMIT 1`,
        [tenantId],
      );
      const row = res.rows[0];
      if (row === undefined) return null;
      return rowToEntitlement(row);
    });
  }
}

function rowToEntitlement(row: SubscriptionRow): Entitlement {
  const status = coerceStatus(row.status);
  const entitlement: {
    status: EntitlementStatus;
    planId?: string;
    maxRecordsPerEntity?: number;
    features?: readonly string[];
  } = { status };

  if (typeof row.plan_id === "string" && row.plan_id.length > 0) {
    entitlement.planId = row.plan_id;
  }

  const cap = coerceInt(row.max_records_per_entity);
  if (cap !== undefined) {
    entitlement.maxRecordsPerEntity = cap;
  }

  const features = coerceFeatures(row.features);
  if (features !== undefined) {
    entitlement.features = features;
  }

  return entitlement;
}

function coerceStatus(value: unknown): EntitlementStatus {
  return typeof value === "string" && (ENTITLEMENT_STATUSES as readonly string[]).includes(value)
    ? (value as EntitlementStatus)
    : "incomplete";
}

function coerceInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function coerceFeatures(value: unknown): readonly string[] | undefined {
  const raw = typeof value === "string" ? safeJsonParse(value) : value;
  if (!Array.isArray(raw)) return undefined;
  const strings = raw.filter((v): v is string => typeof v === "string");
  return strings.length > 0 ? strings : undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
