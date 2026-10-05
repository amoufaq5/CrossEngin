import { describe, expect, it } from "vitest";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput } from "@crossengin/api-gateway-runtime";
import { EMPTY_READ_STATE_INDEX, type ReadStateIndex } from "@crossengin/notifications";

import {
  ASSERTABLE_READ_SOURCES,
  DEFAULT_UNREAD_SCAN_LIMIT,
  PRIVILEGED_READ_SOURCES,
  VIEWER_BODY_KEYS,
  bodyNamesAViewer,
  buildReadStateRoutes,
  decidePosition,
  decideSource,
  newReadStateId,
  requestedDetail,
  resolveViewer,
  type BackfillAuditEvent,
  type InboxNoticeLike,
  type InboxNoticeQueryLike,
  type ReadStateRoutesContext,
} from "./read-state-routes.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "44444444-4444-4444-4444-444444444444";
const OTHER_USER = "55555555-5555-5555-5555-555555555555";
const DISPATCH = "disp_aaaaaaaabbbbbbbb";
const NOW = new Date("2026-06-01T12:00:00.000Z");

function principal(over: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    principalId: USER,
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

interface Recorder {
  readonly store: ReadStateRoutesContext["store"];
  readonly markReadCalls: Array<Record<string, unknown>>;
  readonly watermarkCalls: Array<Record<string, unknown>>;
  readonly indexCalls: Array<Record<string, unknown>>;
}

function recordingStore(
  over: {
    readonly index?: ReadStateIndex;
    readonly markReadThrows?: boolean;
    readonly watermarkThrows?: boolean;
    readonly indexThrows?: boolean;
    readonly storedReadThroughAt?: string;
  } = {},
): Recorder {
  const markReadCalls: Array<Record<string, unknown>> = [];
  const watermarkCalls: Array<Record<string, unknown>> = [];
  const indexCalls: Array<Record<string, unknown>> = [];
  return {
    markReadCalls,
    watermarkCalls,
    indexCalls,
    store: {
      markRead: async (viewer, dispatchId, input) => {
        markReadCalls.push({ ...viewer, dispatchId, ...input });
        if (over.markReadThrows === true) throw new Error("boom");
        return {
          outcome: "inserted",
          state: {
            id: input.id,
            tenantId: viewer.tenantId,
            userId: viewer.userId,
            dispatchId,
            readAt: input.at,
            source: input.source,
          },
        };
      },
      markAllReadUpTo: async (viewer, input) => {
        watermarkCalls.push({ ...viewer, ...input });
        if (over.watermarkThrows === true) throw new Error("boom");
        const stored = over.storedReadThroughAt ?? input.readThroughAt;
        return {
          outcome: stored === input.readThroughAt ? "advanced" : "unchanged",
          watermark: {
            tenantId: viewer.tenantId,
            userId: viewer.userId,
            readThroughAt: stored,
            updatedAt: input.at,
            source: input.source,
          },
        };
      },
      indexFor: async (viewer) => {
        indexCalls.push({ ...viewer });
        if (over.indexThrows === true) throw new Error("boom");
        return over.index ?? EMPTY_READ_STATE_INDEX;
      },
    },
  };
}

function noticeSource(
  notices: readonly InboxNoticeLike[],
  over: { readonly throws?: boolean; readonly nextCursor?: string | null } = {},
): {
  readonly notices: ReadStateRoutesContext["notices"];
  readonly queries: InboxNoticeQueryLike[];
} {
  const queries: InboxNoticeQueryLike[] = [];
  return {
    queries,
    notices: {
      listForTenant: async (_tenantId, query) => {
        queries.push(query ?? {});
        if (over.throws === true) throw new Error("boom");
        const data =
          query?.dispatchId === undefined
            ? notices
            : notices.filter((n) => n.dispatchId === query.dispatchId);
        return { data, nextCursor: over.nextCursor ?? null };
      },
    },
  };
}

function ctxFor(over: Partial<ReadStateRoutesContext> = {}): ReadStateRoutesContext {
  return {
    store: recordingStore().store,
    notices: noticeSource([{ dispatchId: DISPATCH, queuedAt: "2026-05-01T00:00:00.000Z" }]).notices,
    principalRoles: (p) => ({
      primaryRole: p === null ? "anonymous" : "erp_user",
      secondaryRoles: [],
    }),
    allowedRoles: new Set(["erp_user"]),
    clock: () => NOW,
    newReadStateId: () => "nrs_fixedfixedfixedfixed12",
    ...over,
  };
}

function handlerOf(ctx: ReadStateRoutesContext, index: number): Handler {
  const handler = buildReadStateRoutes(ctx)[index]?.handler;
  if (handler === undefined) throw new Error("no handler built");
  return handler;
}

function inputFor(over: Partial<HandlerInput> = {}): HandlerInput {
  return {
    request: {} as HandlerInput["request"],
    route: {} as HandlerInput["route"],
    principal: principal(),
    params: { dispatchId: DISPATCH },
    parsedBody: null,
    ...over,
  };
}

function withQuery(query: Record<string, string>): Partial<HandlerInput> {
  return { request: { query } as unknown as HandlerInput["request"] };
}

async function call(
  ctx: ReadStateRoutesContext,
  index: number,
  over: Partial<HandlerInput> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const out = await handlerOf(ctx, index)(inputFor(over));
  if (out.kind !== "json") throw new Error(`expected json, got ${out.kind}`);
  return { status: out.status, body: out.body as Record<string, unknown> };
}

const MARK = 0;
const THROUGH = 1;
const UNREAD = 2;

describe("the route declarations", () => {
  it("are three: mark one, advance the watermark, read the count", () => {
    const routes = buildReadStateRoutes(ctxFor());
    expect(routes).toHaveLength(3);
    expect(
      routes.map((r) => [
        r.route.method,
        r.route.pathSegments
          .map((s) => (s.kind === "literal" ? s.value : s.kind === "parameter" ? `:${s.name}` : "*"))
          .join("/"),
      ]),
    ).toEqual([
      ["POST", "v1/notifications/:dispatchId/read"],
      ["POST", "v1/notifications/read-through"],
      ["GET", "v1/notifications/unread"],
    ]);
  });

  it("requires no idempotency key, because both writes restate themselves", () => {
    for (const r of buildReadStateRoutes(ctxFor())) {
      expect(r.route.idempotencyRequired).toBe(false);
    }
  });

  it("refuses to construct a backfill grant with no auditor", () => {
    expect(() =>
      buildReadStateRoutes(ctxFor({ backfillRoles: new Set(["platform_admin"]) })),
    ).toThrow(/no auditBackfill is wired/);
  });

  it("constructs an empty backfill grant without an auditor, since nobody may assert it", () => {
    expect(() => buildReadStateRoutes(ctxFor({ backfillRoles: new Set() }))).not.toThrow();
  });
});

describe("the viewer is the credential", () => {
  it("resolves the user id from the principal", () => {
    const resolution = resolveViewer(ctxFor(), principal());
    expect(resolution.ok).toBe(true);
    expect(resolution.viewer).toEqual({ tenantId: TENANT, userId: USER });
  });

  it("401s an unauthenticated caller", () => {
    const resolution = resolveViewer(ctxFor(), null);
    expect(resolution.denial).toMatchObject({ status: 401 });
  });

  it("403s a caller whose role is not granted", () => {
    const resolution = resolveViewer(ctxFor({ allowedRoles: new Set() }), principal());
    expect(resolution.denial).toMatchObject({ status: 403 });
  });

  it("403s a principal with no resolvable tenant, because read state is keyed on one", () => {
    const resolution = resolveViewer(ctxFor(), principal({ tenantId: null }));
    expect(resolution.denial).toMatchObject({ status: 403 });
    expect(JSON.stringify(resolution.denial)).toContain("no tenant resolves");
  });

  it("403s a service account: a machine fetch is not a person having read their mail", () => {
    const resolution = resolveViewer(ctxFor(), principal({ principalKind: "service_account" }));
    expect(resolution.denial).toMatchObject({ status: 403 });
    expect(JSON.stringify(resolution.denial)).toContain("read state is per user");
  });

  it("403s a principal id that is not a uuid", () => {
    const resolution = resolveViewer(ctxFor(), principal({ principalId: "not-a-uuid" }));
    expect(resolution.denial).toMatchObject({ status: 403 });
  });

  it("writes the credential's user id, never the body's", async () => {
    const store = recordingStore();
    const ctx = ctxFor({ store: store.store });
    const res = await call(ctx, MARK, { principal: principal({ principalId: USER }) });
    expect(res.status).toBe(200);
    expect(store.markReadCalls[0]).toMatchObject({ tenantId: TENANT, userId: USER });
  });

  it("refuses a body naming a userId rather than ignoring it", async () => {
    const store = recordingStore();
    const res = await call(ctxFor({ store: store.store }), MARK, {
      parsedBody: { userId: OTHER_USER },
    });
    expect(res.status).toBe(400);
    expect(res.body["detail"]).toContain("userId is not accepted");
    expect(store.markReadCalls).toHaveLength(0);
  });

  it("refuses every viewer-naming body key, on both write routes", async () => {
    for (const key of VIEWER_BODY_KEYS) {
      const one = await call(ctxFor(), MARK, { parsedBody: { [key]: OTHER_USER } });
      expect(one.status).toBe(400);
      const through = await call(ctxFor(), THROUGH, {
        parsedBody: { [key]: OTHER_USER, readThroughAt: NOW.toISOString() },
      });
      expect(through.status).toBe(400);
    }
    expect(bodyNamesAViewer({ source: "user_action" })).toBeNull();
    expect(bodyNamesAViewer(null)).toBeNull();
  });

  it("reads the unread count for the credential's viewer only", async () => {
    const store = recordingStore();
    const res = await call(ctxFor({ store: store.store }), UNREAD);
    expect(res.status).toBe(200);
    expect(store.indexCalls).toEqual([{ tenantId: TENANT, userId: USER }]);
    expect(res.body["viewer"]).toEqual({ tenantId: TENANT, userId: USER });
  });
});

describe("source is not the caller's to choose freely", () => {
  it("defaults each surface to the act it performs", () => {
    expect(decideSource(undefined, "one", false)).toEqual({ kind: "ok", source: "user_action" });
    expect(decideSource(undefined, "through", false)).toEqual({
      kind: "ok",
      source: "bulk_mark_read",
    });
  });

  it("names system_backfill as the one privileged source", () => {
    expect(PRIVILEGED_READ_SOURCES).toEqual(["system_backfill"]);
  });

  it("never lets an HTTP caller assert digest_rollup, on either surface", () => {
    for (const kind of ["one", "through"] as const) {
      expect(ASSERTABLE_READ_SOURCES[kind]).not.toContain("digest_rollup");
      expect(decideSource("digest_rollup", kind, true)).toMatchObject({ kind: "invalid" });
    }
  });

  it("400s a source no role could ever assert here, and 403s one a role lacks", () => {
    // Different facts: a 403 on `digest_rollup` would imply some grant could unlock it.
    expect(decideSource("digest_rollup", "through", true)).toMatchObject({ kind: "invalid" });
    expect(decideSource("system_backfill", "through", false)).toMatchObject({ kind: "ungranted" });
    expect(decideSource("system_backfill", "through", true)).toEqual({
      kind: "ok",
      source: "system_backfill",
    });
  });

  it("refuses system_backfill on the per-notice route even for a granted role", () => {
    expect(decideSource("system_backfill", "one", true)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a non-string and an unknown source", () => {
    expect(decideSource(7, "one", false)).toMatchObject({ kind: "invalid" });
    expect(decideSource("whatever", "one", false)).toMatchObject({ kind: "invalid" });
  });

  it("403s an ungranted backfill over HTTP and records the denial best-effort", async () => {
    const seen: BackfillAuditEvent[] = [];
    const res = await call(
      ctxFor({
        backfillRoles: new Set(["platform_admin"]),
        auditBackfill: async (e) => {
          seen.push(e);
        },
      }),
      THROUGH,
      { parsedBody: { source: "system_backfill", readThroughAt: NOW.toISOString() } },
    );
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.granted).toBe(false);
  });

  it("does not turn a failed denial record into a 503", async () => {
    const res = await call(
      ctxFor({
        backfillRoles: new Set(["platform_admin"]),
        auditBackfill: async () => {
          throw new Error("recorder down");
        },
      }),
      THROUGH,
      { parsedBody: { source: "system_backfill", readThroughAt: NOW.toISOString() } },
    );
    expect(res.status).toBe(403);
  });

  it("records a granted backfill before it writes, and refuses when it cannot", async () => {
    const order: string[] = [];
    const store = recordingStore();
    const granting = ctxFor({
      store: store.store,
      principalRoles: () => ({ primaryRole: "erp_user", secondaryRoles: ["platform_admin"] }),
      backfillRoles: new Set(["platform_admin"]),
      auditBackfill: async () => {
        order.push("audit");
      },
    });
    const ok = await call(granting, THROUGH, {
      parsedBody: { source: "system_backfill", readThroughAt: NOW.toISOString() },
    });
    expect(ok.status).toBe(200);
    expect(order).toEqual(["audit"]);
    expect(store.watermarkCalls[0]).toMatchObject({ source: "system_backfill" });

    const refusing = ctxFor({
      principalRoles: () => ({ primaryRole: "erp_user", secondaryRoles: ["platform_admin"] }),
      backfillRoles: new Set(["platform_admin"]),
      auditBackfill: async () => {
        throw new Error("recorder down");
      },
    });
    const denied = await call(refusing, THROUGH, {
      parsedBody: { source: "system_backfill", readThroughAt: NOW.toISOString() },
    });
    expect(denied.status).toBe(503);
    expect(denied.body["error"]).toBe("audit_unavailable");
  });

  it("records only the clamped position, which is the figure that says how much was read", async () => {
    const seen: BackfillAuditEvent[] = [];
    const ctx = ctxFor({
      principalRoles: () => ({ primaryRole: "erp_user", secondaryRoles: ["platform_admin"] }),
      backfillRoles: new Set(["platform_admin"]),
      auditBackfill: async (e) => {
        seen.push(e);
      },
    });
    await call(ctx, THROUGH, {
      parsedBody: { source: "system_backfill", readThroughAt: "2030-01-01T00:00:00.000Z" },
    });
    expect(seen[0]?.readThroughAt).toBe(NOW.toISOString());
  });
});

describe("the watermark position is the server's clock", () => {
  it("clamps a future position to now and says it clamped", async () => {
    const store = recordingStore();
    const res = await call(ctxFor({ store: store.store }), THROUGH, {
      parsedBody: { readThroughAt: "2030-01-01T00:00:00.000Z" },
    });
    expect(res.status).toBe(200);
    expect(res.body["clamped"]).toBe(true);
    expect(store.watermarkCalls[0]?.["readThroughAt"]).toBe(NOW.toISOString());
    expect(res.body["requestedReadThroughAt"]).toBe("2030-01-01T00:00:00.000Z");
  });

  it("passes a past position through unclamped", async () => {
    const store = recordingStore();
    const res = await call(ctxFor({ store: store.store }), THROUGH, {
      parsedBody: { readThroughAt: "2026-05-01T00:00:00.000Z" },
    });
    expect(res.body["clamped"]).toBe(false);
    expect(store.watermarkCalls[0]?.["readThroughAt"]).toBe("2026-05-01T00:00:00.000Z");
  });

  it("stamps the write time from the clock, never from the body", async () => {
    const store = recordingStore();
    await call(ctxFor({ store: store.store }), THROUGH, {
      parsedBody: { readThroughAt: "2026-05-01T00:00:00.000Z", at: "1999-01-01T00:00:00.000Z" },
    });
    expect(store.watermarkCalls[0]?.["at"]).toBe(NOW.toISOString());
  });

  it("requires readThroughAt, because silence would mean the maximal position", () => {
    expect(decidePosition(undefined)).toMatchObject({ kind: "invalid" });
    expect(decidePosition(null)).toMatchObject({ kind: "invalid" });
    expect(decidePosition(123)).toMatchObject({ kind: "invalid" });
    expect(decidePosition("not a date")).toMatchObject({ kind: "invalid" });
    expect(decidePosition("2026-05-01T00:00:00.000Z")).toMatchObject({ kind: "ok" });
  });

  it("400s a missing position over HTTP", async () => {
    const res = await call(ctxFor(), THROUGH, { parsedBody: {} });
    expect(res.status).toBe(400);
    expect(res.body["detail"]).toContain("readThroughAt is required");
  });

  it("reports `unchanged` when the store's GREATEST kept an older position", async () => {
    const store = recordingStore({ storedReadThroughAt: "2026-05-20T00:00:00.000Z" });
    const res = await call(ctxFor({ store: store.store }), THROUGH, {
      parsedBody: { readThroughAt: "2026-05-01T00:00:00.000Z" },
    });
    expect(res.body["outcome"]).toBe("unchanged");
  });
});

describe("marking one notice read", () => {
  it("returns the stored state, so readAt is the first read and not this one", async () => {
    const res = await call(ctxFor(), MARK, {});
    expect(res.status).toBe(200);
    expect(res.body["outcome"]).toBe("inserted");
    expect(res.body["readState"]).toMatchObject({
      id: "nrs_fixedfixedfixedfixed12",
      dispatchId: DISPATCH,
      source: "user_action",
    });
  });

  it("400s a dispatch id that is not a disp_… identifier", async () => {
    const res = await call(ctxFor(), MARK, { params: { dispatchId: TENANT } });
    expect(res.status).toBe(400);
  });

  it("404s a notice outside this viewer's inbox rather than confirming it exists", async () => {
    const source = noticeSource([]);
    const store = recordingStore();
    const res = await call(ctxFor({ notices: source.notices, store: store.store }), MARK, {});
    expect(res.status).toBe(404);
    expect(store.markReadCalls).toHaveLength(0);
  });

  it("looks the notice up inside the tenant and under the recipient filter", async () => {
    const source = noticeSource([{ dispatchId: DISPATCH, queuedAt: "2026-05-01T00:00:00.000Z" }]);
    await call(
      ctxFor({
        notices: source.notices,
        resolveIdentity: async () => ({ addressHashes: ["a".repeat(64)] }),
      }),
      MARK,
      {},
    );
    expect(source.queries[0]).toEqual({
      dispatchId: DISPATCH,
      limit: 1,
      recipientAddressSha256: ["a".repeat(64)],
    });
  });

  it("mints an nrs_ id the contract accepts", () => {
    expect(newReadStateId()).toMatch(/^nrs_[A-Za-z0-9_-]{8,40}$/);
  });

  it("503s when the store cannot record, with no store detail leaked", async () => {
    const store = recordingStore({ markReadThrows: true });
    const res = await call(ctxFor({ store: store.store }), MARK, {});
    expect(res.status).toBe(503);
    expect(res.body["error"]).toBe("read_state_unavailable");
    expect(JSON.stringify(res.body)).not.toContain("boom");
  });

  it("503s when the inbox itself cannot be read", async () => {
    const source = noticeSource([], { throws: true });
    const res = await call(ctxFor({ notices: source.notices }), MARK, {});
    expect(res.status).toBe(503);
    expect(res.body["error"]).toBe("inbox_unavailable");
  });
});

describe("the unread count consults the notices", () => {
  const notices: readonly InboxNoticeLike[] = [
    { dispatchId: "disp_oooooooo1111", queuedAt: "2026-05-01T00:00:00.000Z" },
    { dispatchId: "disp_oooooooo2222", queuedAt: "2026-05-20T00:00:00.000Z" },
    { dispatchId: "disp_oooooooo3333", queuedAt: "2026-05-30T00:00:00.000Z" },
  ];

  it("counts every notice unread when nothing has been read", async () => {
    const res = await call(ctxFor({ notices: noticeSource(notices).notices }), UNREAD);
    expect(res.body["unread"]).toBe(3);
    expect(res.body["examined"]).toBe(3);
    expect(res.body["readThroughAt"]).toBeNull();
  });

  it("honours the per-notice rows and the watermark together", async () => {
    const index: ReadStateIndex = {
      readDispatchIds: new Set(["disp_oooooooo3333"]),
      readThroughMs: Date.parse("2026-05-10T00:00:00.000Z"),
    };
    const res = await call(
      ctxFor({ notices: noticeSource(notices).notices, store: recordingStore({ index }).store }),
      UNREAD,
    );
    // The watermark covers the 1st; the row covers the 3rd; only the 2nd is left.
    expect(res.body["unread"]).toBe(1);
    expect(res.body["readThroughAt"]).toBe("2026-05-10T00:00:00.000Z");
  });

  it("shows a notice whose queuedAt cannot be parsed, preserving the fail-open direction", async () => {
    const index: ReadStateIndex = {
      readDispatchIds: new Set(),
      readThroughMs: Date.parse("2030-01-01T00:00:00.000Z"),
    };
    const broken = [{ dispatchId: "disp_brokenbroken11", queuedAt: "not-a-timestamp" }];
    const res = await call(
      ctxFor({ notices: noticeSource(broken).notices, store: recordingStore({ index }).store }),
      UNREAD,
    );
    // A watermark four years ahead of it would file it read if the timestamp were trusted.
    expect(res.body["unread"]).toBe(1);
  });

  it("returns the partition only when asked for it", async () => {
    const index: ReadStateIndex = {
      readDispatchIds: new Set(["disp_oooooooo1111"]),
      readThroughMs: null,
    };
    const base = {
      notices: noticeSource(notices).notices,
      store: recordingStore({ index }).store,
    };
    const counted = await call(ctxFor(base), UNREAD);
    expect(counted.body["notices"]).toBeUndefined();
    const split = await call(ctxFor(base), UNREAD, withQuery({ detail: "partition" }));
    expect(split.body["notices"]).toEqual({
      read: ["disp_oooooooo1111"],
      unread: ["disp_oooooooo2222", "disp_oooooooo3333"],
    });
    expect(requestedDetail(undefined)).toBe("count");
    expect(requestedDetail("nonsense")).toBe("count");
    expect(requestedDetail("partition")).toBe("partition");
  });

  it("says when the page it examined was not the whole inbox", async () => {
    const source = noticeSource(notices, { nextCursor: "c2" });
    const res = await call(ctxFor({ notices: source.notices }), UNREAD);
    expect(res.body["truncated"]).toBe(true);
    expect(source.queries[0]?.limit).toBe(DEFAULT_UNREAD_SCAN_LIMIT);
  });

  it("counts nothing and reports self scope when the viewer's identity cannot resolve", async () => {
    const source = noticeSource(notices);
    const res = await call(
      ctxFor({
        notices: source.notices,
        resolveIdentity: async () => {
          throw new Error("directory down");
        },
      }),
      UNREAD,
    );
    // An empty hash list means "no addresses", never "every address".
    expect(source.queries[0]?.recipientAddressSha256).toEqual([]);
    expect(res.body["scope"]).toBe("self");
  });

  it("narrows the count to one channel when asked, and echoes which", async () => {
    const source = noticeSource(notices);
    const res = await call(
      ctxFor({ notices: source.notices }),
      UNREAD,
      withQuery({ channel: "in_app" }),
    );
    expect(source.queries[0]?.channel).toBe("in_app");
    expect(res.body["channel"]).toBe("in_app");
    const all = noticeSource(notices);
    await call(ctxFor({ notices: all.notices }), UNREAD, withQuery({ channel: "" }));
    expect(all.queries[0]?.channel).toBeUndefined();
  });

  it("reports tenant scope when no identity resolver is wired at all", async () => {
    const res = await call(ctxFor({ notices: noticeSource(notices).notices }), UNREAD);
    expect(res.body["scope"]).toBe("tenant");
  });

  it("503s when the read state cannot be read", async () => {
    const res = await call(ctxFor({ store: recordingStore({ indexThrows: true }).store }), UNREAD);
    expect(res.status).toBe(503);
  });

  it("401s and 403s the unread route on the same terms as the writes", async () => {
    expect((await call(ctxFor(), UNREAD, { principal: null })).status).toBe(401);
    expect((await call(ctxFor({ allowedRoles: new Set() }), UNREAD)).status).toBe(403);
  });
});
