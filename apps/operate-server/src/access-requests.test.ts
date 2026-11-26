import type { PgConnection, PgQueryResult, UnreadableRow } from "@crossengin/kernel-pg";
import { STARTER_CHART_VERSION, type StarterChartReport } from "@crossengin/operate-runtime";
import { assertBindArity } from "@crossengin/testing";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ACCESS_REQUEST_APPROVED_OPERATION,
  ACCESS_REQUEST_INTAKE_PATH,
  ACCESS_REQUEST_STATUSES,
  ACCESS_REQUEST_TERMS_PATH,
  AccessRequestSweeper,
  PostgresAccessRequestStore,
  RESERVED_TENANT_SLUGS,
  SubmissionWindow,
  buildAccessRequestIntake,
  buildAccessRequestRoutes,
  contactEmailHmacSha256,
  type AccessRequestAuditEvent,
  type AccessRequestRecord,
  type AccessRequestRoutesContext,
  type AccessRequestSubmission,
} from "./access-requests.js";
import type { RawHttpResponse } from "./http.js";
import { DuplicateTenantError, type TenantCreationEvent } from "./platform-admin.js";
import type { TenantRecord } from "./platform-tenants.js";

const REQ = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
const OPERATOR = "99999999-9999-4999-8999-999999999999";
const AT = "2026-11-23T10:00:00.000Z";
const PASSWORD = "correct horse battery staple";
const CONTACT_KEY = new Uint8Array(32).fill(7);

/* ---------------------------------------------------------------- fake conn */

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A recorder that answers only the statements it was scripted for and **throws** on anything else
 * (ADR-0350's rule): an empty answer for a statement whose shape later changed would make every
 * assertion about what that statement found pass vacuously. Every statement is checked for bind
 * arity both ways (ADR-0370), and `meta.access_requests` has no `tenant_id` and no RLS, so a scope
 * predicate or a `set_config` here is refused as the defect it would be.
 */
function fakeConn(script: readonly { match: RegExp; rows?: unknown[]; rowCount?: number }[]): {
  conn: PgConnection;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const query = async <R = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PgQueryResult<R>> => {
    assertBindArity(sql, params);
    if (/(?<!approved_)\btenant_id\b|set_config/.test(sql)) throw new Error(`unscoped table given a scope: ${sql}`);
    captured.push({ sql, params });
    const hit = script.find((s) => s.match.test(sql));
    if (hit === undefined) throw new Error(`unscripted statement: ${sql}`);
    const rows = (hit.rows ?? []) as R[];
    return { rows, rowCount: hit.rowCount ?? rows.length } as PgQueryResult<R>;
  };
  const conn: PgConnection = {
    query,
    transaction: async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    close: async () => undefined,
  } as unknown as PgConnection;
  return { conn, captured };
}

function row(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: REQ,
    company_name: "Acme Ltd",
    requested_slug: "acme",
    contact_name: "Ada Lovelace",
    email: "ada@acme.test",
    message: null,
    terms_version: "2026-11",
    terms_accepted_at: new Date(AT),
    status: "pending",
    created_at: new Date(AT),
    expires_at: new Date("2026-11-26T10:00:00.000Z"),
    decided_at: null,
    decided_by: null,
    decision_reason: null,
    approved_tenant_id: null,
    approved_user_id: null,
    ...over,
  };
}

const SUBMISSION: AccessRequestSubmission = {
  companyName: "Acme Ltd",
  requestedSlug: "acme",
  contactName: "Ada Lovelace",
  email: "Ada@Acme.Test",
  message: null,
  termsVersion: "2026-11",
  termsAcceptedAt: AT,
  createdAt: AT,
  expiresAt: "2026-11-26T10:00:00.000Z",
};

/* ----------------------------------------------------------------- the store */

describe("PostgresAccessRequestStore", () => {
  it("names the table through an options object and refuses a bad schema identifier", () => {
    const { conn } = fakeConn([]);
    expect(() => new PostgresAccessRequestStore(conn, { schema: "meta; drop" })).toThrow(/schema/);
  });

  it("submits in one transaction: an expired pending row for the address goes first", async () => {
    const db = fakeConn([
      { match: /^DELETE FROM meta\.access_requests WHERE email/, rowCount: 1 },
      { match: /^INSERT INTO meta\.access_requests/, rows: [{ id: REQ }] },
    ]);
    const result = await new PostgresAccessRequestStore(db.conn).submit(SUBMISSION);
    expect(result).toEqual({ inserted: true, id: REQ });
    expect(db.captured[0]?.params).toEqual(["ada@acme.test", AT]);
    expect(db.captured[1]?.sql).toContain("ON CONFLICT (email) WHERE status = 'pending' DO NOTHING");
    // The address is normalized by the store, whatever the caller passed.
    expect(db.captured[1]?.params[3]).toBe("ada@acme.test");
  });

  it("reports an absorbed duplicate as not inserted", async () => {
    const db = fakeConn([
      { match: /^DELETE/, rowCount: 0 },
      { match: /^INSERT/, rows: [] },
    ]);
    expect(await new PostgresAccessRequestStore(db.conn).submit(SUBMISSION)).toEqual({
      inserted: false,
      id: null,
    });
  });

  it("counts pending", async () => {
    const db = fakeConn([{ match: /count\(\*\)::int AS count FROM meta\.access_requests WHERE status = 'pending'/, rows: [{ count: 7 }] }]);
    expect(await new PostgresAccessRequestStore(db.conn).countPending()).toBe(7);
  });

  it("reads one row, converting Date columns to ISO instants", async () => {
    const db = fakeConn([{ match: /WHERE id = \$1::uuid$/, rows: [row()] }]);
    const got = await new PostgresAccessRequestStore(db.conn).get(REQ);
    expect(got?.createdAt).toBe(AT);
    expect(got?.status).toBe("pending");
  });

  it("answers null for a non-uuid id without a round trip", async () => {
    const db = fakeConn([]);
    expect(await new PostgresAccessRequestStore(db.conn).get("not-a-uuid")).toBeNull();
    expect(db.captured).toHaveLength(0);
  });

  it("refuses on read a row whose decision fields disagree with its status", async () => {
    const db = fakeConn([{ match: /WHERE id/, rows: [row({ status: "approved" })] }]);
    await expect(new PostgresAccessRequestStore(db.conn).get(REQ)).rejects.toThrow(/decision fields/);
  });

  it("lists newest first, keyset on (created_at, id), with limit + 1", async () => {
    const rows = [row(), row({ id: "55555555-5555-4555-8555-555555555555" })];
    const db = fakeConn([{ match: /ORDER BY created_at DESC, id DESC LIMIT/, rows }]);
    const store = new PostgresAccessRequestStore(db.conn);
    const page = await store.list({ status: "pending", limit: 1 }, () => undefined);
    expect(page.data).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect(db.captured[0]?.params).toEqual(["pending", 2]);

    const next = await store.list({ cursor: page.nextCursor ?? "" }, () => undefined);
    expect(next.nextCursor).toBeNull();
    expect(db.captured[1]?.sql).toContain("(created_at, id) < ($1::timestamptz, $2::uuid)");
    expect(db.captured[1]?.params.slice(0, 2)).toEqual([AT, REQ]);
  });

  it("refuses a cursor it did not mint", async () => {
    const db = fakeConn([]);
    await expect(
      new PostgresAccessRequestStore(db.conn).list({ cursor: "garbage" }, () => undefined),
    ).rejects.toThrow(/cursor/);
  });

  it("reports an unreadable row and keeps the page", async () => {
    const db = fakeConn([
      { match: /ORDER BY/, rows: [row({ status: "bogus" }), row({ id: "55555555-5555-4555-8555-555555555555" })] },
    ]);
    const reported: UnreadableRow[] = [];
    const page = await new PostgresAccessRequestStore(db.conn).list({}, (r) => reported.push(r));
    expect(page.data).toHaveLength(1);
    expect(reported.map((r) => r.identity)).toEqual([REQ]);
  });

  it("counts by status with a total", async () => {
    const db = fakeConn([
      { match: /GROUP BY status/, rows: [{ status: "pending", count: 2 }, { status: "rejected", count: 3 }] },
    ]);
    expect(await new PostgresAccessRequestStore(db.conn).counts()).toEqual({
      pending: 2,
      approved: 0,
      rejected: 3,
      total: 5,
    });
  });

  it("guards an approval on the row: pending and unexpired", async () => {
    const db = fakeConn([{ match: /^UPDATE/, rowCount: 0 }]);
    const landed = await new PostgresAccessRequestStore(db.conn).markApprovedWithin(db.conn, REQ, {
      decidedBy: OPERATOR,
      decidedAt: AT,
      approvedTenantId: TENANT,
      approvedUserId: USER,
    });
    expect(landed).toBe(false);
    expect(db.captured[0]?.sql).toContain("WHERE id = $1::uuid AND status = 'pending' AND expires_at > now()");
  });

  it("rejects one pending request, and all of them", async () => {
    const db = fakeConn([
      { match: /WHERE id = \$1::uuid AND status = 'pending'$/, rowCount: 1 },
      { match: /decision_reason = \$3 WHERE status = 'pending'$/, rowCount: 4 },
    ]);
    const store = new PostgresAccessRequestStore(db.conn);
    const decision = { decidedBy: OPERATOR, decidedAt: AT, decisionReason: "spam" };
    expect(await store.reject(REQ, decision)).toBe(true);
    expect(await store.rejectAllPending(decision)).toBe(4);
  });

  it("sweeps expired pending rows and decided rows past retention", async () => {
    const db = fakeConn([
      { match: /status = 'pending' AND expires_at <=/, rowCount: 2 },
      { match: /status <> 'pending' AND decided_at </, rowCount: 3 },
    ]);
    const out = await new PostgresAccessRequestStore(db.conn).sweep({
      now: new Date(AT),
      retentionDays: 30,
    });
    expect(out).toEqual({ expiredDeleted: 2, decidedDeleted: 3 });
    expect(db.captured[1]?.params).toEqual(["2026-10-24T10:00:00.000Z"]);
  });
});

/* ------------------------------------------------------------------- intake */

const TERMS = {
  termsVersion: "2026-11",
  termsUrl: "https://example.test/terms",
  privacyUrl: "https://example.test/privacy",
};

function intakeFor(opts: {
  terms?: typeof TERMS | null;
  pending?: number;
  maxPending?: number;
  inserted?: boolean;
  window?: SubmissionWindow;
} = {}): {
  call: (method: string, path: string, body?: unknown) => Promise<RawHttpResponse | null>;
  submitted: AccessRequestSubmission[];
} {
  const submitted: AccessRequestSubmission[] = [];
  const intake = buildAccessRequestIntake({
    store: {
      countPending: async () => opts.pending ?? 0,
      submit: async (s) => {
        submitted.push(s);
        return opts.inserted === false ? { inserted: false, id: null } : { inserted: true, id: REQ };
      },
    },
    terms: opts.terms === undefined ? TERMS : opts.terms,
    maxPending: opts.maxPending ?? 200,
    ttlHours: 72,
    retentionDays: 30,
    window: opts.window ?? new SubmissionWindow(30),
    clock: () => new Date(AT),
  });
  return {
    submitted,
    call: (method, path, body) =>
      intake(
        { method, url: path, headers: {} },
        body === undefined ? null : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
      ),
  };
}

const GOOD = {
  companyName: "Acme Ltd",
  contactName: "Ada Lovelace",
  email: "Ada@Acme.test",
  requestedSlug: "acme",
  termsVersion: "2026-11",
  termsAccepted: true,
};

function bodyOf(res: RawHttpResponse | null): unknown {
  if (res === null || res.body === null) throw new Error("no response");
  return JSON.parse(new TextDecoder().decode(res.body));
}

describe("buildAccessRequestIntake", () => {
  it("falls through for any other path", async () => {
    expect(await intakeFor().call("POST", "/v1/auth/token", {})).toBeNull();
  });

  it("publishes the terms, or nulls when closed, never cached", async () => {
    const open = await intakeFor().call("GET", ACCESS_REQUEST_TERMS_PATH);
    expect(open?.status).toBe(200);
    expect(open?.headers["cache-control"]).toBe("no-store");
    // The configured windows travel with the terms, so the privacy notice states this deployment's.
    expect(bodyOf(open)).toEqual({ open: true, ...TERMS, ttlHours: 72, retentionDays: 30 });
    const closed = await intakeFor({ terms: null }).call("GET", ACCESS_REQUEST_TERMS_PATH);
    expect(bodyOf(closed)).toEqual({
      open: false,
      termsVersion: null,
      termsUrl: null,
      privacyUrl: null,
      ttlHours: 72,
      retentionDays: 30,
    });
  });

  it("1. a closed intake is 503 before the body is read", async () => {
    const res = await intakeFor({ terms: null }).call("POST", ACCESS_REQUEST_INTAKE_PATH, "not json");
    expect(res?.status).toBe(503);
    expect(bodyOf(res)).toEqual({ error: "intake_closed" });
  });

  it("2. an invalid body names field paths and nothing the caller sent", async () => {
    const res = await intakeFor().call("POST", ACCESS_REQUEST_INTAKE_PATH, {
      ...GOOD,
      email: "<script>@x",
      termsAccepted: false,
      extra: 1,
    });
    expect(res?.status).toBe(400);
    const body = bodyOf(res) as { error: string; fields: string[] };
    expect(body.error).toBe("invalid_request");
    expect(body.fields).toEqual(expect.arrayContaining(["email", "termsAccepted"]));
    expect(JSON.stringify(body)).not.toContain("script");
  });

  it("2. an oversized body is refused before parsing", async () => {
    const res = await intakeFor().call("POST", ACCESS_REQUEST_INTAKE_PATH, {
      ...GOOD,
      message: "x".repeat(9000),
    });
    expect(res?.status).toBe(400);
  });

  it("3. a filled honeypot answers the same 202 and stores nothing", async () => {
    const h = intakeFor();
    const res = await h.call("POST", ACCESS_REQUEST_INTAKE_PATH, { ...GOOD, ce_hp_extra: "http://spam" });
    expect(res?.status).toBe(202);
    expect(bodyOf(res)).toEqual({ status: "received" });
    expect(h.submitted).toHaveLength(0);
  });

  it("an empty honeypot is a human, and the old field name is no longer accepted", async () => {
    const h = intakeFor();
    expect((await h.call("POST", ACCESS_REQUEST_INTAKE_PATH, { ...GOOD, ce_hp_extra: "" }))?.status).toBe(202);
    expect(h.submitted).toHaveLength(1);
    const old = await h.call("POST", ACCESS_REQUEST_INTAKE_PATH, { ...GOOD, website: "x" });
    expect(old?.status).toBe(400);
  });

  it("4. a stale terms version is 409 terms_changed", async () => {
    const res = await intakeFor().call("POST", ACCESS_REQUEST_INTAKE_PATH, { ...GOOD, termsVersion: "old" });
    expect(res?.status).toBe(409);
    expect(bodyOf(res)).toEqual({ error: "terms_changed" });
  });

  it("5. a reserved slug is 400 slug_reserved", async () => {
    for (const slug of ["admin", "crossengin"]) {
      const res = await intakeFor().call("POST", ACCESS_REQUEST_INTAKE_PATH, { ...GOOD, requestedSlug: slug });
      expect(bodyOf(res)).toEqual({ error: "slug_reserved" });
    }
    expect(RESERVED_TENANT_SLUGS).toHaveLength(21);
  });

  it("6. a full queue is 503 with retry-after", async () => {
    const res = await intakeFor({ pending: 5, maxPending: 5 }).call("POST", ACCESS_REQUEST_INTAKE_PATH, GOOD);
    expect(res?.status).toBe(503);
    expect(res?.headers["retry-after"]).toBeDefined();
    expect(bodyOf(res)).toEqual({ error: "queue_full" });
  });

  it("7. a new request and an absorbed re-submit get byte-identical answers", async () => {
    const fresh = await intakeFor({ inserted: true }).call("POST", ACCESS_REQUEST_INTAKE_PATH, GOOD);
    const dupe = await intakeFor({ inserted: false }).call("POST", ACCESS_REQUEST_INTAKE_PATH, GOOD);
    expect(fresh?.status).toBe(202);
    expect(dupe?.status).toBe(202);
    expect(fresh?.body).toEqual(dupe?.body);
    expect(fresh?.headers).toEqual(dupe?.headers);
  });

  it("stores the normalized address, the terms time and the expiry from the clock", async () => {
    const h = intakeFor();
    await h.call("POST", ACCESS_REQUEST_INTAKE_PATH, { ...GOOD, requestedSlug: "", message: "" });
    expect(h.submitted[0]).toEqual({
      companyName: "Acme Ltd",
      requestedSlug: null,
      contactName: "Ada Lovelace",
      email: "ada@acme.test",
      message: null,
      termsVersion: "2026-11",
      termsAcceptedAt: AT,
      createdAt: AT,
      expiresAt: "2026-11-26T10:00:00.000Z",
    });
  });

  it("applies the process-wide window", async () => {
    const window = new SubmissionWindow(1);
    const h = intakeFor({ window });
    expect((await h.call("POST", ACCESS_REQUEST_INTAKE_PATH, GOOD))?.status).toBe(202);
    const second = await h.call("POST", ACCESS_REQUEST_INTAKE_PATH, GOOD);
    expect(second?.status).toBe(429);
    expect(second?.headers["retry-after"]).toBe("60");
  });

  it("refuses other methods on both paths", async () => {
    expect((await intakeFor().call("GET", ACCESS_REQUEST_INTAKE_PATH))?.status).toBe(405);
    expect((await intakeFor().call("POST", ACCESS_REQUEST_TERMS_PATH, {}))?.status).toBe(405);
  });
});

/* ------------------------------------------------------------------- routes */

function tenantRecord(slug: string): TenantRecord {
  return {
    id: TENANT,
    slug,
    name: "Acme Ltd",
    status: "active",
    tier: "small",
    region: "eu",
    schemaName: `t_${slug}`,
    searchLocale: "simple",
    createdAt: AT,
    updatedAt: AT,
  };
}

function record(over: Partial<AccessRequestRecord> = {}): AccessRequestRecord {
  return {
    id: REQ,
    companyName: "Acme Ltd",
    requestedSlug: "acme",
    contactName: "Ada Lovelace",
    email: "ada@acme.test",
    message: null,
    termsVersion: "2026-11",
    termsAcceptedAt: AT,
    status: "pending",
    createdAt: AT,
    expiresAt: "2026-11-26T10:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    approvedTenantId: null,
    approvedUserId: null,
    ...over,
  };
}

interface Harness {
  readonly ctx: AccessRequestRoutesContext;
  readonly events: AccessRequestAuditEvent[];
  readonly acts: string[];
  readonly creations: TenantCreationEvent[];
  readonly contexts: string[];
  readonly charts: {
    tenantId: string;
    provisioningId: string;
    principalId: string;
    newWorkspace: boolean;
    committed: boolean;
  }[];
  committed: boolean;
}

const CHART_REPORT: StarterChartReport = {
  outcome: "complete",
  version: STARTER_CHART_VERSION,
  created: ["1000", "1100"],
  existing: [],
  refused: [],
  settingsFilled: ["cashAccountCode", "arAccountCode"],
  remittancePosting: "filled",
  settingsSkipped: [],
  settingsDangling: [],
};

const CHART_ACTING_ROLES = ["erp_admin"] as const;

/** A thrown error with a message that must never reach the 201. */
class ChartStoreDown extends Error {
  constructor() {
    super("connection to 10.0.0.5 refused for tenant acme-secret");
    this.name = "ChartStoreDown";
  }
}

function harness(opts: {
  roles?: readonly string[];
  request?: AccessRequestRecord | null;
  existing?: { id: string; email: string; status: string } | null;
  markLands?: boolean;
  createThrows?: Error;
  auditThrows?: boolean;
  declared?: readonly string[];
  shed?: boolean;
  chartThrows?: unknown;
  /** What the in-transaction lock reads, by the database's clock; default the request, live. */
  locked?: { status: string; live: boolean } | null;
  /** The attached user's status under `FOR SHARE`; default the `existing` status. */
  lockedUserStatus?: string | null;
} = {}): Harness {
  const h: Harness = {
    events: [],
    acts: [],
    creations: [],
    contexts: [],
    charts: [],
    committed: false,
    ctx: undefined as unknown as AccessRequestRoutesContext,
  };
  // The approval's transaction. Only the tenant-context statement may reach it directly; every
  // other write goes through a store fake, so anything else here is a statement nobody modelled.
  const tx = {
    query: async (sql: string, params?: readonly unknown[]) => {
      if (/set_config\('app\.current_tenant_id'/.test(sql)) {
        h.contexts.push(String(params?.[0]));
        h.acts.push(`context:${String(params?.[0])}`);
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected SQL on the approval transaction: ${sql}`);
    },
  } as unknown as PgConnection;
  const ctx: AccessRequestRoutesContext = {
    store: {
      get: async () => (opts.request === undefined ? record() : opts.request),
      list: async () => ({ data: [record()], nextCursor: null }),
      counts: async () => ({ pending: 1, approved: 0, rejected: 0, total: 1 }),
      lockPendingWithin: async () => {
        h.acts.push("lockRequest");
        if (opts.locked !== undefined) return opts.locked;
        const r = opts.request === undefined ? record() : opts.request;
        return r === null ? null : { status: r.status, live: true };
      },
      markApprovedWithin: async () => {
        h.acts.push("markApproved");
        return opts.markLands ?? true;
      },
      reject: async () => {
        h.acts.push("reject");
        return true;
      },
      rejectAllPending: async () => {
        h.acts.push("rejectAll");
        return 3;
      },
    },
    tenants: {
      create: async (input, within) => {
        if (opts.createThrows !== undefined) throw opts.createThrows;
        const t = tenantRecord(input.slug);
        h.acts.push("tenant");
        // A throw from `within` is a rollback: nothing is committed and the error propagates.
        await within?.(tx, t);
        h.committed = true;
        return t;
      },
    },
    users: {
      getByEmail: async () =>
        opts.existing === undefined || opts.existing === null
          ? null
          : ({ ...opts.existing } as unknown as Awaited<ReturnType<AccessRequestRoutesContext["users"]["getByEmail"]>>),
      lockUserWithin: async () => {
        h.acts.push("lockUser");
        if (opts.lockedUserStatus !== undefined) return opts.lockedUserStatus;
        return opts.existing?.status ?? null;
      },
      provisionWithin: async (_tx, input, membership) => {
        h.acts.push(`provision:${input.email}`);
        return {
          user: {
            id: USER,
            email: input.email,
            displayName: input.displayName ?? null,
            phoneE164: null,
            status: "active",
            createdAt: AT,
            updatedAt: AT,
            lastLoginAt: null,
          },
          membership: {
            id: MEMBERSHIP,
            userId: USER,
            tenantId: membership?.tenantId ?? TENANT,
            primaryRole: membership?.primaryRole ?? "erp_admin",
            secondaryRoles: [],
            status: "active",
            abacAttributes: {},
            createdAt: AT,
            updatedAt: AT,
          },
        };
      },
      grantMembershipWithin: async (_tx, input) => {
        h.acts.push(`grant:${input.userId}`);
        return {
          id: MEMBERSHIP,
          userId: input.userId,
          tenantId: input.tenantId,
          primaryRole: input.primaryRole,
          secondaryRoles: [],
          status: "active",
          abacAttributes: {},
          createdAt: AT,
          updatedAt: AT,
        };
      },
    },
    credentials: {
      setCredentialWithin: async (_tx, userId) => {
        h.acts.push(`credential:${userId}`);
        return true;
      },
    },
    settings: {
      putWithin: async (_tx, tenantId, settings) => {
        h.acts.push(`settings:${tenantId}:${JSON.stringify(settings)}`);
        return settings;
      },
    },
    principalRoles: () => {
      const roles = opts.roles ?? ["platform_admin", "user_admin", "cred_admin"];
      return { primaryRole: roles[0] ?? "anonymous", secondaryRoles: roles.slice(1) };
    },
    platformAdminRoles: new Set(["platform_admin"]),
    platformUserRoles: new Set(["user_admin"]),
    credentialAdminRoles: new Set(["cred_admin"]),
    platformAuthorityRoles: new Set(["platform_admin", "deletion_verifier"]),
    newTenantRoles: new Set(opts.declared ?? ["erp_admin", "erp_viewer", "deletion_verifier"]),
    defaultPrimaryRole: "erp_admin",
    minPasswordLength: 12,
    hashPassword: async (password) => (opts.shed === true ? null : `hash-of-${password.length.toString()}`),
    contactEmailKey: { key: CONTACT_KEY, pepperVersion: 3 },
    audit: async (e) => {
      if (opts.auditThrows === true) throw new Error("audit down");
      h.events.push(e);
    },
    recordCreation: async (_tx, event) => {
      h.acts.push("recordCreation");
      h.creations.push(event);
    },
    provisionStarterChart: async (tenantId, by) => {
      h.acts.push(`starterChart:${tenantId}`);
      h.charts.push({ tenantId, ...by, committed: h.committed });
      if (opts.chartThrows !== undefined) throw opts.chartThrows;
      return CHART_REPORT;
    },
    starterChartActingRoles: CHART_ACTING_ROLES,
    onUnreadable: () => undefined,
    clock: () => new Date(AT),
  };
  (h as { ctx: AccessRequestRoutesContext }).ctx = ctx;
  return h;
}

type Out = { status: number; body: unknown; headers?: Record<string, string> };

function handler(h: Harness, operationId: string): (input: Record<string, unknown>) => Promise<Out> {
  const found = buildAccessRequestRoutes(h.ctx).find((r) => r.route.operationId === operationId);
  if (found === undefined) throw new Error(`no route ${operationId}`);
  return found.handler as unknown as (input: Record<string, unknown>) => Promise<Out>;
}

const approve = (h: Harness, body: unknown): Promise<Out> =>
  handler(h, "platform.access_requests.approve")({
    principal: { principalId: OPERATOR },
    params: { id: REQ },
    request: {},
    parsedBody: body,
  });

describe("buildAccessRequestRoutes", () => {
  it("declares five routes with stats and reject-pending ahead of every {id} route", () => {
    const routes = buildAccessRequestRoutes(harness().ctx);
    expect(routes.map((r) => r.route.operationId)).toEqual([
      "platform.access_requests.list",
      "platform.access_requests.stats",
      "platform.access_requests.reject_pending",
      "platform.access_requests.approve",
      "platform.access_requests.reject",
    ]);
    const idSeg = routes[3]?.route.pathSegments[3];
    expect(idSeg).toMatchObject({ kind: "parameter", name: "id" });
    expect(idSeg && "pattern" in idSeg ? idSeg.pattern : null).not.toBeNull();
  });

  it("401s with no principal and 403s list/stats/reject without the platform-admin grant", async () => {
    const h = harness({ roles: ["user_admin"] });
    const list = handler(h, "platform.access_requests.list");
    expect((await list({ principal: null, params: {}, request: {} })).status).toBe(401);
    expect((await list({ principal: { principalId: OPERATOR }, params: {}, request: {} })).status).toBe(403);
  });

  it("lists with a status filter and refuses an unknown status or limit", async () => {
    const list = handler(harness(), "platform.access_requests.list");
    const ok = await list({ principal: { principalId: OPERATOR }, params: {}, request: { query: { status: "pending" } } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ data: [record()], page: { nextCursor: null } });
    const bad = await list({ principal: { principalId: OPERATOR }, params: {}, request: { query: { status: "nope" } } });
    expect(bad.status).toBe(400);
    const badLimit = await list({ principal: { principalId: OPERATOR }, params: {}, request: { query: { limit: "-1" } } });
    expect(badLimit.status).toBe(400);
  });

  it("records a rejection before writing it, and refuses when it cannot be recorded", async () => {
    const h = harness();
    const reject = handler(h, "platform.access_requests.reject");
    const out = await reject({ principal: { principalId: OPERATOR }, params: { id: REQ }, request: {}, parsedBody: { reason: "spam" } });
    expect(out.status).toBe(200);
    expect(h.events[0]?.operation).toBe("platform.access_request_rejected");
    expect(h.acts).toEqual(["reject"]);

    const down = harness({ auditThrows: true });
    const refused = await handler(down, "platform.access_requests.reject")({
      principal: { principalId: OPERATOR },
      params: { id: REQ },
      request: {},
      parsedBody: { reason: "spam" },
    });
    expect(refused.status).toBe(503);
    expect(down.acts).toEqual([]);
  });

  it("rejects all pending, recorded first", async () => {
    const h = harness();
    const out = await handler(h, "platform.access_requests.reject_pending")({
      principal: { principalId: OPERATOR },
      params: {},
      request: {},
      parsedBody: { reason: "flood" },
    });
    expect(out.body).toEqual({ rejected: 3 });
    expect(h.events.map((e) => e.operation)).toEqual(["platform.access_requests_rejected"]);
  });

  it.each([
    ["approve", "platform.access_requests.approve", { id: REQ }, { password: PASSWORD }],
    ["reject", "platform.access_requests.reject", { id: REQ }, { reason: "spam" }],
    ["reject-pending", "platform.access_requests.reject_pending", {}, { reason: "flood" }],
  ])(
    "%s refuses a principal whose id the decision row cannot hold, before recording anything",
    async (_name, operationId, params, parsedBody) => {
      // `decided_by` carries the catalog's lowercase uuid-shape CHECK; neither a non-uuid id nor an
      // uppercase one would land, so the decision would be audited and then refused.
      for (const principalId of ["svc:ops", "99999999-9999-4999-8999-99999999999A"]) {
        const h = harness();
        const out = await handler(h, operationId)({ principal: { principalId }, params, request: {}, parsedBody });
        expect(out.status).toBe(403);
        expect(out.body).toMatchObject({ error: "principal_not_recordable" });
        expect(h.events).toEqual([]);
        expect(h.acts).toEqual([]);
      }
    },
  );
});

describe("approve", () => {
  it.each([
    ["platform-admin", ["user_admin", "cred_admin"]],
    ["platform-user", ["platform_admin", "cred_admin"]],
    ["credential-admin", ["platform_admin", "user_admin"]],
  ])("403s without the %s grant and touches nothing", async (_grant, roles) => {
    const h = harness({ roles });
    const out = await approve(h, { password: PASSWORD });
    expect(out.status).toBe(403);
    expect(out.body).toEqual({
      error: "forbidden",
      detail: "approving needs the platform-admin, platform-user and credential-admin grants",
    });
    expect(h.acts).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("onboards a new user in one transaction, in order, and never echoes the password", async () => {
    const h = harness();
    const out = await approve(h, { password: PASSWORD, defaultCurrency: "EUR", paymentTermsDays: 30 });
    expect(out.status).toBe(201);
    expect(out.headers?.["cache-control"]).toBe("no-store");
    expect(h.acts).toEqual([
      "tenant",
      "lockRequest",
      // Set by the approval itself before anything RLS-confined is written.
      `context:${TENANT}`,
      "recordCreation",
      "provision:ada@acme.test",
      `credential:${USER}`,
      `settings:${TENANT}:${JSON.stringify({
        company: { name: "Acme Ltd", email: "ada@acme.test" },
        defaults: { currency: "EUR" },
        finance: { defaultPaymentTermsDays: 30 },
      })}`,
      "markApproved",
      `starterChart:${TENANT}`,
    ]);
    expect(out.body).toMatchObject({
      attachedExistingUser: false,
      passwordSet: true,
      user: { id: USER },
      starterChart: CHART_REPORT,
    });
    // The approval is recorded before the write, carries its facts, and nowhere the password.
    expect(h.events[0]?.operation).toBe(ACCESS_REQUEST_APPROVED_OPERATION);
    expect(h.events[0]?.detail).toEqual({
      requestId: REQ,
      slug: "acme",
      primaryRole: "erp_admin",
      attachedExistingUser: false,
      starterChart: true,
      starterChartActingRoles: ["erp_admin"],
      starterChartVersion: STARTER_CHART_VERSION,
    });
    for (const carrier of [out.body, h.events, h.creations]) {
      expect(JSON.stringify(carrier)).not.toContain(PASSWORD);
    }
    // The creation record carries the permanent terms evidence, with the address as a digest.
    expect(h.creations[0]?.origin).toEqual({
      kind: "access_request",
      requestId: REQ,
      termsVersion: "2026-11",
      termsAcceptedAt: AT,
      contactEmailHmacSha256: contactEmailHmacSha256(CONTACT_KEY, "ada@acme.test"),
      contactEmailHmacPepperVersion: 3,
    });
    expect(JSON.stringify(h.creations)).not.toContain("ada@acme.test");
    // Keyed: an unkeyed digest of the address, which anybody holding the log could compute and
    // compare, is not what is stored.
    const unkeyed = createHash("sha256").update("ada@acme.test", "utf8").digest("hex");
    expect(JSON.stringify(h.creations)).not.toContain(unkeyed);
  });

  it("404s an unknown request, 409s one already decided or expired", async () => {
    expect((await approve(harness({ request: null }), { password: PASSWORD })).status).toBe(404);
    const decided = await approve(
      harness({ request: record({ status: "rejected", decidedAt: AT, decidedBy: OPERATOR, decisionReason: "x" }) }),
      { password: PASSWORD },
    );
    expect(decided.body).toMatchObject({ error: "not_pending" });
    const expired = await approve(harness({ request: record({ expiresAt: "2026-11-22T00:00:00.000Z" }) }), {
      password: PASSWORD,
    });
    expect(expired.body).toEqual({ error: "expired" });
  });

  describe("concurrent approvals (ADR-0479)", () => {
    /** A transaction that answers only the tenant-context statement, as the harness's own does. */
    const TX_PLACEHOLDER = {
      query: async (sql: string) => {
        if (/set_config\('app\.current_tenant_id'/.test(sql)) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected SQL on the approval transaction: ${sql}`);
      },
    } as unknown as PgConnection;

    it("locks the request row first in the transaction, before any write", async () => {
      const h = harness();
      const out = await approve(h, { password: PASSWORD });
      expect(out.status).toBe(201);
      // `tenant` is the INSERT `create` performs before its callback; inside the callback the lock
      // precedes the context, the creation record and every other write.
      expect(h.acts.slice(0, 3)).toEqual(["tenant", "lockRequest", `context:${TENANT}`]);
    });

    it("rolls back and 409s not_pending when the lock finds the request already decided", async () => {
      const h = harness({ locked: { status: "approved", live: true } });
      const out = await approve(h, { password: PASSWORD });
      expect(out.status).toBe(409);
      expect(out.body).toEqual({ error: "not_pending" });
      expect(h.committed).toBe(false);
      expect(h.acts).not.toContain("markApproved");
      expect(h.acts).not.toContain("recordCreation");
    });

    it("409s expired when the database's clock says lapsed though the server's did not", async () => {
      const h = harness({ locked: { status: "pending", live: false } });
      const out = await approve(h, { password: PASSWORD });
      expect(out.body).toEqual({ error: "expired" });
      expect(h.committed).toBe(false);
    });

    it("maps a duplicate-tenant loser to not_pending when the row is no longer pending", async () => {
      // The same-slug race: the loser's tenant INSERT waits on the winner's unique index and fails
      // before it ever reaches its lock. Re-reading the row is what turns the collision into the
      // decision it really is.
      const decided = record({ status: "approved", decidedAt: AT, decidedBy: OPERATOR });
      let reads = 0;
      const h = harness({ createThrows: new DuplicateTenantError("acme") });
      const ctx = {
        ...h.ctx,
        store: { ...h.ctx.store, get: async () => (reads++ === 0 ? record() : decided) },
      };
      const out = await approve({ ...h, ctx }, { password: PASSWORD });
      expect(out.status).toBe(409);
      expect(out.body).toEqual({ error: "not_pending" });
    });

    it("409s user_not_active and rolls back when the attached user was retired before the lock", async () => {
      const h = harness({
        existing: { id: USER, email: "ada@acme.test", status: "active" },
        lockedUserStatus: "suspended",
      });
      const out = await approve(h, { attachExistingUser: true, confirmedExistingOwner: true });
      expect(out.status).toBe(409);
      expect(out.body).toMatchObject({ error: "user_not_active", existingUser: { id: USER, status: "suspended" } });
      expect(h.committed).toBe(false);
      expect(h.acts).not.toContain(`grant:${USER}`);
    });

    it("answers the collision's own code, not an unclassified throw, when the re-read itself fails", async () => {
      let reads = 0;
      const h = harness({ createThrows: new DuplicateTenantError("acme") });
      const ctx = {
        ...h.ctx,
        store: {
          ...h.ctx.store,
          get: async () => {
            if (reads++ === 0) return record();
            throw new Error("connection reset");
          },
        },
      };
      const out = await approve({ ...h, ctx }, { password: PASSWORD });
      expect(out.status).toBe(409);
      expect(out.body).toMatchObject({ error: "tenant_exists" });
    });

    it("keeps tenant_exists when the collision is with some other tenant and the request is still pending", async () => {
      const h = harness({ createThrows: new DuplicateTenantError("acme") });
      const out = await approve(h, { password: PASSWORD });
      expect(out.body).toMatchObject({ error: "tenant_exists" });
    });

    it("serialises two approvals on the row: exactly one 201 and one 409 not_pending", async () => {
      // A fake that models the lock: `lockPendingWithin` waits for the row, then reads the newest
      // committed status (READ COMMITTED's re-check after the lock). This pins the outcome and NOT
      // the lock: `markApprovedWithin`'s row guard alone also yields 201 + 409 here, which is what
      // the ADR measured. The lock is fenced by "rolls back and 409s not_pending when the lock finds
      // the request already decided" above, which fails when the lock's check is removed.
      const row = { status: "pending" };
      let held: Promise<void> = Promise.resolve();
      const both = [harness(), harness()].map((h) => {
        let release: () => void = () => undefined;
        const ctx: AccessRequestRoutesContext = {
          ...h.ctx,
          tenants: {
            create: async (input, within) => {
              const t = tenantRecord(input.slug);
              try {
                await within?.(TX_PLACEHOLDER, t);
              } finally {
                release();
              }
              return t;
            },
          },
          store: {
            ...h.ctx.store,
            lockPendingWithin: async () => {
              const prior = held;
              held = new Promise<void>((r) => (release = r));
              await prior;
              return { status: row.status, live: true };
            },
            markApprovedWithin: async () => {
              if (row.status !== "pending") return false;
              row.status = "approved";
              return true;
            },
          },
        };
        return approve({ ...h, ctx }, { password: PASSWORD });
      });
      const outs = await Promise.all(both);
      expect(outs.map((o) => o.status).sort()).toEqual([201, 409]);
      expect(outs.find((o) => o.status === 409)?.body).toEqual({ error: "not_pending" });
    });
  });

  it("needs a slug, refuses a reserved one, and refuses an undeclared role", async () => {
    const noSlug = await approve(harness({ request: record({ requestedSlug: null }) }), { password: PASSWORD });
    expect(noSlug.status).toBe(422);
    expect(noSlug.body).toMatchObject({ error: "slug_required" });
    const reserved = await approve(harness(), { slug: "admin", password: PASSWORD });
    expect(reserved.body).toEqual({ error: "slug_reserved" });
    const ghost = await approve(harness(), { primaryRole: "ghost_role", password: PASSWORD });
    expect(ghost.status).toBe(422);
    expect(ghost.body).toMatchObject({ error: "role_not_declared" });
  });

  it("refuses granting a platform-authority role the caller does not hold", async () => {
    const h = harness();
    const out = await approve(h, { primaryRole: "deletion_verifier", password: PASSWORD });
    expect(out.status).toBe(403);
    expect(h.acts).toEqual([]);
  });

  it("refuses a malformed currency and a password outside the floor", async () => {
    expect((await approve(harness(), { password: PASSWORD, defaultCurrency: "eur" })).status).toBe(400);
    const short = await approve(harness(), { password: "short" });
    expect(short.body).toMatchObject({ error: "password_invalid" });
    expect((await approve(harness(), {})).body).toMatchObject({ error: "password_invalid" });
  });

  describe("an existing user", () => {
    const existing = { id: USER, email: "ada@acme.test", status: "active" };

    it("is offered rather than attached by default", async () => {
      const out = await approve(harness({ existing }), { password: PASSWORD });
      expect(out.status).toBe(409);
      expect(out.body).toEqual({ error: "user_exists", existingUser: { id: USER, status: "active" } });
    });

    it("is attached with a membership only, and never re-credentialed", async () => {
      const h = harness({ existing });
      const out = await approve(h, { attachExistingUser: true, confirmedExistingOwner: true });
      expect(out.status).toBe(201);
      expect(out.body).toMatchObject({ attachedExistingUser: true, passwordSet: false });
      expect(h.acts.some((a) => a.startsWith("credential:"))).toBe(false);
      expect(h.acts).toContain(`grant:${USER}`);
      // The operator's confirmation is part of the approval record.
      expect(h.events[0]?.detail).toMatchObject({ attachedExistingUser: true, confirmedExistingOwner: true });
    });

    it("refuses the attach without the operator's confirmation of the owner, recording nothing", async () => {
      for (const confirmedExistingOwner of [undefined, false]) {
        const h = harness({ existing });
        const out = await approve(h, {
          attachExistingUser: true,
          ...(confirmedExistingOwner !== undefined ? { confirmedExistingOwner } : {}),
        });
        expect(out.status).toBe(400);
        expect(out.body).toMatchObject({ error: "existing_owner_unconfirmed" });
        expect(h.acts).toEqual([]);
        expect(h.events).toEqual([]);
      }
    });

    it("refuses a password with the attach", async () => {
      const out = await approve(harness({ existing }), {
        attachExistingUser: true,
        confirmedExistingOwner: true,
        password: PASSWORD,
      });
      expect(out.body).toMatchObject({ error: "password_not_applicable" });
    });

    it("refuses one who is not active", async () => {
      const out = await approve(harness({ existing: { ...existing, status: "suspended" } }), {
        attachExistingUser: true,
        confirmedExistingOwner: true,
      });
      expect(out.body).toMatchObject({ error: "user_not_active" });
    });
  });

  it("rolls the whole onboarding back when the decision row is lost", async () => {
    const h = harness({ markLands: false });
    const out = await approve(h, { password: PASSWORD });
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ error: "not_pending" });
    expect(h.committed).toBe(false);
    expect(h.events.map((e) => e.operation)).toEqual([
      "platform.access_request_approved",
      "platform.access_request_refused",
    ]);
    // No workspace was committed, so there is nothing to give a chart to.
    expect(h.charts).toEqual([]);
  });

  it("maps a taken slug to 409 tenant_exists", async () => {
    const h = harness({ createThrows: new DuplicateTenantError("acme") });
    const out = await approve(h, { password: PASSWORD });
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ error: "tenant_exists" });
    expect(h.charts).toEqual([]);
  });

  it("is 503 and writes nothing when the approval cannot be recorded", async () => {
    const h = harness({ auditThrows: true });
    const out = await approve(h, { password: PASSWORD });
    expect(out.status).toBe(503);
    expect(h.acts).toEqual([]);
  });

  describe("the starter chart of accounts", () => {
    it("is provisioned after the approval commits, for the new tenant, as the approving operator", async () => {
      const h = harness();
      const out = await approve(h, { password: PASSWORD });
      expect(out.status).toBe(201);
      // A new workspace, so the chart may switch tax remittance posting on (ADR-0467).
      expect(h.charts).toEqual([
        { tenantId: TENANT, provisioningId: REQ, principalId: OPERATOR, newWorkspace: true, committed: true },
      ]);
      // Last, and only once: strictly after the decision row landed.
      expect(h.acts.indexOf(`starterChart:${TENANT}`)).toBe(h.acts.indexOf("markApproved") + 1);
      expect(h.acts.filter((a) => a.startsWith("starterChart:"))).toHaveLength(1);
      expect((out.body as { starterChart: unknown }).starterChart).toEqual(CHART_REPORT);
    });

    it("an explicit true is the same as absent", async () => {
      const h = harness();
      const out = await approve(h, { password: PASSWORD, starterChart: true });
      expect(out.status).toBe(201);
      expect(h.charts).toHaveLength(1);
      expect(h.events[0]?.detail).toMatchObject({ starterChart: true });
    });

    it("is skipped when the operator says so, and the choice is on the record", async () => {
      const h = harness();
      const out = await approve(h, { password: PASSWORD, starterChart: false });
      expect(out.status).toBe(201);
      expect(h.charts).toEqual([]);
      expect(h.acts.some((a) => a.startsWith("starterChart:"))).toBe(false);
      expect((out.body as { starterChart: unknown }).starterChart).toEqual({ outcome: "not_requested" });
      expect(h.events[0]?.detail).toMatchObject({ starterChart: false });
      expect(h.events[0]?.detail).not.toHaveProperty("starterChartActingRoles");
      expect(h.events[0]?.detail).not.toHaveProperty("starterChartVersion");
    });

    it("records the roles the accounts are written as when the chart is requested", async () => {
      const h = harness();
      const ctx: AccessRequestRoutesContext = { ...h.ctx, starterChartActingRoles: ["erp_admin", "controller"] };
      const found = buildAccessRequestRoutes(ctx).find((r) => r.route.operationId === "platform.access_requests.approve");
      const run = found?.handler as unknown as (input: Record<string, unknown>) => Promise<Out>;
      const out = await run({
        principal: { principalId: OPERATOR },
        params: { id: REQ },
        request: {},
        parsedBody: { password: PASSWORD },
      });
      expect(out.status).toBe(201);
      expect(h.events[0]?.detail).toMatchObject({
        starterChart: true,
        starterChartActingRoles: ["erp_admin", "controller"],
        starterChartVersion: STARTER_CHART_VERSION,
      });
    });

    it("a throw is reported as failed by name, and never undoes the approval", async () => {
      const h = harness({ chartThrows: new ChartStoreDown() });
      const out = await approve(h, { password: PASSWORD });
      expect(out.status).toBe(201);
      expect(h.committed).toBe(true);
      expect(h.acts).toContain("markApproved");
      expect((out.body as { starterChart: unknown }).starterChart).toEqual({
        outcome: "failed",
        error: "ChartStoreDown",
      });
      // The message carries an address and a tenant name; only the error's name is answered.
      expect(JSON.stringify(out.body)).not.toContain("10.0.0.5");
      expect(JSON.stringify(out.body)).not.toContain("acme-secret");
      // Nothing about the failure is recorded as a refusal: the approval stands.
      expect(h.events.map((e) => e.operation)).toEqual([ACCESS_REQUEST_APPROVED_OPERATION]);
    });

    it("a thrown non-Error is reported as unknown", async () => {
      const out = await approve(harness({ chartThrows: "boom" }), { password: PASSWORD });
      expect(out.status).toBe(201);
      expect((out.body as { starterChart: unknown }).starterChart).toEqual({ outcome: "failed", error: "unknown" });
    });

    it("is provisioned for an attached existing user too", async () => {
      const h = harness({ existing: { id: USER, email: "ada@acme.test", status: "active" } });
      const out = await approve(h, { attachExistingUser: true, confirmedExistingOwner: true });
      expect(out.status).toBe(201);
      expect(h.charts).toHaveLength(1);
      expect(h.events[0]?.detail).toMatchObject({
        attachedExistingUser: true,
        starterChart: true,
        starterChartActingRoles: ["erp_admin"],
      });
    });

    it.each([["yes"], [1], [null], [{}]])("refuses a non-boolean %j before anything is recorded", async (value) => {
      const h = harness();
      const out = await approve(h, { password: PASSWORD, starterChart: value });
      expect(out.status).toBe(400);
      expect(out.body).toEqual({ error: "invalid_request", fields: ["starterChart"] });
      expect(h.events).toEqual([]);
      expect(h.acts).toEqual([]);
    });

    it("is never asked when the approval was not recorded", async () => {
      const h = harness({ auditThrows: true });
      expect((await approve(h, { password: PASSWORD })).status).toBe(503);
      expect(h.charts).toEqual([]);
    });
  });

  it("is 503 when the password derivation is shed, before anything is recorded", async () => {
    const h = harness({ shed: true });
    const out = await approve(h, { password: PASSWORD });
    expect(out.status).toBe(503);
    expect(h.events).toEqual([]);
    expect(h.acts).toEqual([]);
  });
});

describe("AccessRequestSweeper", () => {
  it("logs only when something was deleted and reports a failure as one line", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    let answer: { expiredDeleted: number; decidedDeleted: number } | Error = { expiredDeleted: 0, decidedDeleted: 0 };
    const sweeper = new AccessRequestSweeper({
      store: {
        sweep: async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
      retentionDays: 30,
      log: (l) => logs.push(l),
      onError: (l) => errors.push(l),
    });
    await sweeper.runOnce();
    expect(logs).toEqual([]);
    answer = { expiredDeleted: 1, decidedDeleted: 2 };
    await sweeper.runOnce();
    expect(logs).toHaveLength(1);
    answer = new Error("db down");
    expect(await sweeper.runOnce()).toBeNull();
    expect(errors).toEqual(["[access-request] sweep failed: db down"]);
    sweeper.start();
    sweeper.stop();
  });
});

it("ACCESS_REQUEST_STATUSES is the catalog's three", () => {
  expect(ACCESS_REQUEST_STATUSES).toEqual(["pending", "approved", "rejected"]);
});
