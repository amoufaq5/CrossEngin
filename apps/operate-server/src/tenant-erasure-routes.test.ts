import { describe, expect, it } from "vitest";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput } from "@crossengin/api-gateway-runtime";

import {
  EraseSchemaInputSchema,
  TENANT_SCHEMA_ERASED_OPERATION,
  TENANT_SCHEMA_ERASE_REFUSED_OPERATION,
  TENANT_SCHEMA_SURVEY_OPERATION,
  buildTenantErasureRoutes,
  erasureScopeView,
  type SchemaErasureLike,
  type SchemaSurveyLike,
  type TenantErasureEvent,
  type TenantErasureRoutesContext,
} from "./tenant-erasure-routes.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const SCHEMA = "t_3f2a1b4c5d6e4f708192a3b4c5d6e7f8";
const CALLER = "11111111-1111-1111-1111-111111111111";
const APPROVER = "22222222-2222-2222-2222-222222222222";

function principal(over: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    principalId: CALLER,
    tenantId: null,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-10-03T00:00:00.000Z",
    ...over,
  };
}

function surveyOf(over: Partial<SchemaSurveyLike> = {}): SchemaSurveyLike {
  return {
    tenantId: TENANT,
    schema: SCHEMA,
    exists: true,
    relations: [
      { table: "invoice", rowCount: 12, storageBytes: 8192 },
      { table: "line", rowCount: 40, storageBytes: 4096 },
    ],
    rowCount: 52,
    storageBytes: 12288,
    collateral: [],
    ...over,
  };
}

function erasureOf(over: Partial<SchemaErasureLike> = {}): SchemaErasureLike {
  return {
    tenantId: TENANT,
    schema: SCHEMA,
    erased: true,
    alreadyAbsent: false,
    statements: [`DROP SCHEMA "${SCHEMA}" CASCADE;`],
    refusals: [],
    erasedRelations: [
      { table: "invoice", rowCount: 12, storageBytes: 8192 },
      { table: "line", rowCount: 40, storageBytes: 4096 },
    ],
    rowCount: 52,
    storageBytes: 12288,
    erasedAt: "2026-10-03T00:00:00.000Z",
    ...over,
  };
}

interface Harness {
  readonly ctx: TenantErasureRoutesContext;
  readonly events: TenantErasureEvent[];
  readonly eraseCalls: Array<{ tenantId: string; executedBy: string; approvedBy: string }>;
}

function harness(
  over: Partial<TenantErasureRoutesContext> = {},
  behaviour: {
    readonly survey?: SchemaSurveyLike | (() => never);
    readonly erasure?: SchemaErasureLike | (() => never);
    readonly recordThrows?: boolean;
  } = {},
): Harness {
  const events: TenantErasureEvent[] = [];
  const eraseCalls: Array<{ tenantId: string; executedBy: string; approvedBy: string }> = [];
  const ctx: TenantErasureRoutesContext = {
    eraser: {
      survey: async (tenantId): Promise<SchemaSurveyLike> => {
        const s = behaviour.survey ?? surveyOf();
        if (typeof s === "function") s();
        return { ...(s as SchemaSurveyLike), tenantId };
      },
      erase: async (tenantId, authority): Promise<SchemaErasureLike> => {
        eraseCalls.push({ tenantId, ...authority });
        const e = behaviour.erasure ?? erasureOf();
        if (typeof e === "function") e();
        return e as SchemaErasureLike;
      },
    },
    principalRoles: (p) => ({
      primaryRole: p === null ? "anonymous" : "platform_admin",
      secondaryRoles: [],
    }),
    adminRoles: new Set(["platform_admin"]),
    recordAction: async (event): Promise<void> => {
      if (behaviour.recordThrows === true) throw new Error("meta.audit_log is unreachable");
      events.push(event);
    },
    clock: () => new Date("2026-10-03T00:00:00.000Z"),
    ...over,
  };
  return { ctx, events, eraseCalls };
}

function handlerFor(ctx: TenantErasureRoutesContext, op: string): Handler {
  const found = buildTenantErasureRoutes(ctx).find((r) => r.route.operationId === op);
  if (found === undefined) throw new Error(`no route for ${op}`);
  return found.handler;
}

function inputFor(over: Partial<HandlerInput> = {}): HandlerInput {
  return {
    request: {} as HandlerInput["request"],
    route: {} as HandlerInput["route"],
    principal: principal(),
    params: { id: TENANT },
    parsedBody: null,
    ...over,
  };
}

async function call(
  ctx: TenantErasureRoutesContext,
  op: string,
  over: Partial<HandlerInput> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const out = await handlerFor(ctx, op)(inputFor(over));
  if (out.kind !== "json") throw new Error(`expected json, got ${out.kind}`);
  return { status: out.status, body: out.body as Record<string, unknown> };
}

const SURVEY = "platform.tenants.schema";
const ERASE = "platform.tenants.eraseSchema";
const BODY = { approvedBy: APPROVER, confirmTenantId: TENANT };

describe("the route declarations", () => {
  it("are a read-only survey and a POST erase under /v1/platform/tenants/{id}", () => {
    const routes = buildTenantErasureRoutes(harness().ctx);
    expect(routes).toHaveLength(2);
    const paths = routes.map((r) => ({
      method: r.route.method,
      path: r.route.pathSegments
        .map((s) => (s.kind === "literal" ? s.value : s.kind === "parameter" ? `:${s.name}` : "*"))
        .join("/"),
    }));
    expect(paths).toEqual([
      { method: "GET", path: "v1/platform/tenants/:id/schema" },
      { method: "POST", path: "v1/platform/tenants/:id/erase-schema" },
    ]);
  });

  it("needs no idempotency key, because a second erase reports alreadyAbsent", () => {
    for (const r of buildTenantErasureRoutes(harness().ctx)) {
      expect(r.route.idempotencyRequired).toBe(false);
    }
  });
});

describe("EraseSchemaInputSchema", () => {
  it("requires both an approver and a confirmed tenant id", () => {
    expect(EraseSchemaInputSchema.safeParse(BODY).success).toBe(true);
    expect(EraseSchemaInputSchema.safeParse({ approvedBy: APPROVER }).success).toBe(false);
    expect(EraseSchemaInputSchema.safeParse({ confirmTenantId: TENANT }).success).toBe(false);
    expect(EraseSchemaInputSchema.safeParse({ ...BODY, extra: 1 }).success).toBe(false);
    expect(EraseSchemaInputSchema.safeParse({ ...BODY, confirmTenantId: "nope" }).success).toBe(false);
  });
});

describe("the survey route", () => {
  it("reports what a deletion would destroy, schema-qualified", async () => {
    const { ctx } = harness();
    const res = await call(ctx, SURVEY);
    expect(res.status).toBe(200);
    expect(res.body["schema"]).toBe(SCHEMA);
    expect(res.body["tables"]).toEqual([
      { table: `${SCHEMA}.invoice`, rowCount: 12, storageBytes: 8192 },
      { table: `${SCHEMA}.line`, rowCount: 40, storageBytes: 4096 },
    ]);
    expect(res.body["rowCount"]).toBe(52);
    expect(res.body["erasable"]).toBe(true);
  });

  it("distinguishes 'nothing here' from 'blocked'", async () => {
    const absent = harness({}, { survey: surveyOf({ exists: false, relations: [], rowCount: 0 }) });
    expect((await call(absent.ctx, SURVEY)).body["erasable"]).toBe(false);
    const blocked = harness(
      {},
      { survey: surveyOf({ collateral: [{ description: "view public.x", schema: "public" }] }) },
    );
    const res = await call(blocked.ctx, SURVEY);
    expect(res.body["erasable"]).toBe(false);
    expect(res.body["collateral"]).toEqual([{ description: "view public.x", schema: "public" }]);
  });

  it("records the survey, because it reads exactly what a deletion would destroy", async () => {
    const { ctx, events } = harness();
    await call(ctx, SURVEY);
    expect(events).toHaveLength(1);
    expect(events[0]?.operation).toBe(TENANT_SCHEMA_SURVEY_OPERATION);
    expect(events[0]?.approvedBy).toBeNull();
    expect(events[0]?.tables).toEqual([`${SCHEMA}.invoice`, `${SCHEMA}.line`]);
  });

  it("still answers when the record cannot be written, since nothing was destroyed", async () => {
    const seen: string[] = [];
    const { ctx } = harness({ onRecordError: (_e, op) => seen.push(op) }, { recordThrows: true });
    expect((await call(ctx, SURVEY)).status).toBe(200);
    expect(seen).toEqual([TENANT_SCHEMA_SURVEY_OPERATION]);
  });

  it("401s with no principal, 403s an ungranted role, 403s an empty grant", async () => {
    expect((await call(harness().ctx, SURVEY, { principal: null })).status).toBe(401);
    const cashier = harness({ principalRoles: () => ({ primaryRole: "cashier", secondaryRoles: [] }) });
    expect((await call(cashier.ctx, SURVEY)).status).toBe(403);
    const ungranted = harness({ adminRoles: new Set() });
    expect((await call(ungranted.ctx, SURVEY)).status).toBe(403);
  });

  it("400s a non-uuid tenant id", async () => {
    expect((await call(harness().ctx, SURVEY, { params: { id: "nope" } })).status).toBe(400);
  });

  it("503s a survey failure without leaking internals", async () => {
    const { ctx } = harness(
      {},
      {
        survey: (): never => {
          throw new Error('relation "t_abc.invoice" does not exist');
        },
      },
    );
    const res = await call(ctx, SURVEY);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("t_abc");
  });
});

describe("the erase route", () => {
  it("erases and returns the scope a tombstone commits to", async () => {
    const { ctx, eraseCalls } = harness();
    const res = await call(ctx, ERASE, { parsedBody: BODY });
    expect(res.status).toBe(200);
    expect(res.body["erased"]).toBe(true);
    expect(res.body["scope"]).toEqual({
      schemas: [SCHEMA],
      tables: [`${SCHEMA}.invoice`, `${SCHEMA}.line`],
      rowCount: 52,
      storageBytes: 12288,
    });
    expect(eraseCalls).toEqual([{ tenantId: TENANT, executedBy: CALLER, approvedBy: APPROVER }]);
  });

  it("takes executedBy from the credential, never from the body", async () => {
    const { ctx, eraseCalls } = harness();
    await call(ctx, ERASE, { parsedBody: { ...BODY, executedBy: "somebody-else" } });
    // The body key is also rejected by the strict schema, so this 400s rather than mis-attributing.
    expect(eraseCalls).toEqual([]);
    const ok = harness();
    await call(ok.ctx, ERASE, { parsedBody: BODY });
    expect(ok.eraseCalls[0]?.executedBy).toBe(CALLER);
  });

  it("refuses when the caller is also the approver", async () => {
    const { ctx, eraseCalls } = harness();
    const res = await call(ctx, ERASE, { parsedBody: { ...BODY, approvedBy: CALLER } });
    expect(res.status).toBe(403);
    expect(res.body["error"]).toBe("four_eyes_required");
    // Refused before the eraser is reached, so no survey runs for a request that cannot proceed.
    expect(eraseCalls).toEqual([]);
  });

  it("requires the body to confirm the tenant in the path", async () => {
    const { ctx, eraseCalls } = harness();
    const res = await call(ctx, ERASE, {
      parsedBody: { approvedBy: APPROVER, confirmTenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    });
    expect(res.status).toBe(400);
    expect(String(res.body["detail"])).toContain("confirmTenantId");
    expect(eraseCalls).toEqual([]);
  });

  it("accepts a confirmation differing only in case", async () => {
    const { ctx } = harness();
    const res = await call(ctx, ERASE, {
      parsedBody: { approvedBy: APPROVER, confirmTenantId: TENANT.toUpperCase() },
    });
    expect(res.status).toBe(200);
  });

  it("400s a missing or malformed body before touching the eraser", async () => {
    const { ctx, eraseCalls } = harness();
    expect((await call(ctx, ERASE, { parsedBody: null })).status).toBe(400);
    expect((await call(ctx, ERASE, { parsedBody: { approvedBy: "" } })).status).toBe(400);
    expect(eraseCalls).toEqual([]);
  });

  it("reports a refusal as 409 with the reasons and an empty scope", async () => {
    const { ctx, events } = harness(
      {},
      {
        erasure: erasureOf({
          erased: false,
          refusals: [{ reason: "external_dependents", detail: "would also drop view public.x" }],
          erasedRelations: [],
          rowCount: 0,
          storageBytes: 0,
        }),
      },
    );
    const res = await call(ctx, ERASE, { parsedBody: BODY });
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("erasure_refused");
    // An under-informed tombstone must not be assemblable from a failed erasure.
    expect(res.body["scope"]).toEqual({ schemas: [], tables: [], rowCount: 0, storageBytes: 0 });
    expect(events[0]?.operation).toBe(TENANT_SCHEMA_ERASE_REFUSED_OPERATION);
    expect(events[0]?.refusals).toEqual(["external_dependents"]);
  });

  it("reports an already-absent schema as a success with nothing claimed", async () => {
    const { ctx } = harness(
      {},
      {
        erasure: erasureOf({
          erased: false,
          alreadyAbsent: true,
          statements: [],
          erasedRelations: [],
          rowCount: 0,
          storageBytes: 0,
        }),
      },
    );
    const res = await call(ctx, ERASE, { parsedBody: BODY });
    expect(res.status).toBe(200);
    expect(res.body["alreadyAbsent"]).toBe(true);
    expect(res.body["scope"]).toEqual({ schemas: [], tables: [], rowCount: 0, storageBytes: 0 });
  });

  it("503s an eraser throw as 'nothing was changed', since the guard rolls back", async () => {
    const { ctx } = harness(
      {},
      {
        erasure: (): never => {
          throw new Error(`erasure of ${SCHEMA} did not remove the schema; rolling back`);
        },
      },
    );
    const res = await call(ctx, ERASE, { parsedBody: BODY });
    expect(res.status).toBe(503);
    expect(res.body["error"]).toBe("erasure_failed");
    expect(JSON.stringify(res.body)).not.toContain(SCHEMA);
  });

  it("500s when the data is gone and the record is not, naming exactly that", async () => {
    const { ctx } = harness({}, { recordThrows: true });
    const res = await call(ctx, ERASE, { parsedBody: BODY });
    // Not 200 (a tombstone would have no provenance) and not 503 (something did happen).
    expect(res.status).toBe(500);
    expect(res.body["error"]).toBe("erasure_unrecorded");
    expect(String(res.body["detail"])).toContain("do not issue a tombstone");
    expect(res.body["scope"]).toEqual({
      schemas: [SCHEMA],
      tables: [`${SCHEMA}.invoice`, `${SCHEMA}.line`],
      rowCount: 52,
      storageBytes: 12288,
    });
  });

  it("does not 500 an unrecorded REFUSAL, since nothing was destroyed", async () => {
    const { ctx } = harness(
      {},
      {
        recordThrows: true,
        erasure: erasureOf({
          erased: false,
          refusals: [{ reason: "four_eyes_violated", detail: "x" }],
          erasedRelations: [],
          rowCount: 0,
          storageBytes: 0,
        }),
      },
    );
    expect((await call(ctx, ERASE, { parsedBody: BODY })).status).toBe(409);
  });

  it("records the approver alongside the executor", async () => {
    const { ctx, events } = harness();
    await call(ctx, ERASE, { parsedBody: BODY });
    expect(events[0]?.operation).toBe(TENANT_SCHEMA_ERASED_OPERATION);
    expect(events[0]?.principalId).toBe(CALLER);
    expect(events[0]?.approvedBy).toBe(APPROVER);
    expect(events[0]?.rowCount).toBe(52);
  });

  it("401s with no principal and 403s an ungranted role", async () => {
    expect((await call(harness().ctx, ERASE, { principal: null, parsedBody: BODY })).status).toBe(401);
    const cashier = harness({ principalRoles: () => ({ primaryRole: "cashier", secondaryRoles: [] }) });
    const res = await call(cashier.ctx, ERASE, { parsedBody: BODY });
    expect(res.status).toBe(403);
    expect(cashier.eraseCalls).toEqual([]);
  });
});

describe("erasureScopeView", () => {
  it("claims the schema and its tables only when something was erased", () => {
    expect(erasureScopeView(erasureOf())).toEqual({
      schemas: [SCHEMA],
      tables: [`${SCHEMA}.invoice`, `${SCHEMA}.line`],
      rowCount: 52,
      storageBytes: 12288,
    });
    expect(erasureScopeView(erasureOf({ erased: false }))).toEqual({
      schemas: [],
      tables: [],
      rowCount: 0,
      storageBytes: 0,
    });
  });

  it("reports only the four fields this surface owns", () => {
    expect(Object.keys(erasureScopeView(erasureOf())).sort()).toEqual([
      "rowCount",
      "schemas",
      "storageBytes",
      "tables",
    ]);
  });
});
