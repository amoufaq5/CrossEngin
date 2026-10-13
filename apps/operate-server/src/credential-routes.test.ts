import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { hashPassword, verifyPassword } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_CHANGED_OPERATION,
  CREDENTIAL_REFUSALS,
  CREDENTIAL_REFUSAL_STATUS,
  CREDENTIAL_REFUSED_OPERATION,
  CREDENTIAL_SET_OPERATION,
  MAX_PASSWORD_LENGTH,
  buildCredentialRoutes,
  type CredentialAuditEvent,
  type CredentialAuditor,
  type CredentialRoutesContext,
} from "./credential-routes.js";
import { PostgresCredentialStore } from "./credential-store.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "99999999-9999-4999-8999-999999999999";
const TARGET = "22222222-2222-4222-8222-2222222222aa";
const AT = "2026-09-01T12:00:00.000Z";

/** Over the 32-byte floor `parseCredentialPepper` imposes, with plenty of distinct bytes. */
const PEPPER = "a-deployment-pepper-with-plenty-of-distinct-bytes-0123456789";

const CURRENT_PASSWORD = "the-current-passphrase-7";
const NEW_PASSWORD = "an-entirely-new-passphrase-8";

/**
 * N=2^14 rather than the deployment default 2^15, which halves the cost of every hash this file
 * *builds* (~60 ms against ~130 ms). It cannot change what the routes cost, because neither takes a
 * parameter for it — and it does not need to: `verifyPassword` re-derives under the parameters the
 * stored hash carries, so a hash produced here verifies against a route that knows nothing about
 * them. That is the property being relied on, not a shortcut past it.
 */
const FAST_SCRYPT = Object.freeze({ n: 16384, r: 8, p: 1 });

/** Well-formed and under a different key: `hadCredential` only asks whether a hash is there. */
const FOREIGN_HASH = `scrypt$16384$8$1$${"a".repeat(32)}$${"b".repeat(128)}`;

/** Not a shape `parsePasswordHash` produces, so `verifyPassword` answers `unreadable_hash`. */
const UNREADABLE_HASH = "argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA";

type Row = Record<string, unknown>;

/**
 * The one real hash in this file, memoised so the suite pays for it once.
 *
 * Derived from `CURRENT_PASSWORD` under `PEPPER`, so the self-service route's `verifyPassword` has
 * something it can genuinely match. The KDF is deliberately **not** stubbed: the thing worth
 * knowing about this module is that the hash it stores is one the login can verify and the one it
 * reads is one a person can satisfy, and a stubbed KDF asserts neither.
 */
let storedHashPromise: Promise<string> | null = null;
function storedHash(): Promise<string> {
  storedHashPromise ??= hashPassword(CURRENT_PASSWORD, PEPPER, { params: FAST_SCRYPT });
  return storedHashPromise;
}

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface FakeOptions {
  /** One answer per credential read, in order. `null` is *no such row*. */
  readonly reads?: readonly (Row | null)[];
  /**
   * One `rowCount` per credential write, in order; omitted means every write matches its row.
   *
   * A write needs its own channel because `setCredential` reads `rowCount` and an `UPDATE` returns
   * no rows, so the row-count-from-rows shortcut the sibling fakes take would make every write look
   * like a lost race.
   */
  readonly writes?: readonly number[];
}

/**
 * Records every statement, answers the two this store issues **by shape**, and throws on everything
 * else (ADR-0333, ADR-0350, and this convention's own blind spots):
 *
 *  - any statement against `users` that names `tenant_id`, because that column does not exist
 *    there — ADR-0332's `default_value` defect, which a fake asserting SQL *shape* cannot see;
 *  - a `set_config` call, because `meta.users` carries no `tenant_id`, no RLS and no policies, so a
 *    tenant context here would mean this store had acquired a scoped read it does not own;
 *  - an **unrecognised** statement, and a read or write past the end of its declared queue, rather
 *    than answering `{rows: []}`. That is the departure from the sibling fakes and it is ADR-0350's
 *    rule: an empty answer for a statement whose shape later changed makes every assertion about
 *    what that statement *found* pass vacuously, which is this convention's blind spot applied to
 *    the fake itself.
 *
 * The shape match is specific to each statement and not merely true of it (ADR-0363): the read is
 * matched on `SELECT … FROM meta.users WHERE id = $1::uuid` and the write on `UPDATE meta.users SET
 * credential_hash`, so neither can be handed the other's answer.
 */
function fakeDb(opts: FakeOptions = {}): {
  conn: PgConnection;
  captured: Captured[];
  updates: () => Captured[];
  sql: () => string;
} {
  const captured: Captured[] = [];
  let readIndex = 0;
  let writeIndex = 0;

  const run = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    captured.push({ sql, params: params ?? [] });

    if (sql.includes("set_config")) {
      throw new Error(
        "this fake refuses a tenant context: meta.users carries no tenant_id, no RLS and no" +
          " policies, so a scoped statement here is a sign of a read this store does not own",
      );
    }
    if (/\busers\b/.test(sql) && /tenant_id/.test(sql)) {
      throw new Error(
        `this fake refuses a tenant_id predicate on meta.users: the column does not exist — ${sql.slice(0, 120)}`,
      );
    }

    if (/^\s*SELECT\b/.test(sql) && /FROM meta\.users/.test(sql) && /WHERE id = \$1::uuid/.test(sql)) {
      const declared = opts.reads;
      if (declared === undefined || readIndex >= declared.length) {
        throw new Error(
          `this fake has no answer declared for credential read #${(readIndex + 1).toString()};` +
            " declaring one is how a test says what the store was shown",
        );
      }
      const row = declared[readIndex] ?? null;
      readIndex += 1;
      return row === null ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }

    if (/^\s*UPDATE meta\.users SET credential_hash/.test(sql)) {
      const declared = opts.writes;
      if (declared !== undefined && writeIndex >= declared.length) {
        throw new Error(
          `this fake has no row count declared for credential write #${(writeIndex + 1).toString()}`,
        );
      }
      const rowCount = declared?.[writeIndex] ?? 1;
      writeIndex += 1;
      return { rows: [], rowCount };
    }

    throw new Error(`this fake does not recognise the statement: ${sql.slice(0, 160)}`);
  };

  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };

  return {
    conn,
    captured,
    updates: () => captured.filter((c) => /^\s*UPDATE\b/.test(c.sql)),
    sql: () => captured.map((c) => c.sql).join("\n---\n"),
  };
}

function credentialRow(over: Row = {}): Row {
  return {
    id: TARGET,
    status: "active",
    credential_hash: null,
    credential_failed_attempts: 0,
    credential_locked_until: null,
    ...over,
  };
}

function principal(over: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    principalId: OPERATOR,
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "bearer_jwt",
    grantedScopes: [],
    mfaProofAgeSeconds: null,
    resolvedAt: AT,
    ...over,
  };
}

interface Recorded {
  readonly events: CredentialAuditEvent[];
  /** One entry per counted failed possession proof, which is what makes the oracle metered. */
  readonly failures: string[];
}

function ctxFor(
  store: PostgresCredentialStore,
  opts: {
    readonly roles?: readonly string[];
    readonly adminRoles?: readonly string[];
    readonly auditThrows?: boolean;
    readonly counterThrows?: boolean;
    readonly pepper?: string;
  } = {},
): { ctx: CredentialRoutesContext; recorded: Recorded } {
  const recorded: Recorded = { events: [], failures: [] };
  const roles = opts.roles ?? ["platform_admin"];
  return {
    recorded,
    ctx: {
      store,
      pepper: opts.pepper ?? PEPPER,
      principalRoles: () => ({
        primaryRole: roles[0] ?? "anonymous",
        secondaryRoles: roles.slice(1),
      }),
      adminRoles: new Set(opts.adminRoles ?? ["platform_admin"]),
      audit: async (e) => {
        if (opts.auditThrows === true) throw new Error("audit down");
        recorded.events.push(e);
      },
      onFailedAttempt: async (userId) => {
        if (opts.counterThrows === true) throw new Error("counter down");
        recorded.failures.push(userId);
      },
      clock: () => new Date(AT),
    },
  };
}

function handlerFor(ctx: CredentialRoutesContext, operationId: string): Handler {
  const found = buildCredentialRoutes(ctx).find((r) => r.route.operationId === operationId);
  if (found === undefined) throw new Error(`no route ${operationId}`);
  return found.handler;
}

type Invocation = Pick<HandlerInput, "principal" | "params" | "parsedBody">;

/**
 * `Pick<HandlerInput, …>` and deliberately **not** `Record<string, unknown>`: the field names are
 * checked against the real `HandlerInput`, which is the one fence that would have caught this
 * module's own first draft reading `input.pathParams` and `input.body` (its comment above
 * `buildSetUserCredentialHandler` records that near-miss). An input bag typed loosely would be as
 * blind to a renamed field as the `as` casts were.
 *
 * `request` and `route` are omitted because neither handler touches them, and the assertion is the
 * narrowest one that lets that stay true.
 */
function invoke(handler: Handler, input: Invocation): Promise<HandlerOutput> {
  return Promise.resolve(handler({ ...input } as HandlerInput));
}

function body(out: HandlerOutput): Record<string, unknown> {
  if (out.kind !== "json") throw new Error(`expected a json output, got ${out.kind}`);
  return out.body as Record<string, unknown>;
}

const SET = "platform.users.credential.set";
const CHANGE = "account.credential.change";

function setBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { password: NEW_PASSWORD, confirmUserId: TARGET, ...over };
}

/* ------------------------------------------------------------ the instrument */

describe("the fake connection", () => {
  it("refuses the three statements it exists to refuse", async () => {
    // A vacuity guard on the instrument, because none of these three paths is reached by any test
    // below -- which is exactly the state in which a fence quietly stops being one. The store
    // issues neither a tenant context nor a `tenant_id` predicate, so without this the refusals
    // would read as coverage they do not provide.
    const db = fakeDb({ reads: [credentialRow()] });
    await expect(db.conn.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]))
      .rejects.toThrow(/refuses a tenant context/);
    await expect(
      db.conn.query("SELECT id FROM meta.users WHERE tenant_id = $1", [TENANT]),
    ).rejects.toThrow(/the column does not exist/);
    await expect(db.conn.query("DELETE FROM meta.users WHERE id = $1::uuid", [TARGET])).rejects.toThrow(
      /does not recognise the statement/,
    );
    // And a read past its declared queue, which is the departure from the sibling fakes: answering
    // `{rows: []}` there would make every assertion about what a statement *found* pass vacuously.
    const read = "SELECT id, status, credential_hash FROM meta.users WHERE id = $1::uuid";
    await db.conn.query(read, [TARGET]);
    await expect(db.conn.query(read, [TARGET])).rejects.toThrow(/no answer declared/);
  });
});

/* -------------------------------------------------------------------- contracts */

describe("credential refusal contracts", () => {
  it("maps every refusal and only the declared refusals to a status", () => {
    // Derived from the enum in both directions, so a ninth member fails here rather than inheriting
    // whichever branch an `if`-chain ended on.
    expect(Object.keys(CREDENTIAL_REFUSAL_STATUS).sort()).toEqual([...CREDENTIAL_REFUSALS].sort());
    for (const refusal of CREDENTIAL_REFUSALS) {
      const status = CREDENTIAL_REFUSAL_STATUS[refusal];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it("answers 401 for a failed second authentication and 503 for an unrecordable act", () => {
    // `current_password_wrong` is 401 and not 403: the caller is authenticated as themselves and
    // their role is irrelevant, so what failed is an authentication. `unrecordable` is retryable.
    expect(CREDENTIAL_REFUSAL_STATUS.current_password_wrong).toBe(401);
    expect(CREDENTIAL_REFUSAL_STATUS.self_not_permitted).toBe(403);
    expect(CREDENTIAL_REFUSAL_STATUS.no_current_credential).toBe(409);
    expect(CREDENTIAL_REFUSAL_STATUS.unrecordable).toBe(503);
  });

  it("omits the two pepper outcomes, which these routes cannot reach", () => {
    // Both routes mount on the same resolved material the login does, so a deployment with no
    // usable pepper has no login and no way to reach a route that needs one.
    expect(CREDENTIAL_REFUSALS).not.toContain("pepper_absent");
    expect(CREDENTIAL_REFUSALS).not.toContain("pepper_refused");
  });

  it("names three distinct operations, one of which is the single refusal row", () => {
    const ops = [
      CREDENTIAL_SET_OPERATION,
      CREDENTIAL_CHANGED_OPERATION,
      CREDENTIAL_REFUSED_OPERATION,
    ];
    expect(new Set(ops).size).toBe(3);
    expect(CREDENTIAL_SET_OPERATION.startsWith("platform.")).toBe(true);
    expect(CREDENTIAL_CHANGED_OPERATION.startsWith("account.")).toBe(true);
  });

  it("bounds a password as a work bound rather than a strength rule", () => {
    expect(MAX_PASSWORD_LENGTH).toBe(1024);
  });
});

/* ------------------------------------------------------------- buildCredentialRoutes */

describe("buildCredentialRoutes", () => {
  it("refuses to construct without an auditor", () => {
    const { conn } = fakeDb();
    const { ctx } = ctxFor(new PostgresCredentialStore(conn));
    expect(() =>
      buildCredentialRoutes({ ...ctx, audit: undefined as unknown as CredentialAuditor }),
    ).toThrow(/require an auditor/);
  });

  it("refuses an empty or whitespace pepper rather than hashing under it", () => {
    const { conn } = fakeDb();
    const store = new PostgresCredentialStore(conn);
    expect(() => buildCredentialRoutes(ctxFor(store, { pepper: "" }).ctx)).toThrow(
      /require the deployment's pepper/,
    );
    expect(() => buildCredentialRoutes(ctxFor(store, { pepper: "   " }).ctx)).toThrow(
      /require the deployment's pepper/,
    );
  });

  it("mounts only the self route when no role is granted", () => {
    const { conn } = fakeDb();
    const { ctx } = ctxFor(new PostgresCredentialStore(conn), { adminRoles: [] });
    const routes = buildCredentialRoutes(ctx);
    // Fail-closed by omission: a surface that answers 403 for everyone reads as broken rather than
    // as ungranted. The self route is unconditional, because a deployment that mounted a login must
    // be able to change the password it logs in with.
    expect(routes).toHaveLength(1);
    expect(routes[0]?.route.operationId).toBe(CHANGE);
    expect(routes.some((r) => r.route.operationId === SET)).toBe(false);
  });

  it("mounts both routes with a role, at the two declared paths", () => {
    const { conn } = fakeDb();
    const { ctx } = ctxFor(new PostgresCredentialStore(conn));
    const routes = buildCredentialRoutes(ctx);
    expect(routes).toHaveLength(2);
    expect(new Set(routes.map((r) => r.route.operationId))).toEqual(new Set([CHANGE, SET]));
    const path = (operationId: string): string => {
      const found = routes.find((r) => r.route.operationId === operationId);
      return (found?.route.pathSegments ?? [])
        .map((s) => {
          // `PathSegment` has a third member, `wildcard`, and rendering it through the parameter
          // arm would not typecheck — so it is named rather than assumed absent. Neither route
          // declares one, which the rendered paths below assert.
          if (s.kind === "literal") return s.value;
          return s.kind === "parameter" ? `{${s.name}}` : "*";
        })
        .join("/");
    };
    expect(path(CHANGE)).toBe("v1/account/password");
    expect(path(SET)).toBe("v1/platform/users/{id}/credential");
    for (const r of routes) {
      expect(r.route.method).toBe("POST");
      // A retried set lands the same state it did the first time, so there is nothing a replay
      // guard would protect.
      expect(r.route.idempotencyRequired).toBe(false);
    }
  });
});

/* ------------------------------------------------------- the operator route */

describe("the operator route", () => {
  it("401s with no principal", async () => {
    const db = fakeDb();
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: null,
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(out.status).toBe(401);
    expect(body(out)["error"]).toBe("authentication_required");
    expect(db.captured).toHaveLength(0);
  });

  it("403s a principal with no admin role, and admits one holding it secondarily", async () => {
    const db = fakeDb({ reads: [null] });
    const { ctx: ungranted } = ctxFor(new PostgresCredentialStore(db.conn), {
      roles: ["erp_admin", "auditor"],
    });
    const refused = await invoke(handlerFor(ungranted, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(refused.status).toBe(403);
    expect(body(refused)["error"]).toBe("forbidden");
    expect(db.captured).toHaveLength(0);

    // `rolesOf` flattens the primary and the secondaries, so a grant held secondarily reaches past
    // the fence — the 404 below is the proof it did.
    const { ctx: granted } = ctxFor(new PostgresCredentialStore(db.conn), {
      roles: ["erp_admin", "platform_admin"],
    });
    const admitted = await invoke(handlerFor(granted, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(admitted.status).toBe(404);
  });

  it("400s a path id that is not a uuid, and an absent one", async () => {
    const db = fakeDb();
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const handler = handlerFor(ctx, SET);
    const cases: ReadonlyArray<Readonly<Record<string, string>>> = [{ id: "not-a-uuid" }, {}];
    for (const params of cases) {
      const out = await invoke(handler, { principal: principal(), params, parsedBody: setBody() });
      expect(out.status).toBe(400);
      expect(body(out)["error"]).toBe("invalid_request");
    }
    expect(db.captured).toHaveLength(0);
  });

  it("400s a body missing the password, carrying an extra key, or absent entirely", async () => {
    const db = fakeDb();
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const handler = handlerFor(ctx, SET);

    const missing = await invoke(handler, {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: { confirmUserId: TARGET },
    });
    expect(missing.status).toBe(400);
    expect(String(body(missing)["detail"])).toContain("password");

    // `.strict()`: an unknown key is refused rather than ignored.
    const extra = await invoke(handler, {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody({ notify: true }),
    });
    expect(extra.status).toBe(400);

    const absent = await invoke(handler, {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: null,
    });
    expect(absent.status).toBe(400);
    expect(String(body(absent)["detail"])).toContain("(root)");

    // PINNED DEFECT, not an endorsement. The renderer is
    // `issues.map((i) => i.path.join("."))` under a comment saying *"the issue paths are named"* --
    // and zod's `unrecognized_keys` issue has an **empty path**, carrying the offending names in
    // `i.keys` instead. So the one fact the detail exists to convey is absent, and a `.strict()`
    // rejection is byte-identical to the refusal for an absent body: a caller sending one extra key
    // is told `(root)` and cannot discover which key to drop (ADR-0334 -- a refusal an operator
    // cannot act on). A key *name* is not a value, so naming it breaks none of this module's rules.
    // Flipping these two assertions is the test for the fix.
    expect(String(body(extra)["detail"])).not.toContain("notify");
    expect(body(extra)).toEqual(body(absent));

    expect(db.captured).toHaveLength(0);
  });

  it("refuses a password past the ceiling and admits one at it", async () => {
    const over = fakeDb();
    const { ctx: overCtx } = ctxFor(new PostgresCredentialStore(over.conn));
    const refused = await invoke(handlerFor(overCtx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody({ password: "p".repeat(MAX_PASSWORD_LENGTH + 1) }),
    });
    expect(refused.status).toBe(400);
    expect(over.captured).toHaveLength(0);

    // Inclusive: a password exactly at the bound reaches the store, which is what the 404 shows.
    // There is no floor, deliberately — the floor is on the deployment's pepper.
    const at = fakeDb({ reads: [null] });
    const { ctx: atCtx } = ctxFor(new PostgresCredentialStore(at.conn));
    const admitted = await invoke(handlerFor(atCtx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody({ password: "p".repeat(MAX_PASSWORD_LENGTH) }),
    });
    expect(admitted.status).toBe(404);
  });

  it("400s confirm_mismatch when the body names a different user", async () => {
    const db = fakeDb();
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody({ confirmUserId: OPERATOR }),
    });
    expect(out.status).toBe(400);
    expect(body(out)["error"]).toBe("confirm_mismatch");
    expect(db.captured).toHaveLength(0);
  });

  it("compares the confirmation case-insensitively", async () => {
    // A uuid is hex and both spellings name one row, so a case difference must not read as a
    // different user. The 404 is the proof the comparison passed.
    const db = fakeDb({ reads: [null] });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody({ confirmUserId: TARGET.toUpperCase() }),
    });
    expect(out.status).toBe(404);
    expect(body(out)["error"]).toBe("user_unknown");
  });

  it("403s an operator aiming the route at themselves, before any store call or audit row", async () => {
    const db = fakeDb();
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal({ principalId: OPERATOR }),
      params: { id: OPERATOR },
      parsedBody: setBody({ confirmUserId: OPERATOR }),
    });
    expect(out.status).toBe(403);
    expect(body(out)["error"]).toBe("self_not_permitted");
    // This route skips the current-password proof, so aiming it at the caller would let them
    // replace their own credential without proving they hold it. It must not be *expressible*
    // rather than merely refused, which is why neither a statement nor a row is produced.
    expect(db.captured).toHaveLength(0);
    expect(recorded.events).toHaveLength(0);

    // And case-insensitively, for the same reason the confirmation is.
    const upper = fakeDb();
    const { ctx: upperCtx } = ctxFor(new PostgresCredentialStore(upper.conn));
    const also = await invoke(handlerFor(upperCtx, SET), {
      principal: principal({ principalId: OPERATOR.toUpperCase() }),
      params: { id: OPERATOR },
      parsedBody: setBody({ confirmUserId: OPERATOR }),
    });
    expect(body(also)["error"]).toBe("self_not_permitted");
  });

  it("404s a user with no row, and records nothing for one", async () => {
    const db = fakeDb({ reads: [null] });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(out.status).toBe(404);
    expect(body(out)["error"]).toBe("user_unknown");
    // The existence check precedes the record so the trail does not fill with rows for users who
    // are not there.
    expect(recorded.events).toHaveLength(0);
    expect(db.updates()).toHaveLength(0);
  });

  it("stores a hash the login can verify, and clears the lock the 200 claims it cleared", async () => {
    const db = fakeDb({ reads: [credentialRow()], writes: [1] });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(out.status).toBe(200);
    expect(body(out)["credentialSet"]).toBe(true);
    expect(body(out)["userId"]).toBe(TARGET);

    const update = db.updates()[0];
    expect(update?.sql).toMatch(/credential_hash = \$2/);
    // The lock clearing is part of the contract the 200 claims, so it is asserted rather than
    // trusted: an operator setting a password for a locked-out person must unlock them.
    expect(update?.sql).toMatch(/credential_failed_attempts = 0/);
    expect(update?.sql).toMatch(/credential_locked_until = NULL/);
    expect(body(out)["lockCleared"]).toBe(true);
    expect(update?.params[0]).toBe(TARGET);

    expect(await verifyPassword(NEW_PASSWORD, String(update?.params[1]), PEPPER)).toBe("matched");
  });

  it("503s and writes nothing when the act cannot be recorded", async () => {
    const db = fakeDb({ reads: [credentialRow()] });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn), { auditThrows: true });
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(out.status).toBe(503);
    expect(body(out)["error"]).toBe("unrecordable");
    // The load-bearing fence: the record goes before the write, so an unrecordable privileged write
    // does not land. The read is captured and the UPDATE is not.
    expect(db.updates()).toHaveLength(0);
    expect(db.captured).toHaveLength(1);
  });

  it("200s a suspended user and says the login is still refused", async () => {
    // ADR-0322's report-rather-than-refuse: setting a password ahead of a reactivation is a
    // coherent act, so it happens — and the consequence is STATED, because an unqualified
    // "credential set" for a user `verifyLogin` refuses outright is a success message for a
    // password that does not work (ADR-0337's falsely-true direction).
    const db = fakeDb({ reads: [credentialRow({ status: "suspended" })], writes: [1] });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(out.status).toBe(200);
    expect(body(out)["credentialSet"]).toBe(true);
    expect(body(out)["loginBlocked"]).toBe(true);
    expect(body(out)["subjectStatus"]).toBe("suspended");
    expect(String(body(out)["detail"])).toContain("suspended");
    // The password really was written — this is a 200 that qualifies itself, not a refusal.
    expect(db.updates()).toHaveLength(1);
    // And the trail carries the status, because a credential set for a suspended user is a
    // different act from one set for an active user.
    expect(recorded.events[0]?.detail["subjectStatus"]).toBe("suspended");
  });

  it("reports loginBlocked false for an active user", async () => {
    const db = fakeDb({ reads: [credentialRow()], writes: [1] });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(body(out)["loginBlocked"]).toBe(false);
    expect(body(out)["subjectStatus"]).toBe("active");
  });

  it("403s a retired user, because no transition brings one back", async () => {
    // `USER_STATUS_TRANSITIONS.deleted` is empty, so a password set here could never be used by
    // anybody — which is the terminal-versus-recoverable split read off the map rather than from
    // the status name. Refused BEFORE the record, so a write that cannot matter leaves no row.
    const db = fakeDb({ reads: [credentialRow({ status: "deleted" })] });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(out.status).toBe(403);
    expect(body(out)["error"]).toBe("user_not_active");
    expect(String(body(out)["detail"])).toContain("deleted");
    expect(recorded.events).toEqual([]);
    expect(db.updates()).toHaveLength(0);
  });

  it("sets a password for a LOCKED user, because that is the remedy", async () => {
    // The deliberate asymmetry with the self route: an operator setting a password for a
    // locked-out person is how the lockout is cleared, and `setCredential` clears it in the same
    // statement. Checking the lock here would make the remedy unreachable from the surface that
    // exists to apply it.
    const db = fakeDb({
      reads: [credentialRow({ credential_locked_until: "2026-09-01T12:30:00.000Z" })],
      writes: [1],
    });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(out.status).toBe(200);
    expect(body(out)["lockCleared"]).toBe(true);
    expect(db.updates()[0]?.sql).toMatch(/credential_locked_until = NULL/);
  });

  it("files the operator's write at platform scope", async () => {
    const db = fakeDb({ reads: [credentialRow()], writes: [1] });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    await invoke(handlerFor(ctx, SET), {
      principal: principal({ tenantId: TENANT }),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    const event = recorded.events[0];
    expect(event?.operation).toBe(CREDENTIAL_SET_OPERATION);
    // Null is platform scope: a credential is a property of the user and not of any one
    // membership, so filing it under the operator's tenant would file it under an arbitrary one.
    expect(event?.tenantId).toBeNull();
    expect(event?.subjectUserId).toBe(TARGET);
    expect(event?.principalId).toBe(OPERATOR);
    expect(event?.roles).toContain("platform_admin");
    expect(event?.at).toBe(AT);
  });

  it("separates a first password from a replacement in the recorded detail", async () => {
    const first = fakeDb({ reads: [credentialRow({ credential_hash: null })], writes: [1] });
    const { ctx: firstCtx, recorded: firstRec } = ctxFor(new PostgresCredentialStore(first.conn));
    await invoke(handlerFor(firstCtx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(firstRec.events[0]?.detail["hadCredential"]).toBe(false);

    const again = fakeDb({ reads: [credentialRow({ credential_hash: FOREIGN_HASH })], writes: [1] });
    const { ctx: againCtx, recorded: againRec } = ctxFor(new PostgresCredentialStore(again.conn));
    await invoke(handlerFor(againCtx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(againRec.events[0]?.detail["hadCredential"]).toBe(true);
    // An exact key list rather than a spot check, and it is the fence that matters here: the only
    // facts recorded about the previous state are whether there *was* a credential and what status
    // the subject held. Nothing derived from the password itself can join them without failing here.
    expect(Object.keys(againRec.events[0]?.detail ?? {})).toEqual([
      "hadCredential",
      "subjectStatus",
    ]);
  });

  it("pairs the recorded act with a refusal row when the write lost a race", async () => {
    const db = fakeDb({ reads: [credentialRow()], writes: [0] });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    expect(out.status).toBe(404);
    // Two rows, because the record goes before the write: without the second a reader sees a
    // credential set that never landed.
    expect(recorded.events.map((e) => e.operation)).toEqual([
      CREDENTIAL_SET_OPERATION,
      CREDENTIAL_REFUSED_OPERATION,
    ]);
    expect(recorded.events[1]?.detail["attempted"]).toBe(CREDENTIAL_SET_OPERATION);
    expect(recorded.events[1]?.detail["refusal"]).toBe("user_unknown");
  });

  it("puts no password, hash or pepper in any audit payload or response body", async () => {
    const db = fakeDb({ reads: [credentialRow({ credential_hash: FOREIGN_HASH })], writes: [1] });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, SET), {
      principal: principal(),
      params: { id: TARGET },
      parsedBody: setBody(),
    });
    // The one property a reader cannot verify by eye, so it is asserted over the serialized bytes
    // rather than field by field: a field added later is covered without anyone remembering to.
    const written = JSON.stringify({ events: recorded.events, body: body(out) });
    expect(written).not.toContain(NEW_PASSWORD);
    expect(written).not.toContain(PEPPER);
    expect(written).not.toContain(FOREIGN_HASH);
    expect(written).not.toContain("scrypt$");
    // ...while the hash is of course bound into the statement, which is where it belongs.
    expect(String(db.updates()[0]?.params[1])).toContain("scrypt$");
  });
});

/* ----------------------------------------------------------- the self route */

describe("the self-service route", () => {
  function changeBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD, ...over };
  }

  it("401s with no principal", async () => {
    const db = fakeDb();
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: null,
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(401);
    expect(db.captured).toHaveLength(0);
  });

  it("403s not_a_person for a credential that names no person", async () => {
    const db = fakeDb();
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal({ principalKind: "service_account" }),
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(403);
    expect(body(out)["error"]).toBe("not_a_person");
    // A bare api-key spec resolves every such key onto one shared placeholder id, so admitting one
    // here would let any holder of any such key set the password of the row that id names.
    expect(db.captured).toHaveLength(0);
  });

  it("400s a body missing a field or carrying an extra one", async () => {
    const db = fakeDb();
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const handler = handlerFor(ctx, CHANGE);
    const missing = await invoke(handler, {
      principal: principal(),
      params: {},
      parsedBody: { currentPassword: CURRENT_PASSWORD },
    });
    expect(missing.status).toBe(400);
    expect(String(body(missing)["detail"])).toContain("newPassword");

    const extra = await invoke(handler, {
      principal: principal(),
      params: {},
      parsedBody: changeBody({ userId: TARGET }),
    });
    // There is deliberately no subject on this route: a subject parameter would be the operator
    // route without the grant, so naming one is refused rather than ignored. The refusal lands...
    expect(extra.status).toBe(400);
    // ...and does not say which key caused it, which is the same pinned defect as the operator
    // route's -- `unrecognized_keys` has an empty path. It bites harder here, because a client that
    // reasonably sent `userId` is told only `(root)` about the one field this route refuses to have.
    expect(String(body(extra)["detail"])).toContain("(root)");
    expect(String(body(extra)["detail"])).not.toContain("userId");
    expect(db.captured).toHaveLength(0);
  });

  it("404s when the token outlived the registry row", async () => {
    const db = fakeDb({ reads: [null] });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(404);
    expect(body(out)["error"]).toBe("user_unknown");
    expect(recorded.events).toHaveLength(0);
  });

  it("409s no_current_credential rather than claiming the password was wrong", async () => {
    const db = fakeDb({ reads: [credentialRow({ id: OPERATOR, credential_hash: null })] });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(409);
    // *There is no password* is a different fact from *the one you sent did not match*, and
    // conflating them would tell an api-key or SSO user to try harder at something that cannot
    // succeed. The remedy is an operator setting a first one, which is why it is a 409.
    expect(body(out)["error"]).toBe("no_current_credential");
    expect(db.updates()).toHaveLength(0);
  });

  it("401s a wrong password and an unreadable stored hash with one body", async () => {
    const wrong = fakeDb({ reads: [credentialRow({ id: OPERATOR, credential_hash: await storedHash() })] });
    const { ctx: wrongCtx, recorded: wrongRec } = ctxFor(new PostgresCredentialStore(wrong.conn));
    const mismatched = await invoke(handlerFor(wrongCtx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody({ currentPassword: "not-the-current-passphrase" }),
    });
    expect(mismatched.status).toBe(401);
    expect(body(mismatched)["error"]).toBe("current_password_wrong");

    const corrupt = fakeDb({
      reads: [credentialRow({ id: OPERATOR, credential_hash: UNREADABLE_HASH })],
    });
    const { ctx: corruptCtx, recorded: corruptRec } = ctxFor(
      new PostgresCredentialStore(corrupt.conn),
    );
    const unreadable = await invoke(handlerFor(corruptCtx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    // `unreadable_hash` lands here too and is deliberately **not** counted as a failed attempt: a
    // corrupt or foreign-format row says nothing about the password, and counting it would lock a
    // person out of an account whose password they typed correctly. So the caller gets one body for
    // both, and neither path writes a credential.
    expect(unreadable.status).toBe(401);
    expect(body(unreadable)).toEqual(body(mismatched));
    expect(corrupt.updates()).toHaveLength(0);
    expect(wrong.updates()).toHaveLength(0);
    // Each leaves **one** refusal row, and the asymmetry is the point: the two are
    // indistinguishable to the caller and distinguishable in the trail, which is the only place the
    // difference is actionable. This used to assert zero rows, which was the defect it pinned —
    // a wrong possession proof against a live account left no trace at all.
    expect(wrongRec.events).toHaveLength(1);
    expect(corruptRec.events).toHaveLength(1);
    expect(wrongRec.events[0]?.operation).toBe(CREDENTIAL_REFUSED_OPERATION);
    expect(wrongRec.events[0]?.detail["verification"]).toBe("mismatched");
    expect(corruptRec.events[0]?.detail["verification"]).toBe("unreadable_hash");
    expect(wrongRec.failures).toEqual([OPERATOR]);
    expect(corruptRec.failures).toEqual([]);
  });

  it("changes the password and says the existing sessions are not revoked", async () => {
    const db = fakeDb({
      reads: [credentialRow({ id: OPERATOR, credential_hash: await storedHash() })],
      writes: [1],
    });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(200);
    expect(body(out)["credentialChanged"]).toBe(true);
    // Present and false, which is the point: a session token is verified by signature against the
    // JWKS and carries its own expiry, so changing this row cannot revoke one. Saying so is the
    // alternative to a reader assuming a password change logs everyone out.
    expect(body(out)["sessionsRevoked"]).toBe(false);

    const update = db.updates()[0];
    expect(update?.params[0]).toBe(OPERATOR);
    expect(await verifyPassword(NEW_PASSWORD, String(update?.params[1]), PEPPER)).toBe("matched");
  });

  it("files a self-service change against the caller's own tenant", async () => {
    const hash = await storedHash();
    const withTenant = fakeDb({
      reads: [credentialRow({ id: OPERATOR, credential_hash: hash })],
      writes: [1],
    });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(withTenant.conn));
    await invoke(handlerFor(ctx, CHANGE), {
      principal: principal({ tenantId: TENANT }),
      params: {},
      parsedBody: changeBody(),
    });
    // The contrast with the operator route's null: this act is about a person inside a tenant, so
    // the tenant's own auditor is entitled to read it.
    expect(recorded.events[0]?.operation).toBe(CREDENTIAL_CHANGED_OPERATION);
    expect(recorded.events[0]?.tenantId).toBe(TENANT);
    expect(recorded.events[0]?.subjectUserId).toBe(OPERATOR);
    expect(recorded.events[0]?.detail).toEqual({ self: true });

    // ...and null where the credential names no tenant, rather than a fabricated one.
    const noTenant = fakeDb({
      reads: [credentialRow({ id: OPERATOR, credential_hash: hash })],
      writes: [1],
    });
    const { ctx: noneCtx, recorded: noneRec } = ctxFor(new PostgresCredentialStore(noTenant.conn));
    await invoke(handlerFor(noneCtx, CHANGE), {
      principal: principal({ tenantId: null }),
      params: {},
      parsedBody: changeBody(),
    });
    expect(noneRec.events[0]?.tenantId).toBeNull();
  });

  it("503s and writes nothing when the change cannot be recorded", async () => {
    const db = fakeDb({ reads: [credentialRow({ id: OPERATOR, credential_hash: await storedHash() })] });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn), { auditThrows: true });
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(503);
    expect(body(out)["error"]).toBe("unrecordable");
    // Both acts replace the one credential a person authenticates with, so the self route carries
    // the same fence as the operator one — proving the current password does not exempt it.
    expect(db.updates()).toHaveLength(0);
  });

  /* ------------------------------------------------- the lockout, after review */

  it("honours the login's lock and does not verify a password against a locked account", async () => {
    // The defect this closes: the route read the stored hash and neither the lock nor the counter,
    // so the lockout the login enforces was bypassable by anyone holding a session — which is the
    // one credential a stolen browser session already has. The predicate is the login's own.
    const db = fakeDb({
      reads: [
        credentialRow({
          id: OPERATOR,
          credential_hash: await storedHash(),
          credential_locked_until: "2026-09-01T12:30:00.000Z",
        }),
      ],
    });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(429);
    expect(body(out)["error"]).toBe("account_locked");
    // Not counted: hammering a locked account must not extend its own lock, or a caller could keep
    // an account locked forever without ever learning a password (the login's stated rule).
    expect(recorded.failures).toEqual([]);
    // And nothing was written, including by the correct password it never got to check.
    expect(db.updates()).toHaveLength(0);
  });

  it("reads an unparseable lock as locked", async () => {
    // `credentialIsLocked`'s fail-closed arm, asserted at the second caller rather than only at the
    // login: the column is written by one statement from the database clock, so a value this cannot
    // read means something unexpected wrote it.
    const db = fakeDb({
      reads: [
        credentialRow({
          id: OPERATOR,
          credential_hash: await storedHash(),
          credential_locked_until: "not-a-timestamp",
        }),
      ],
    });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(429);
  });

  it("counts a wrong current password and records the refusal", async () => {
    const db = fakeDb({
      reads: [credentialRow({ id: OPERATOR, credential_hash: await storedHash() })],
    });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody({ currentPassword: "not-the-current-one" }),
    });
    expect(out.status).toBe(401);
    expect(body(out)["error"]).toBe("current_password_wrong");
    // The two halves that make it metered and legible: one counted attempt against the one lock,
    // and one refusal row where previously a wrong possession proof left no trace at all.
    expect(recorded.failures).toEqual([OPERATOR]);
    expect(recorded.events).toHaveLength(1);
    expect(recorded.events[0]?.operation).toBe(CREDENTIAL_REFUSED_OPERATION);
    expect(recorded.events[0]?.detail["refusal"]).toBe("current_password_wrong");
    expect(recorded.events[0]?.detail["verification"]).toBe("mismatched");
    expect(db.updates()).toHaveLength(0);
  });

  it("does NOT count an unreadable stored hash", async () => {
    // `REFUSAL_COUNTS_AGAINST_LOCKOUT`'s split, one surface over: a corrupt or foreign-format row
    // says nothing about the password, and counting it would lock a person out of an account whose
    // password they typed correctly. One body for both, so the caller cannot tell them apart.
    const db = fakeDb({
      reads: [credentialRow({ id: OPERATOR, credential_hash: "scrypt$not$a$valid$encoding" })],
    });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(401);
    expect(body(out)["error"]).toBe("current_password_wrong");
    expect(recorded.failures).toEqual([]);
    expect(recorded.events[0]?.detail["verification"]).toBe("unreadable_hash");
  });

  it("refuses rather than 503s when the counter is down", async () => {
    // Reported by the deployment's handler and swallowed here, the login's reasoning: the refusal
    // is already decided and raising would turn a correctly-refused attempt into the one answer
    // that invites a retry.
    const db = fakeDb({
      reads: [credentialRow({ id: OPERATOR, credential_hash: await storedHash() })],
    });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn), { counterThrows: true });
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody({ currentPassword: "wrong" }),
    });
    expect(out.status).toBe(401);
    expect(body(out)["error"]).toBe("current_password_wrong");
  });

  it("403s a suspended account changing its own password", async () => {
    // A session minted before a suspension stays valid until it expires, so a suspended person can
    // still reach this route — and rotating the credential they were suspended from is the one
    // thing the suspension exists to stop.
    const db = fakeDb({
      reads: [
        credentialRow({ id: OPERATOR, status: "suspended", credential_hash: await storedHash() }),
      ],
    });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(403);
    expect(body(out)["error"]).toBe("user_not_active");
    expect(recorded.failures).toEqual([]);
    expect(db.updates()).toHaveLength(0);
  });

  it("refuses a status this binary does not recognise", async () => {
    // `CredentialRecord.status` is a bare string because the column's CHECK is the only thing
    // constraining it, so a row written by a later binary reads as a status with no entry in the
    // map — and `asUserStatus` takes the fail-closed arm rather than indexing with a missing key.
    const db = fakeDb({
      reads: [
        credentialRow({ id: OPERATOR, status: "dormant", credential_hash: await storedHash() }),
      ],
    });
    const { ctx } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    expect(out.status).toBe(403);
    expect(body(out)["error"]).toBe("user_not_active");
  });

  it("puts no password or pepper in its audit payload or response body", async () => {
    const db = fakeDb({
      reads: [credentialRow({ id: OPERATOR, credential_hash: await storedHash() })],
      writes: [1],
    });
    const { ctx, recorded } = ctxFor(new PostgresCredentialStore(db.conn));
    const out = await invoke(handlerFor(ctx, CHANGE), {
      principal: principal(),
      params: {},
      parsedBody: changeBody(),
    });
    const written = JSON.stringify({ events: recorded.events, body: body(out) });
    expect(written).not.toContain(CURRENT_PASSWORD);
    expect(written).not.toContain(NEW_PASSWORD);
    expect(written).not.toContain(PEPPER);
    expect(written).not.toContain("scrypt$");
  });
});
