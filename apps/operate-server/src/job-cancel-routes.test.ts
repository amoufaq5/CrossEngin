import { describe, expect, it } from "vitest";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput } from "@crossengin/api-gateway-runtime";

import {
  JOB_CANCEL_OUTCOMES,
  MAX_CANCEL_REASON_LENGTH,
  buildJobCancelRoutes,
  readCancelReason,
  statusForCancelOutcome,
  type JobCancelRequestLike,
  type JobCancelResultLike,
  type JobCancelRoutesContext,
} from "./job-cancel-routes.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const RUN = "33333333-3333-3333-3333-333333333333";

const PRINCIPAL = "44444444-4444-4444-4444-444444444444";

function principal(over: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    principalId: PRINCIPAL,
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function recordingCanceller(result: Partial<JobCancelResultLike> = {}): {
  readonly canceller: JobCancelRoutesContext["canceller"];
  readonly calls: JobCancelRequestLike[];
} {
  const calls: JobCancelRequestLike[] = [];
  return {
    calls,
    canceller: {
      requestCancellation: async (request): Promise<JobCancelResultLike> => {
        calls.push(request);
        return {
          runId: request.runId,
          outcome: "cancelled",
          status: "cancelled",
          requestedAt: "2026-01-01T00:00:00.000Z",
          ...result,
        };
      },
    },
  };
}

function ctxFor(
  canceller: JobCancelRoutesContext["canceller"],
  over: Partial<JobCancelRoutesContext> = {},
): JobCancelRoutesContext {
  return {
    canceller,
    principalRoles: (p) => ({
      primaryRole: p === null ? "anonymous" : "erp_admin",
      secondaryRoles: [],
    }),
    allowedRoles: new Set(["erp_admin"]),
    ...over,
  };
}

function handlerOf(ctx: JobCancelRoutesContext): Handler {
  const routes = buildJobCancelRoutes(ctx);
  const handler = routes[0]?.handler;
  if (handler === undefined) throw new Error("no handler built");
  return handler;
}

function inputFor(over: Partial<HandlerInput> = {}): HandlerInput {
  return {
    request: {} as HandlerInput["request"],
    route: buildJobCancelRoutes(ctxFor(recordingCanceller().canceller))[0]?.route as HandlerInput["route"],
    principal: principal(),
    params: { runId: RUN },
    parsedBody: null,
    ...over,
  };
}

async function callWith(
  ctx: JobCancelRoutesContext,
  over: Partial<HandlerInput> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const out = await handlerOf(ctx)(inputFor(over));
  if (out.kind !== "json") throw new Error(`expected json, got ${out.kind}`);
  return { status: out.status, body: out.body as Record<string, unknown> };
}

describe("the route declaration", () => {
  it("is one POST under /v1/meta/jobs/runs/{runId}/cancel", () => {
    const routes = buildJobCancelRoutes(ctxFor(recordingCanceller().canceller));
    expect(routes).toHaveLength(1);
    const route = routes[0]?.route;
    expect(route?.method).toBe("POST");
    expect(route?.operationId).toBe("jobs.runs.cancel");
    expect(
      route?.pathSegments.map((s) =>
        s.kind === "literal" ? s.value : s.kind === "parameter" ? `:${s.name}` : "*",
      ),
    ).toEqual([
      "v1",
      "meta",
      "jobs",
      "runs",
      ":runId",
      "cancel",
    ]);
  });

  it("does not require an idempotency key, because the record itself is idempotent", () => {
    expect(buildJobCancelRoutes(ctxFor(recordingCanceller().canceller))[0]?.route.idempotencyRequired).toBe(
      false,
    );
  });
});

describe("statusForCancelOutcome", () => {
  it("maps every outcome, and distinguishes the four that are not failures", () => {
    expect(statusForCancelOutcome("cancelled")).toBe(200);
    expect(statusForCancelOutcome("cancellation_requested")).toBe(202);
    expect(statusForCancelOutcome("already_requested")).toBe(200);
    // Not 200: the work happened, so reporting it as a successful cancellation would be a lie.
    expect(statusForCancelOutcome("already_terminal")).toBe(409);
    expect(statusForCancelOutcome("not_found")).toBe(404);
  });

  it("covers every declared outcome", () => {
    for (const outcome of JOB_CANCEL_OUTCOMES) {
      expect(statusForCancelOutcome(outcome)).toBeGreaterThanOrEqual(200);
    }
  });
});

describe("readCancelReason", () => {
  it("accepts an absent, null or blank reason as none", () => {
    expect(readCancelReason(null)).toEqual({ ok: true });
    expect(readCancelReason({})).toEqual({ ok: true });
    expect(readCancelReason({ reason: null })).toEqual({ ok: true });
    expect(readCancelReason({ reason: "   " })).toEqual({ ok: true });
  });

  it("trims a reason and refuses a non-string or an over-long one", () => {
    expect(readCancelReason({ reason: "  superseded  " })).toEqual({ ok: true, reason: "superseded" });
    expect(readCancelReason({ reason: 7 }).ok).toBe(false);
    expect(readCancelReason({ reason: "x".repeat(MAX_CANCEL_REASON_LENGTH + 1) }).ok).toBe(false);
    expect(readCancelReason({ reason: "x".repeat(MAX_CANCEL_REASON_LENGTH) }).ok).toBe(true);
  });
});

describe("the cancel handler", () => {
  it("cancels for a granted role, scoped to the credential's tenant", async () => {
    const { canceller, calls } = recordingCanceller();
    const res = await callWith(ctxFor(canceller), { parsedBody: { reason: "superseded" } });
    expect(res.status).toBe(200);
    expect(res.body["outcome"]).toBe("cancelled");
    expect(calls).toEqual([
      { runId: RUN, tenantId: TENANT, requestedBy: PRINCIPAL, reason: "superseded" },
    ]);
  });

  it("takes the tenant from the credential, never from the body", async () => {
    const { canceller, calls } = recordingCanceller();
    await callWith(ctxFor(canceller), { parsedBody: { tenantId: OTHER_TENANT } });
    expect(calls[0]?.tenantId).toBe(TENANT);
  });

  it("records the authenticated principal, never a body-supplied requester", async () => {
    const { canceller, calls } = recordingCanceller();
    await callWith(ctxFor(canceller), { parsedBody: { requestedBy: "somebody-else" } });
    expect(calls[0]?.requestedBy).toBe(PRINCIPAL);
  });

  it("401s with no principal and 403s for an ungranted role", async () => {
    const { canceller, calls } = recordingCanceller();
    expect((await callWith(ctxFor(canceller), { principal: null })).status).toBe(401);
    const ctx = ctxFor(canceller, {
      principalRoles: () => ({ primaryRole: "cashier", secondaryRoles: [] }),
    });
    expect((await callWith(ctx)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses everyone when no role is granted, rather than reading as open", async () => {
    const { canceller, calls } = recordingCanceller();
    const res = await callWith(ctxFor(canceller, { allowedRoles: new Set() }));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a principal with no resolvable tenant, which would be an unscoped cancel", async () => {
    const { canceller, calls } = recordingCanceller();
    const res = await callWith(ctxFor(canceller), { principal: principal({ tenantId: null }) });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a principal with an empty id, which would be an unattributable cancel", async () => {
    const { canceller, calls } = recordingCanceller();
    const res = await callWith(ctxFor(canceller), { principal: principal({ principalId: "" }) });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("400s a non-uuid run id before reaching the store", async () => {
    const { canceller, calls } = recordingCanceller();
    const res = await callWith(ctxFor(canceller), { params: { runId: "not-a-uuid" } });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("400s an invalid reason before reaching the store", async () => {
    const { canceller, calls } = recordingCanceller();
    const res = await callWith(ctxFor(canceller), { parsedBody: { reason: 7 } });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("reports an accepted-but-unfinished cancellation as 202", async () => {
    const { canceller } = recordingCanceller({ outcome: "cancellation_requested", status: "running" });
    const res = await callWith(ctxFor(canceller));
    expect(res.status).toBe(202);
    expect(res.body["status"]).toBe("running");
  });

  it("reports an already-finished run as 409 rather than a successful cancellation", async () => {
    const { canceller } = recordingCanceller({
      outcome: "already_terminal",
      status: "succeeded",
      requestedAt: null,
    });
    const res = await callWith(ctxFor(canceller));
    expect(res.status).toBe(409);
    expect(res.body["outcome"]).toBe("already_terminal");
  });

  it("reports another tenant's run as not_found", async () => {
    const { canceller } = recordingCanceller({ outcome: "not_found", status: null, requestedAt: null });
    const res = await callWith(ctxFor(canceller));
    expect(res.status).toBe(404);
  });

  it("turns a store throw into a 503 that leaks no internals", async () => {
    const ctx = ctxFor({
      requestCancellation: async (): Promise<JobCancelResultLike> => {
        throw new Error('relation "meta.job_runs" does not exist');
      },
    });
    const res = await callWith(ctx);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("job_runs");
  });

  it("notifies onDecided with the outcome and the tenant", async () => {
    const seen: Array<{ outcome: string; tenantId: string }> = [];
    const { canceller } = recordingCanceller();
    await callWith(
      ctxFor(canceller, {
        onDecided: (result, tenantId) => seen.push({ outcome: result.outcome, tenantId }),
      }),
    );
    expect(seen).toEqual([{ outcome: "cancelled", tenantId: TENANT }]);
  });
});
