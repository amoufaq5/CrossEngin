import type { PgConnection } from "@crossengin/kernel-pg";
import { LIFECYCLE_ACTIONS, type LifecycleEvent } from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_ACTION_PRODUCERS,
  LIFECYCLE_EVENT_COLUMNS,
  LIFECYCLE_EVENT_MAX_LIMIT,
  LIFECYCLE_EVENT_REFUSALS,
  LIFECYCLE_TRAIL_VERDICTS,
  LifecycleEventRefused,
  PostgresLifecycleEventStore,
  assertAppendOnlyStatement,
  lifecycleEventFor,
  lifecycleTrailGaps,
  probeLifecycleTrail,
  readTenantState,
  rowToLifecycleEvent,
  transitionWasLegal,
} from "./lifecycle-event-store.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const EVENT_ID = "0193a0f1-2222-7333-8444-555566667777";
const ACTOR = "11111111-1111-4111-8111-111111111111";
const APPROVER = "22222222-2222-4222-8222-222222222222";
const AT = "2026-10-05T12:00:00.000Z";

interface Fake {
  readonly conn: PgConnection;
  readonly calls: { sql: string; params: readonly unknown[] }[];
  readonly sql: () => string[];
}

/**
 * A fake that records `{sql, params}` and **throws on an unscoped tenant read**, which is the
 * tripwire ADR-0334 added to three sibling fakes: a fake that answers a statement it could not
 * really serve is a test asserting the wrong thing. The exemptions are named rather than inferred —
 * the cross-tenant `deletedTenants` sweep and the probe's catalog queries genuinely carry no
 * `tenant_id`, and both say so at their call sites.
 */
function fakePg(rows: readonly Record<string, unknown>[] = [], opts: { readonly allowUnscoped?: boolean } = {}): Fake {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (
        opts.allowUnscoped !== true &&
        sql.includes("tenant_lifecycle_events") &&
        sql.trim().toUpperCase().startsWith("SELECT") &&
        !sql.includes("tenant_id")
      ) {
        throw new Error(`unscoped read of tenant_lifecycle_events: ${sql}`);
      }
      if (sql.trim().toUpperCase().startsWith("SELECT")) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      calls.push({ sql: "BEGIN", params: [] });
      const out = await fn(conn);
      calls.push({ sql: "COMMIT", params: [] });
      return out;
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls, sql: () => calls.map((c) => c.sql) };
}

function eventOf(over: Partial<LifecycleEvent> = {}): LifecycleEvent {
  return {
    ...lifecycleEventFor({
      id: EVENT_ID,
      tenantId: TENANT,
      action: "execute_deletion",
      fromState: "pending_deletion",
      trigger: "customer_request",
      occurredAt: AT,
      reason: "article 17 right to erasure",
      actorUserId: ACTOR,
      approvedByUserId: APPROVER,
      approvedAt: AT,
    }),
    ...over,
  };
}

function rowOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  const e = eventOf();
  return {
    id: e.id,
    tenant_id: e.tenantId,
    action: e.action,
    from_state: e.fromState,
    to_state: e.toState,
    trigger: e.trigger,
    occurred_at: new Date(e.occurredAt),
    actor_user_id: e.actorUserId,
    actor_system_id: e.actorSystemId,
    reason: e.reason,
    customer_notified_at: null,
    notification_channel: e.notificationChannel,
    requires_four_eyes_approval: e.requiresFourEyesApproval,
    approved_by_user_id: e.approvedByUserId,
    approved_at: new Date(AT),
    related_incident_id: null,
    notes: null,
    ...over,
  };
}

describe("constants", () => {
  it("names the columns the catalog declares, with the real check one level up", () => {
    // A literal rather than a runtime read of `META_TABLES`, because the catalog is not re-exported
    // from `@crossengin/kernel`'s index — which is itself deliberate, and is why
    // `packages/testing/src/strategy/pg-column-coverage.ts` reads it from disk as text. That rule is
    // where ADR-0332's assertion actually lives, and it passes all three of this store's statements:
    // every column exists and the INSERT names every `notNull`-with-no-default one. This is the
    // floor beneath it.
    expect(new Set(LIFECYCLE_EVENT_COLUMNS).size).toBe(LIFECYCLE_EVENT_COLUMNS.length);
    expect(LIFECYCLE_EVENT_COLUMNS).toHaveLength(17);
    expect(LIFECYCLE_EVENT_COLUMNS).toContain("tenant_id");
    expect(LIFECYCLE_EVENT_COLUMNS).toContain("from_state");
    expect(LIFECYCLE_EVENT_COLUMNS).toContain("to_state");
    expect(LIFECYCLE_EVENT_COLUMNS).toContain("requires_four_eyes_approval");
  });

  it("names every notNull-with-no-default column, so the INSERT cannot omit one", () => {
    for (const required of ["tenant_id", "action", "from_state", "to_state", "trigger", "reason"]) {
      expect(LIFECYCLE_EVENT_COLUMNS).toContain(required);
    }
  });

  it("declares a producer for every lifecycle action", () => {
    for (const action of LIFECYCLE_ACTIONS) {
      expect(LIFECYCLE_ACTION_PRODUCERS[action]).toBeTypeOf("string");
      expect(LIFECYCLE_ACTION_PRODUCERS[action].length).toBeGreaterThan(0);
    }
    expect(Object.keys(LIFECYCLE_ACTION_PRODUCERS).sort()).toEqual([...LIFECYCLE_ACTIONS].sort());
  });

  it("names cancel_deletion as the one action with no producer", () => {
    // Not a to-do: it targets `archived`, and the only route that un-schedules a deletion returns
    // the tenant to `active`, which is `restore`.
    expect(lifecycleTrailGaps()).toEqual(["cancel_deletion"]);
  });

  it("has four trail verdicts and a bounded page size", () => {
    expect(LIFECYCLE_TRAIL_VERDICTS).toHaveLength(4);
    expect(LIFECYCLE_EVENT_MAX_LIMIT).toBe(500);
    expect(LIFECYCLE_EVENT_REFUSALS).toContain("not_append_only");
  });
});

describe("assertAppendOnlyStatement", () => {
  it("accepts a plain INSERT", () => {
    expect(() =>
      assertAppendOnlyStatement("INSERT INTO meta.tenant_lifecycle_events (id) VALUES ($1)"),
    ).not.toThrow();
  });

  it("accepts ON CONFLICT DO NOTHING, which leaves a recorded row exactly as it was", () => {
    expect(() =>
      assertAppendOnlyStatement("INSERT INTO t (id) VALUES ($1) ON CONFLICT (id) DO NOTHING"),
    ).not.toThrow();
  });

  it("refuses ON CONFLICT DO UPDATE — an append in its syntax, a rewrite in its effect", () => {
    expect(() =>
      assertAppendOnlyStatement("INSERT INTO t (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET r=$2"),
    ).toThrow(LifecycleEventRefused);
  });

  it("refuses an UPDATE and a DELETE", () => {
    expect(() => assertAppendOnlyStatement("UPDATE meta.tenant_lifecycle_events SET reason=$1")).toThrow(
      /append-only/,
    );
    expect(() => assertAppendOnlyStatement("DELETE FROM meta.tenant_lifecycle_events")).toThrow(
      /append-only/,
    );
  });

  it("is not fooled by leading whitespace or case", () => {
    expect(() => assertAppendOnlyStatement("\n  insert into t (a) values ($1)")).not.toThrow();
    expect(() => assertAppendOnlyStatement("  delete from t")).toThrow(/append-only/);
  });

  it("names the refusal so a caller can branch on it", () => {
    try {
      assertAppendOnlyStatement("TRUNCATE meta.tenant_lifecycle_events");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(LifecycleEventRefused);
      expect((err as LifecycleEventRefused).refusal).toBe("not_append_only");
    }
  });
});

describe("lifecycleEventFor", () => {
  it("derives toState from ACTION_TARGET_STATE rather than accepting it", () => {
    const e = lifecycleEventFor({
      id: EVENT_ID,
      tenantId: TENANT,
      action: "suspend",
      fromState: "active",
      trigger: "billing_failure",
      occurredAt: AT,
      reason: "payment failed three times",
      actorSystemId: "operate-server",
    });
    expect(e.toState).toBe("suspended");
  });

  it("derives requiresFourEyesApproval from actionRequiresFourEyes", () => {
    const e = lifecycleEventFor({
      id: EVENT_ID,
      tenantId: TENANT,
      action: "archive",
      fromState: "active",
      trigger: "compliance_directive",
      occurredAt: AT,
      reason: "regulator directive",
      actorUserId: ACTOR,
      approvedByUserId: APPROVER,
      approvedAt: AT,
      relatedIncidentId: "INC-2026-0001",
    });
    // `archive` + `compliance_directive` is one of the two pairs the contract's own helper demands
    // approval for and the schema does not — so deriving it is what makes the rule reach the row.
    expect(e.requiresFourEyesApproval).toBe(true);
  });

  it("leaves four-eyes off where the rule does not demand it", () => {
    const e = lifecycleEventFor({
      id: EVENT_ID,
      tenantId: TENANT,
      action: "suspend",
      fromState: "active",
      trigger: "billing_failure",
      occurredAt: AT,
      reason: "arrears",
      actorSystemId: "operate-server",
    });
    expect(e.requiresFourEyesApproval).toBe(false);
    expect(e.approvedByUserId).toBeNull();
  });

  it("refuses an action/trigger pair that needs an incident and has none", () => {
    expect(() =>
      lifecycleEventFor({
        id: EVENT_ID,
        tenantId: TENANT,
        action: "suspend",
        fromState: "active",
        trigger: "security_incident",
        occurredAt: AT,
        reason: "credential stuffing",
        actorSystemId: "operate-server",
      }),
    ).toThrow(/relatedIncidentId/);
  });

  it("refuses a suspend that notifies nobody", () => {
    expect(() =>
      lifecycleEventFor({
        id: EVENT_ID,
        tenantId: TENANT,
        action: "suspend",
        fromState: "active",
        trigger: "billing_failure",
        occurredAt: AT,
        reason: "arrears",
        actorSystemId: "operate-server",
        notificationChannel: "none",
      }),
    ).toThrow(/notify the customer/);
  });
});

describe("append", () => {
  it("writes one INSERT naming every column, with the parameters bound in order", async () => {
    const fake = fakePg();
    const store = new PostgresLifecycleEventStore(fake.conn);
    await store.append(eventOf());
    const insert = fake.calls.find((c) => c.sql.startsWith("INSERT"));
    expect(insert).toBeDefined();
    for (const column of LIFECYCLE_EVENT_COLUMNS) {
      expect(insert?.sql).toContain(column);
    }
    expect(insert?.params).toHaveLength(LIFECYCLE_EVENT_COLUMNS.length);
    expect(insert?.params[0]).toBe(EVENT_ID);
    expect(insert?.params[1]).toBe(TENANT);
  });

  it("casts the uuid, timestamp and boolean columns", async () => {
    const fake = fakePg();
    await new PostgresLifecycleEventStore(fake.conn).append(eventOf());
    const sql = fake.calls.find((c) => c.sql.startsWith("INSERT"))?.sql ?? "";
    expect(sql).toContain("$1::uuid");
    expect(sql).toContain("$2::uuid");
    expect(sql).toMatch(/\$7::timestamptz/);
    expect(sql).toMatch(/\$13::boolean/);
  });

  it("emits nothing but a scope and an INSERT — no UPDATE and no DELETE path exists", async () => {
    const fake = fakePg();
    await new PostgresLifecycleEventStore(fake.conn).append(eventOf());
    for (const { sql } of fake.calls) {
      if (sql === "BEGIN" || sql === "COMMIT") continue;
      if (sql === SET_TENANT_CONTEXT_SQL) continue;
      expect(sql.toUpperCase()).toMatch(/^INSERT /);
    }
  });

  it("scopes the write to the event's own tenant, before the INSERT", async () => {
    // The defect this closes, observed live as a non-owner: the isolation policy is the only arm
    // with a `WITH CHECK` (the platform arm is SELECT-scoped), so an append from a platform route —
    // where every console transition comes from — raised 42501 and the trail recorded nothing while
    // the transition succeeded. Asserted as a *scope*, and as coming first: after the INSERT it
    // would be a no-op the policy has already refused.
    const fake = fakePg();
    await new PostgresLifecycleEventStore(fake.conn).append(eventOf({ tenantId: TENANT }));
    const statements = fake.calls.filter((c) => c.sql !== "BEGIN" && c.sql !== "COMMIT");
    expect(statements[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(statements[0]?.params).toEqual([TENANT]);
    expect(statements[1]?.sql.startsWith("INSERT")).toBe(true);
  });

  it("scopes an appendWithin too, transaction-locally", async () => {
    // `appendWithin` runs in the deletion pipeline's transaction, which is already erasing this very
    // tenant — so the scope is the same one and `set_config(…, true)` cannot leak past the commit.
    const fake = fakePg();
    await new PostgresLifecycleEventStore(fake.conn).appendWithin(fake.conn, eventOf({ tenantId: TENANT }));
    const scope = fake.calls.find((c) => c.sql === SET_TENANT_CONTEXT_SQL);
    expect(scope?.params).toEqual([TENANT]);
    expect(SET_TENANT_CONTEXT_SQL).toContain(", true)");
  });

  it("refuses a non-uuid event id, because the column is UUID", async () => {
    const store = new PostgresLifecycleEventStore(fakePg().conn);
    await expect(store.append(eventOf({ id: "evt_not_a_uuid" }))).rejects.toThrow(
      /must be a uuid/,
    );
  });

  it("refuses a non-uuid tenant id", async () => {
    const store = new PostgresLifecycleEventStore(fakePg().conn);
    await expect(store.append(eventOf({ tenantId: "acme" }))).rejects.toThrow(
      /tenantId must be a uuid/,
    );
  });

  it("refuses an event the contract rejects, even when the type says otherwise", async () => {
    const store = new PostgresLifecycleEventStore(fakePg().conn);
    // `execute_deletion` must target `deleted`; a hand-built record can say otherwise.
    const forged = { ...eventOf(), toState: "archived" } as LifecycleEvent;
    try {
      await store.append(forged);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(LifecycleEventRefused);
      expect((err as LifecycleEventRefused).refusal).toBe("contract_violated");
      expect((err as Error).message).toContain("must transition to 'deleted'");
    }
  });

  it("refuses an action that requires four eyes and records it as not required", async () => {
    const store = new PostgresLifecycleEventStore(fakePg().conn);
    const forged = {
      ...eventOf({ action: "archive", fromState: "active", toState: "archived" }),
      trigger: "compliance_directive",
      relatedIncidentId: "INC-2026-0002",
      requiresFourEyesApproval: false,
      approvedByUserId: null,
      approvedAt: null,
    } as LifecycleEvent;
    try {
      await store.append(forged);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(LifecycleEventRefused);
      expect((err as LifecycleEventRefused).refusal).toBe("four_eyes_required");
    }
  });

  it("refuses an approver who is the actor — the second of the rule's three layers", async () => {
    const store = new PostgresLifecycleEventStore(fakePg().conn);
    const forged = { ...eventOf(), approvedByUserId: ACTOR } as LifecycleEvent;
    await expect(store.append(forged)).rejects.toThrow(/four-eyes/);
  });

  it("sends no statement at all when it refuses", async () => {
    const fake = fakePg();
    const store = new PostgresLifecycleEventStore(fake.conn);
    await expect(store.append(eventOf({ tenantId: "nope" }))).rejects.toThrow();
    expect(fake.calls.filter((c) => c.sql.startsWith("INSERT"))).toHaveLength(0);
  });

  it("appendWithin uses the caller's transaction and opens none of its own", async () => {
    const fake = fakePg();
    const store = new PostgresLifecycleEventStore(fake.conn);
    await store.appendWithin(fake.conn, eventOf());
    expect(fake.sql()).not.toContain("BEGIN");
    expect(fake.calls.filter((c) => c.sql.startsWith("INSERT"))).toHaveLength(1);
  });

  it("honours a non-default schema", async () => {
    const fake = fakePg();
    await new PostgresLifecycleEventStore(fake.conn, { schema: "platform" }).append(eventOf());
    // Found by name, not by index: the scope statement now sits between BEGIN and the INSERT, and a
    // positional assertion is what broke when it landed.
    const insert = fake.calls.find((c) => c.sql.startsWith("INSERT"));
    expect(insert?.sql).toContain("platform.tenant_lifecycle_events");
  });

  it("refuses a schema that is not an identifier", () => {
    expect(() => new PostgresLifecycleEventStore(fakePg().conn, { schema: 'x"; drop' })).toThrow(
      /invalid schema/,
    );
  });
});

describe("reads", () => {
  it("carries a strict tenant_id predicate beside RLS", async () => {
    const fake = fakePg([rowOf()]);
    await new PostgresLifecycleEventStore(fake.conn).listForTenant(TENANT);
    const select = fake.calls.find((c) => c.sql.startsWith("SELECT"));
    expect(select?.sql).toContain("tenant_id = $1");
    // Strict, not inclusive: `tenant_id` is NOT NULL here, so a platform arm would match no row.
    expect(select?.sql).not.toContain("tenant_id IS NULL");
    expect(select?.params[0]).toBe(TENANT);
  });

  it("orders on (occurred_at, id) so a shared timestamp cannot reorder the trail", async () => {
    const fake = fakePg([rowOf()]);
    await new PostgresLifecycleEventStore(fake.conn).listForTenant(TENANT);
    expect(fake.calls[0]?.sql).toContain("ORDER BY occurred_at, id");
  });

  it("clamps the page size rather than passing it through", async () => {
    const fake = fakePg([rowOf()]);
    await new PostgresLifecycleEventStore(fake.conn).listForTenant(TENANT, 10_000);
    expect(fake.calls[0]?.params[1]).toBe(LIFECYCLE_EVENT_MAX_LIMIT);
  });

  it("refuses a tenant id that could not be one", async () => {
    const store = new PostgresLifecycleEventStore(fakePg().conn);
    await expect(store.listForTenant("'; drop table --")).rejects.toThrow(/invalid tenantId/);
  });

  it("latestForTenant asks for one row, newest first", async () => {
    const fake = fakePg([rowOf()]);
    const out = await new PostgresLifecycleEventStore(fake.conn).latestForTenant(TENANT);
    expect(fake.calls[0]?.sql).toContain("ORDER BY occurred_at DESC, id DESC LIMIT 1");
    expect(out?.id).toBe(EVENT_ID);
  });

  it("latestForTenant answers null on an empty trail", async () => {
    const out = await new PostgresLifecycleEventStore(fakePg([]).conn).latestForTenant(TENANT);
    expect(out).toBeNull();
  });

  it("readTrailAsPlatform claims the SELECT-only grant and still names the scope", async () => {
    const fake = fakePg([rowOf()]);
    await new PostgresLifecycleEventStore(fake.conn).readTrailAsPlatform(TENANT);
    expect(fake.sql().some((s) => s.includes("app.platform_audit"))).toBe(true);
    const select = fake.calls.find((c) => c.sql.includes("FROM meta.tenant_lifecycle_events"));
    // The elevation answers "may this session see other scopes", not "which scope was asked for".
    expect(select?.sql).toContain("tenant_id = $1");
  });

  it("claims the grant transaction-locally, so a pooled connection cannot carry it", async () => {
    const fake = fakePg([rowOf()]);
    await new PostgresLifecycleEventStore(fake.conn).readTrailAsPlatform(TENANT);
    const grant = fake.calls.find((c) => c.sql.includes("app.platform_audit"));
    expect(grant?.sql).toContain("true)");
  });

  it("deletedTenants is deliberately cross-tenant and says so in its SQL", async () => {
    // Exempt from the fake's scope tripwire on purpose: this is the one question no scope predicate
    // can answer — which tenants were deleted — and it is the read that makes the table's purpose
    // true.
    const fake = fakePg([rowOf()], { allowUnscoped: true });
    await new PostgresLifecycleEventStore(fake.conn).deletedTenants();
    const select = fake.calls.find((c) => c.sql.includes("FROM meta.tenant_lifecycle_events"));
    expect(select?.sql).toContain("to_state = 'deleted'");
    expect(fake.sql().some((s) => s.includes("app.platform_audit"))).toBe(true);
  });
});

describe("rowToLifecycleEvent", () => {
  it("round-trips an event through a row", () => {
    expect(rowToLifecycleEvent(rowOf())).toEqual(eventOf());
  });

  it("normalises a Date column, because node-postgres returns Date for TIMESTAMPTZ", () => {
    const out = rowToLifecycleEvent(rowOf({ occurred_at: new Date(AT) }));
    expect(out.occurredAt).toBe(AT);
  });

  it("throws on a row holding a state the contract no longer has", () => {
    // The catalog's CHECK still lists the seven states ADR-0334 narrowed to five, so this row is
    // storable and unrepresentable — a finding, not a shorter answer.
    expect(() => rowToLifecycleEvent(rowOf({ from_state: "past_due" }))).toThrow();
  });

  it("throws on a row with neither actor", () => {
    expect(() =>
      rowToLifecycleEvent(rowOf({ actor_user_id: null, actor_system_id: null })),
    ).toThrow(/actorUserId/);
  });

  it("omits the optional fields rather than carrying nulls the contract refuses", () => {
    const out = rowToLifecycleEvent(rowOf({ related_incident_id: null, notes: null }));
    expect(out.relatedIncidentId).toBeUndefined();
    expect(out.notes).toBeUndefined();
  });

  it("keeps a related incident id when the row has one", () => {
    const out = rowToLifecycleEvent(rowOf({ related_incident_id: "INC-2026-0007" }));
    expect(out.relatedIncidentId).toBe("INC-2026-0007");
  });
});

describe("readTenantState", () => {
  it("reads the state from the row", async () => {
    const fake = fakePg([{ status: "pending_deletion" }], { allowUnscoped: true });
    expect(await readTenantState(fake.conn, TENANT)).toBe("pending_deletion");
    expect(fake.calls[0]?.sql).toContain("FROM meta.tenants WHERE id = $1::uuid");
  });

  it("answers null when the tenant row is absent, rather than guessing active", async () => {
    const fake = fakePg([], { allowUnscoped: true });
    expect(await readTenantState(fake.conn, TENANT)).toBeNull();
  });

  it("throws when the column holds a state the contract no longer has", async () => {
    const fake = fakePg([{ status: "trial" }], { allowUnscoped: true });
    await expect(readTenantState(fake.conn, TENANT)).rejects.toThrow(/TENANT_LIFECYCLE_STATES/);
  });

  it("refuses a tenant id that is not a uuid", async () => {
    const fake = fakePg([], { allowUnscoped: true });
    await expect(readTenantState(fake.conn, "acme")).rejects.toThrow(/must be a uuid/);
  });
});

describe("transitionWasLegal", () => {
  it("is true for pending_deletion -> deleted", () => {
    expect(transitionWasLegal(eventOf())).toBe(true);
  });

  it("is false for active -> deleted, which the synchronous route still performs", () => {
    expect(transitionWasLegal(eventOf({ fromState: "active" }))).toBe(false);
  });
});

describe("probeLifecycleTrail", () => {
  function catalogFake(opts: {
    readonly present?: boolean;
    readonly fks?: readonly Record<string, unknown>[];
    readonly policies?: readonly Record<string, unknown>[];
  }): PgConnection {
    return {
      query: (async (sql: string) => {
        if (sql.includes("to_regclass($1) IS NOT NULL")) {
          return { rows: [{ present: opts.present ?? true }], rowCount: 1 };
        }
        if (sql.includes("pg_constraint")) {
          return { rows: opts.fks ?? [], rowCount: (opts.fks ?? []).length };
        }
        return { rows: opts.policies ?? [], rowCount: (opts.policies ?? []).length };
      }) as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(catalogFake(opts))) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
        fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
  }

  const PLATFORM_READ = {
    polcmd: "r",
    using_expr: "(current_setting('app.platform_audit'::text, true) = 'on'::text)",
  };

  it("answers absent when the table does not exist", async () => {
    const out = await probeLifecycleTrail(catalogFake({ present: false }));
    expect(out.verdict).toBe("absent");
    expect(out.detail).toContain("does not exist");
  });

  it("answers cascades_with_tenant for the catalog as shipped", async () => {
    const out = await probeLifecycleTrail(
      catalogFake({
        fks: [
          { column_name: "tenant_id", confdeltype: "c", target: "tenants" },
          { column_name: "actor_user_id", confdeltype: "r", target: "users" },
        ],
      }),
    );
    expect(out.verdict).toBe("cascades_with_tenant");
    expect(out.cascadesWithTenant).toBe(true);
    expect(out.actorColumnsReferenceUsers).toBe(true);
    expect(out.detail).toContain("ON DELETE CASCADE");
    expect(out.detail).toContain("no SELECT-scoped platform read policy");
  });

  it("answers unreadable_after_deletion when the cascade is gone and the read arm is not there", async () => {
    const out = await probeLifecycleTrail(catalogFake({ fks: [] }));
    expect(out.verdict).toBe("unreadable_after_deletion");
    expect(out.cascadesWithTenant).toBe(false);
    expect(out.platformReadable).toBe(false);
  });

  it("answers durable once both patches are in", async () => {
    const out = await probeLifecycleTrail(catalogFake({ fks: [], policies: [PLATFORM_READ] }));
    expect(out.verdict).toBe("durable");
    expect(out.platformReadable).toBe(true);
    expect(out.detail).toBe("the lifecycle trail is durable and readable");
  });

  it("does not count an ALL-scope platform arm as readable, because that would be a write route", async () => {
    const out = await probeLifecycleTrail(
      catalogFake({
        fks: [],
        policies: [{ polcmd: "*", using_expr: "current_setting('app.platform_audit', true) = 'on'" }],
      }),
    );
    expect(out.platformReadable).toBe(false);
  });

  it("reports the cascade in preference to the read arm, because it destroys rather than hides", async () => {
    const out = await probeLifecycleTrail(
      catalogFake({
        fks: [{ column_name: "tenant_id", confdeltype: "c", target: "tenants" }],
        policies: [PLATFORM_READ],
      }),
    );
    expect(out.verdict).toBe("cascades_with_tenant");
    expect(out.platformReadable).toBe(true);
  });

  it("ignores a SET NULL or RESTRICT tenant reference, which does not destroy the row", async () => {
    const out = await probeLifecycleTrail(
      catalogFake({
        fks: [{ column_name: "tenant_id", confdeltype: "n", target: "tenants" }],
        policies: [PLATFORM_READ],
      }),
    );
    expect(out.verdict).toBe("durable");
  });

  it("refuses a schema that is not an identifier", async () => {
    await expect(probeLifecycleTrail(catalogFake({}), "x; drop")).rejects.toThrow(/invalid schema/);
  });
});
