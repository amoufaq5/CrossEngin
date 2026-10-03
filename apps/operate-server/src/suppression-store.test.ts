import type { PgConnection } from "@crossengin/kernel-pg";
import { SuppressionRecordSchema, type SuppressionRecord } from "@crossengin/notifications";
import { suppressionIdFor } from "@crossengin/notification-providers";
import { describe, expect, it } from "vitest";

import {
  PostgresSuppressionStore,
  SUPPRESSION_ADDRESS_CONSTRAINT,
  SUPPRESSION_ID_CONSTRAINT,
  SuppressionWriteConflictError,
  suppressionFromRow,
  uniqueViolationConstraint,
} from "./suppression-store.js";
import type { RecipientResolverLike } from "./delivery-drain.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-01T12:00:00.000Z");

type Row = Record<string, unknown>;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

function record(overrides: Partial<SuppressionRecord> = {}): SuppressionRecord {
  const base = {
    tenantId: TENANT_A,
    channel: "email" as const,
    recipientAddress: "bounced@example.test",
    reason: "hard_bounce" as const,
  };
  const merged = { ...base, ...overrides };
  return SuppressionRecordSchema.parse({
    id: suppressionIdFor({
      tenantId: merged.tenantId,
      channel: merged.channel,
      recipientAddress: merged.recipientAddress,
      reason: merged.reason,
    }),
    tenantId: merged.tenantId,
    channel: merged.channel,
    recipientAddress: merged.recipientAddress,
    reason: merged.reason,
    appliedAt: NOW.toISOString(),
    appliedBy: null,
    expiresAt: null,
    sourceDeliveryId: null,
    notes: "ses hard_bounce; code=Permanent/General",
    ...overrides,
  });
}

interface UniqueViolation extends Error {
  code: string;
  constraint: string;
  detail: string;
}

function uniqueViolation(constraint: string): UniqueViolation {
  const err = new Error("duplicate key value violates unique constraint") as UniqueViolation;
  err.code = "23505";
  err.constraint = constraint;
  // The real driver puts the address in `detail`; a test asserts it never escapes.
  err.detail = "Key (tenant_id, channel, recipient_address)=(…, email, bounced@example.test)";
  return err;
}

/**
 * A scripted fake `PgConnection` over `meta.notification_suppressions`, modelling the two things that
 * make this store's statements correct: RLS (rows are invisible until the transaction's `set_config`
 * has bound `app.current_tenant_id`) and BOTH unique constraints — the global one on `suppression_id`
 * and the per-tenant one on `(tenant_id, channel, recipient_address)` — so an insert that would raise
 * in Postgres raises here too unless the statement guards against it.
 */
function fakeSuppressionDb(): {
  conn: PgConnection;
  captured: Captured[];
  rows: Row[];
  raiseOnNextInsert: (constraint: string) => void;
} {
  const captured: Captured[] = [];
  const rows: Row[] = [];
  let currentTenant: string | null = null;
  let pendingRaise: string | null = null;

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
    inTx: boolean,
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p, inTx });

    if (sql.includes("set_config")) {
      currentTenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith("INSERT INTO")) {
      if (pendingRaise !== null) {
        const constraint = pendingRaise;
        pendingRaise = null;
        throw uniqueViolation(constraint);
      }
      const [id, tenantId, channel, address] = p;
      const visible = (r: Row): boolean =>
        r["tenant_id"] === currentTenant && r["tenant_id"] === tenantId;
      const addressTaken = rows.some(
        (r) =>
          visible(r) && r["channel"] === channel && r["recipient_address"] === address,
      );
      // `WHERE NOT EXISTS (…)` — the statement declines rather than raising.
      if (addressTaken) return { rows: [], rowCount: 0 };
      if (rows.some((r) => r["suppression_id"] === id)) {
        if (!sql.includes("ON CONFLICT (suppression_id) DO NOTHING")) {
          throw uniqueViolation(SUPPRESSION_ID_CONSTRAINT);
        }
        return { rows: [], rowCount: 0 };
      }
      rows.push({
        id: `cccccccc-cccc-4ccc-8ccc-${String(rows.length + 1).padStart(12, "0")}`,
        suppression_id: p[0],
        tenant_id: p[1],
        channel: p[2],
        recipient_address: p[3],
        reason: p[4],
        applied_at: p[5],
        applied_by: p[6],
        expires_at: p[7],
        source_delivery_id: p[8],
        notes: p[9],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("SELECT suppression_id FROM")) {
      const matched = rows
        .filter(
          (r) =>
            r["tenant_id"] === currentTenant &&
            r["tenant_id"] === p[0] &&
            r["channel"] === p[1] &&
            r["recipient_address"] === p[2],
        )
        .map((r) => ({ suppression_id: r["suppression_id"] }));
      return { rows: matched, rowCount: matched.length };
    }

    if (sql.includes("AND suppression_id = $2")) {
      const matched = rows.filter(
        (r) =>
          r["tenant_id"] === currentTenant &&
          r["tenant_id"] === p[0] &&
          r["suppression_id"] === p[1],
      );
      return { rows: matched, rowCount: matched.length };
    }

    if (sql.includes("expires_at IS NULL OR expires_at >")) {
      const cutoff = Date.parse(String(p[2]));
      const matched = rows
        .filter(
          (r) =>
            r["tenant_id"] === currentTenant &&
            r["tenant_id"] === p[0] &&
            r["channel"] === p[1] &&
            (r["expires_at"] == null || Date.parse(String(r["expires_at"])) > cutoff),
        )
        .sort((a, b) => {
          const byApplied =
            Date.parse(String(b["applied_at"])) - Date.parse(String(a["applied_at"]));
          if (byApplied !== 0) return byApplied;
          return String(a["suppression_id"]).localeCompare(String(b["suppression_id"]));
        });
      return { rows: matched, rowCount: matched.length };
    }

    return { rows: [], rowCount: 0 };
  };

  const tx: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) =>
      run(sql, params, true)) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction not supported by fake");
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) =>
      run(sql, params, false)) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
      try {
        return await fn(tx);
      } finally {
        currentTenant = null;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return {
    conn,
    captured,
    rows,
    raiseOnNextInsert: (constraint: string) => {
      pendingRaise = constraint;
    },
  };
}

describe("suppression-store — shape", () => {
  it("rejects a schema name that is not a bare identifier", () => {
    const { conn } = fakeSuppressionDb();
    expect(() => new PostgresSuppressionStore(conn, { schema: 'meta"; DROP TABLE x' })).toThrow(
      /invalid schema identifier/,
    );
  });

  it("writes to meta.notification_suppressions by default", async () => {
    const { conn, captured } = fakeSuppressionDb();
    await new PostgresSuppressionStore(conn).write(TENANT_A, record());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("meta.notification_suppressions");
  });

  it("binds the ten declared columns in the declared order", async () => {
    const { conn, captured } = fakeSuppressionDb();
    const written = record();
    await new PostgresSuppressionStore(conn).write(TENANT_A, written);
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain(
      "(suppression_id, tenant_id, channel, recipient_address, reason, applied_at," +
        " applied_by, expires_at, source_delivery_id, notes)",
    );
    expect(insert?.params).toEqual([
      written.id,
      TENANT_A,
      "email",
      "bounced@example.test",
      "hard_bounce",
      written.appliedAt,
      null,
      null,
      null,
      written.notes,
    ]);
  });

  it("does not cast applied_by, which is TEXT and holds a structured actor ref", async () => {
    const { conn, captured } = fakeSuppressionDb();
    await new PostgresSuppressionStore(conn).write(TENANT_A, {
      ...record(),
      appliedBy: "provider:ses",
    });
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    // `$7` is `applied_by`. A `::uuid` on it — what the column used to be — would reject every
    // `provider:` and `system:` actor a bounce writes.
    expect(insert?.sql).toContain("$6::timestamptz, $7, $8::timestamptz");
    expect(insert?.params[6]).toBe("provider:ses");
  });

  it("casts the non-text columns, because INSERT … SELECT infers a bare parameter as text", async () => {
    const { conn, captured } = fakeSuppressionDb();
    await new PostgresSuppressionStore(conn).write(TENANT_A, record());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("$2::uuid");
    expect(insert?.sql).toContain("$6::timestamptz");
    // $7 (`applied_by`) is TEXT, so the `text` a bare parameter infers to is already right.
    expect(insert?.sql).not.toContain("$7::");
    expect(insert?.sql).toContain("$8::timestamptz");
    expect(insert?.sql).toContain("$9::uuid");
  });

  it("runs every statement inside the tenant transaction that binds app.current_tenant_id", async () => {
    const { conn, captured } = fakeSuppressionDb();
    await new PostgresSuppressionStore(conn).write(TENANT_A, record());
    expect(captured[0]?.sql).toContain("set_config");
    expect(captured[0]?.params[0]).toBe(TENANT_A);
    expect(captured.every((c) => c.inTx)).toBe(true);
  });
});

describe("suppression-store — idempotent write", () => {
  it("inserts one row for a planned suppression", async () => {
    const { conn, rows } = fakeSuppressionDb();
    const result = await new PostgresSuppressionStore(conn).write(TENANT_A, record());
    expect(result.outcome).toBe("inserted");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["recipient_address"]).toBe("bounced@example.test");
  });

  it("writes nothing the second time the same bounce arrives", async () => {
    const { conn, rows } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    const planned = record();
    expect((await store.write(TENANT_A, planned)).outcome).toBe("inserted");
    const second = await store.write(TENANT_A, planned);
    expect(second.outcome).toBe("already_present");
    expect(second.suppressionId).toBe(planned.id);
    expect(rows).toHaveLength(1);
  });

  it("never moves applied_at on a replay", async () => {
    const { conn, rows } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    await store.write(TENANT_A, record());
    const firstApplied = rows[0]?.["applied_at"];
    await store.write(TENANT_A, record({ appliedAt: "2026-09-02T12:00:00.000Z" }));
    expect(rows[0]?.["applied_at"]).toBe(firstApplied);
  });

  it("uses DO NOTHING and never DO UPDATE, so a replay cannot extend an expiry", async () => {
    const { conn, captured } = fakeSuppressionDb();
    await new PostgresSuppressionStore(conn).write(TENANT_A, record());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("ON CONFLICT (suppression_id) DO NOTHING");
    expect(insert?.sql).not.toContain("DO UPDATE");
  });

  it("guards the address index with NOT EXISTS so a duplicate does not raise", async () => {
    const { conn, captured } = fakeSuppressionDb();
    await new PostgresSuppressionStore(conn).write(TENANT_A, record());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("NOT EXISTS (SELECT 1 FROM meta.notification_suppressions");
    expect(insert?.sql).toContain(
      "WHERE tenant_id = $2::uuid AND channel = $3 AND recipient_address = $4",
    );
  });

  it("scopes the guard to permanent rows, as the index's predicate is scoped", async () => {
    // Without `expires_at IS NULL` the guard refuses a new suppression whenever any row exists for
    // the address, lapsed or not — which is the defect the predicated unique index removed from the
    // schema, re-imposed one layer up. A temporary row cannot trip the index, so it is not guarded.
    const { conn, captured } = fakeSuppressionDb();
    await new PostgresSuppressionStore(conn).write(TENANT_A, record());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("AND expires_at IS NULL");
    expect(insert?.sql).toContain("$8::timestamptz IS NOT NULL OR NOT EXISTS");
  });

  it("names only a permanent row as the holder of an address", async () => {
    // A lapsed suppression holds nothing; reporting it would name the wrong reason to the caller.
    // The holder lookup only runs when the insert wrote no row, so the duplicate has to happen first.
    const { conn, captured } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    await store.write(TENANT_A, record({ reason: "hard_bounce" }));
    await store.write(TENANT_A, record({ reason: "spam_complaint" }));
    const holder = captured.find((c) => c.sql.startsWith("SELECT suppression_id"));
    expect(holder).toBeDefined();
    expect(holder?.sql).toContain("AND expires_at IS NULL");
  });

  it("reports a second, different reason for one address rather than overwriting it", async () => {
    const { conn, rows } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    const hard = await store.write(TENANT_A, record({ reason: "hard_bounce" }));
    const complaint = await store.write(TENANT_A, record({ reason: "spam_complaint" }));
    expect(hard.outcome).toBe("inserted");
    expect(complaint.outcome).toBe("address_already_suppressed");
    // The row that holds the address is reported, not the one that was offered.
    expect(complaint.suppressionId).toBe(hard.suppressionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["reason"]).toBe("hard_bounce");
  });

  it("writes a separate row per channel for one address", async () => {
    const { conn, rows } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    await store.write(TENANT_A, record({ channel: "email" }));
    await store.write(TENANT_A, record({ channel: "sms" }));
    expect(rows).toHaveLength(2);
  });

  it("writes every planned suppression in one transaction", async () => {
    const { conn, rows } = fakeSuppressionDb();
    let transactions = 0;
    const counting: PgConnection = {
      ...conn,
      transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
        transactions += 1;
        return conn.transaction(fn);
      }) as PgConnection["transaction"],
    };
    const batch = await new PostgresSuppressionStore(counting).writeAll(TENANT_A, [
      record({ recipientAddress: "one@example.test" }),
      record({ recipientAddress: "two@example.test" }),
    ]);
    expect(transactions).toBe(1);
    expect(batch.inserted).toBe(2);
    expect(rows).toHaveLength(2);
  });

  it("counts each outcome in a batch", async () => {
    const { conn } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    const first = record({ recipientAddress: "one@example.test" });
    await store.write(TENANT_A, first);
    const batch = await store.writeAll(TENANT_A, [
      first,
      record({ recipientAddress: "two@example.test" }),
      record({ recipientAddress: "one@example.test", reason: "spam_complaint" }),
    ]);
    expect(batch.inserted).toBe(1);
    expect(batch.alreadyPresent).toBe(1);
    expect(batch.addressAlreadySuppressed).toBe(1);
    expect(batch.results).toHaveLength(3);
  });

  it("issues no SQL for an empty plan", async () => {
    const { conn, captured } = fakeSuppressionDb();
    const batch = await new PostgresSuppressionStore(conn).writeAll(TENANT_A, []);
    expect(batch.results).toEqual([]);
    expect(captured).toEqual([]);
  });
});

describe("suppression-store — fail closed on the write", () => {
  it("refuses a tenant id that is not a uuid before issuing any SQL", async () => {
    const { conn, captured } = fakeSuppressionDb();
    await expect(
      new PostgresSuppressionStore(conn).write("not-a-uuid", record()),
    ).rejects.toThrow(/invalid tenantId/);
    expect(captured).toEqual([]);
  });

  it("refuses a record scoped to another tenant than the write context", async () => {
    const { conn, captured, rows } = fakeSuppressionDb();
    await expect(
      new PostgresSuppressionStore(conn).write(TENANT_A, record({ tenantId: TENANT_B })),
    ).rejects.toThrow(/another tenant/);
    expect(captured).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("refuses a record that does not satisfy SuppressionRecordSchema", async () => {
    const { conn, rows } = fakeSuppressionDb();
    const forged = {
      ...record(),
      // `hard_bounce` is permanent, so an expiry is unrepresentable.
      expiresAt: "2026-10-01T00:00:00.000Z",
    } as SuppressionRecord;
    await expect(new PostgresSuppressionStore(conn).write(TENANT_A, forged)).rejects.toThrow();
    expect(rows).toEqual([]);
  });

  it("refuses the whole batch when one record is invalid, writing none of it", async () => {
    const { conn, rows } = fakeSuppressionDb();
    const forged = { ...record({ recipientAddress: "bad@example.test" }), appliedBy: "nope" };
    await expect(
      new PostgresSuppressionStore(conn).writeAll(TENANT_A, [
        record({ recipientAddress: "good@example.test" }),
        forged as SuppressionRecord,
      ]),
    ).rejects.toThrow();
    expect(rows).toEqual([]);
  });

  it("converts a lost race into an error naming no address", async () => {
    const { conn, raiseOnNextInsert } = fakeSuppressionDb();
    raiseOnNextInsert(SUPPRESSION_ADDRESS_CONSTRAINT);
    const planned = record();
    const failure = await new PostgresSuppressionStore(conn)
      .write(TENANT_A, planned)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SuppressionWriteConflictError);
    const conflict = failure as SuppressionWriteConflictError;
    expect(conflict.constraintName).toBe(SUPPRESSION_ADDRESS_CONSTRAINT);
    expect(conflict.suppressionId).toBe(planned.id);
    expect(conflict.message).not.toContain("bounced@example.test");
  });

  it("re-raises an error that is not a unique violation unchanged", async () => {
    const { conn } = fakeSuppressionDb();
    const exploding: PgConnection = {
      ...conn,
      transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) =>
        conn.transaction(async (tx) => {
          const broken: PgConnection = {
            ...tx,
            query: ((sql: string, params?: readonly unknown[]) => {
              if (sql.startsWith("INSERT INTO")) throw new Error("connection terminated");
              return tx.query(sql, params);
            }) as PgConnection["query"],
          };
          return fn(broken);
        })) as PgConnection["transaction"],
    };
    await expect(
      new PostgresSuppressionStore(exploding).write(TENANT_A, record()),
    ).rejects.toThrow(/connection terminated/);
  });

  it("recognises a unique violation only by its SQLSTATE", () => {
    expect(uniqueViolationConstraint(uniqueViolation("c"))).toBe("c");
    expect(uniqueViolationConstraint(new Error("boom"))).toBeNull();
    expect(uniqueViolationConstraint(null)).toBeNull();
    expect(uniqueViolationConstraint({ code: "23503", constraint: "fk" })).toBeNull();
    expect(uniqueViolationConstraint({ code: "23505" })).toBe("");
  });
});

describe("suppression-store — reads re-parse", () => {
  it("returns a stored suppression as a parsed record", async () => {
    const { conn } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    const planned = record();
    await store.write(TENANT_A, planned);
    const read = await store.get(TENANT_A, planned.id);
    expect(read).toEqual(planned);
  });

  it("returns null for an unknown id", async () => {
    const { conn } = fakeSuppressionDb();
    expect(await new PostgresSuppressionStore(conn).get(TENANT_A, "supp_missing00")).toBeNull();
  });

  it("cannot read another tenant's suppression by naming its id", async () => {
    const { conn } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    const planned = record();
    await store.write(TENANT_A, planned);
    expect(await store.get(TENANT_B, planned.id)).toBeNull();
  });

  it("refuses a hand-edited row instead of dropping it from the result", async () => {
    const { conn, rows } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    const planned = record();
    await store.write(TENANT_A, planned);
    // A CHECK constraint permits this; the contract does not — `hard_bounce` is permanent.
    const stored = rows[0];
    if (stored === undefined) throw new Error("expected a stored row");
    stored["expires_at"] = "2027-01-01T00:00:00.000Z";
    await expect(store.get(TENANT_A, planned.id)).rejects.toThrow(
      /stored suppression row is invalid/,
    );
    await expect(store.activeSuppressions(TENANT_A, "email", NOW)).rejects.toThrow(
      /stored suppression row is invalid/,
    );
  });

  it("names the suppression id but not the address when refusing a row", () => {
    expect(() =>
      suppressionFromRow({
        suppression_id: "supp_deadbeef00",
        tenant_id: TENANT_A,
        channel: "email",
        recipient_address: "leaky@example.test",
        reason: "not_a_reason",
        applied_at: NOW,
        applied_by: null,
        expires_at: null,
        source_delivery_id: null,
        notes: null,
      }),
    ).toThrow(/supp_deadbeef00/);
    try {
      suppressionFromRow({
        suppression_id: "supp_deadbeef00",
        tenant_id: TENANT_A,
        channel: "email",
        recipient_address: "leaky@example.test",
        reason: "not_a_reason",
        applied_at: NOW,
        applied_by: null,
        expires_at: null,
        source_delivery_id: null,
        notes: null,
      });
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect(String(err)).not.toContain("leaky@example.test");
    }
  });

  it("maps a NULL notes column to an absent field, not to the string null", async () => {
    const { conn, rows } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    const planned = record({ notes: undefined });
    await store.write(TENANT_A, planned);
    expect(rows[0]?.["notes"]).toBeNull();
    const read = await store.get(TENANT_A, planned.id);
    expect(read?.notes).toBeUndefined();
  });

  it("accepts a Date from the driver as well as an ISO string", async () => {
    const { conn, rows } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    const planned = record();
    await store.write(TENANT_A, planned);
    const stored = rows[0];
    if (stored === undefined) throw new Error("expected a stored row");
    stored["applied_at"] = NOW;
    const read = await store.get(TENANT_A, planned.id);
    expect(read?.appliedAt).toBe(NOW.toISOString());
  });
});

describe("suppression-store — satisfies the drain's read path", () => {
  it("is structurally the resolver slice the delivery drain reads suppressions through", () => {
    const { conn } = fakeSuppressionDb();
    // A compile-time assertion: if `RecipientResolverLike.activeSuppressions` ever changes shape,
    // this stops building rather than letting the written suppression quietly stop suppressing.
    const reader: Pick<RecipientResolverLike, "activeSuppressions"> = new PostgresSuppressionStore(
      conn,
    );
    expect(typeof reader.activeSuppressions).toBe("function");
  });

  it("reads back what it wrote, keyed the way the planner matches it", async () => {
    const { conn } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    const planned = record();
    await store.write(TENANT_A, planned);
    const active = await store.activeSuppressions(TENANT_A, "email", NOW);
    expect(active).toHaveLength(1);
    expect(active[0]?.recipientAddress).toBe("bounced@example.test");
    expect(active[0]?.id).toBe(planned.id);
  });

  it("filters by channel, so an sms suppression does not block email", async () => {
    const { conn } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    await store.write(TENANT_A, record({ channel: "sms", recipientAddress: "+15550000" }));
    expect(await store.activeSuppressions(TENANT_A, "email", NOW)).toEqual([]);
    expect(await store.activeSuppressions(TENANT_A, "sms", NOW)).toHaveLength(1);
  });

  it("excludes an expired suppression even though its row still holds the address", async () => {
    const { conn } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    const soft = record({
      reason: "soft_bounce_exceeded",
      expiresAt: "2026-09-01T18:00:00.000Z",
    });
    await store.write(TENANT_A, soft);
    expect(await store.activeSuppressions(TENANT_A, "email", NOW)).toHaveLength(1);
    const later = new Date("2026-09-02T00:00:00.000Z");
    expect(await store.activeSuppressions(TENANT_A, "email", later)).toEqual([]);
    // Still occupying its tuple, which is why a later hard bounce for the same address is reported
    // rather than written: the unique constraint named `…_active` carries no predicate.
    const hard = await store.write(TENANT_A, record({ reason: "hard_bounce" }));
    expect(hard.outcome).toBe("address_already_suppressed");
  });

  it("never returns another tenant's suppressions", async () => {
    const { conn } = fakeSuppressionDb();
    const store = new PostgresSuppressionStore(conn);
    await store.write(TENANT_A, record());
    await store.write(TENANT_B, record({ tenantId: TENANT_B }));
    expect(await store.activeSuppressions(TENANT_A, "email", NOW)).toHaveLength(1);
    expect(
      (await store.activeSuppressions(TENANT_A, "email", NOW))[0]?.tenantId,
    ).toBe(TENANT_A);
  });

  it("binds now rather than calling the database clock", async () => {
    const { conn, captured } = fakeSuppressionDb();
    await new PostgresSuppressionStore(conn).activeSuppressions(TENANT_A, "email", NOW);
    const select = captured.find((c) => c.sql.includes("expires_at IS NULL"));
    expect(select?.sql).not.toContain("now()");
    expect(select?.params[2]).toBe(NOW.toISOString());
  });
});
