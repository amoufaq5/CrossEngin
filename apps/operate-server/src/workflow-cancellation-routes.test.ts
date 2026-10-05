import { describe, expect, it } from "vitest";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput } from "@crossengin/api-gateway-runtime";
import type { PersistentEngineBundle } from "@crossengin/workflow-runtime-pg";

import {
  INSTANCE_CANCEL_DISPOSITIONS,
  INSTANCE_CANCEL_OUTCOMES,
  MAX_INSTANCE_CANCEL_REASON_LENGTH,
  actorForInstanceCancel,
  buildWorkflowCancellationRoutes,
  detailForInstanceCancelOutcome,
  effectsFor,
  readInstanceCancelBody,
  statusForInstanceCancelOutcome,
  type InstanceCancelRequestLike,
  type InstanceCancelResultLike,
  type InstanceSnapshotLike,
  type WorkflowCancellationRoutesContext,
  type WorkflowInstanceCancellerLike,
} from "./workflow-cancellation-routes.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const PRINCIPAL = "44444444-4444-4444-4444-444444444444";
const INSTANCE = "wfi_abcd1234";

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

const CANCELLED: InstanceCancelResultLike = {
  outcome: "cancelled",
  cancelledTimerIds: ["tmr_1"],
  beforeHandlerActivityIds: ["act_sched"],
  cooperativeAbortActivityIds: ["act_flight"],
  signalDeliveredActivityIds: ["act_flight"],
  compensationOutcome: "executed",
  compensatedActivityIds: ["act_posted"],
  unreversedActivityIds: [],
};

/** Every non-`cancelled` outcome carries `EMPTY_PLAN`'s filler, which is what `effectsFor` hides. */
function refusal(outcome: InstanceCancelResultLike["outcome"]): InstanceCancelResultLike {
  return {
    outcome,
    cancelledTimerIds: [],
    beforeHandlerActivityIds: [],
    cooperativeAbortActivityIds: [],
    signalDeliveredActivityIds: [],
    compensationOutcome: "skipped_by_request",
    compensatedActivityIds: [],
    unreversedActivityIds: [],
  };
}

function recordingCanceller(opts: {
  readonly result?: InstanceCancelResultLike;
  readonly snapshot?: InstanceSnapshotLike | null;
  readonly readThrows?: boolean;
  readonly cancelThrows?: boolean;
} = {}): {
  readonly canceller: WorkflowCancellationRoutesContext["canceller"];
  readonly calls: InstanceCancelRequestLike[];
} {
  const calls: InstanceCancelRequestLike[] = [];
  const snapshot =
    opts.snapshot === undefined
      ? { instanceId: INSTANCE, tenantId: TENANT, status: "running" }
      : opts.snapshot;
  return {
    calls,
    canceller: {
      getInstanceState: async (): Promise<InstanceSnapshotLike | null> => {
        if (opts.readThrows === true) throw new Error('relation "meta.workflow_instances" does not exist');
        return snapshot;
      },
      cancelInstance: async (request): Promise<InstanceCancelResultLike> => {
        calls.push(request);
        if (opts.cancelThrows === true) throw new Error("append failed mid-cancellation");
        return opts.result ?? CANCELLED;
      },
    },
  };
}

function ctxFor(
  canceller: WorkflowCancellationRoutesContext["canceller"],
  over: Partial<WorkflowCancellationRoutesContext> = {},
): WorkflowCancellationRoutesContext {
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

function handlerOf(ctx: WorkflowCancellationRoutesContext): Handler {
  const handler = buildWorkflowCancellationRoutes(ctx)[0]?.handler;
  if (handler === undefined) throw new Error("no handler built");
  return handler;
}

const GOOD_BODY = { disposition: "abandon", reason: "superseded" };

function inputFor(over: Partial<HandlerInput> = {}): HandlerInput {
  return {
    request: {} as HandlerInput["request"],
    route: buildWorkflowCancellationRoutes(ctxFor(recordingCanceller().canceller))[0]
      ?.route as HandlerInput["route"],
    principal: principal(),
    params: { instanceId: INSTANCE },
    parsedBody: GOOD_BODY,
    ...over,
  };
}

async function callWith(
  ctx: WorkflowCancellationRoutesContext,
  over: Partial<HandlerInput> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const out = await handlerOf(ctx)(inputFor(over));
  if (out.kind !== "json") throw new Error(`expected json, got ${out.kind}`);
  return { status: out.status, body: out.body as Record<string, unknown> };
}

/**
 * The real engine satisfies the structural contract. Checked at compile time rather than asserted
 * at runtime, because ADR-0307's overlay typechecks this file: a `cancelInstance` or
 * `getInstanceState` that drifts out of shape fails `typecheck` here instead of at the first
 * cancellation in production.
 */
const engineSatisfiesContract: (engine: PersistentEngineBundle["engine"]) => WorkflowInstanceCancellerLike =
  (engine) => engine;

describe("the route declaration", () => {
  it("is satisfied structurally by the real WorkflowEngine", () => {
    expect(typeof engineSatisfiesContract).toBe("function");
  });

  it("is one POST under /v1/meta/workflows/instances/{instanceId}/cancel", () => {
    const routes = buildWorkflowCancellationRoutes(ctxFor(recordingCanceller().canceller));
    expect(routes).toHaveLength(1);
    const route = routes[0]?.route;
    expect(route?.method).toBe("POST");
    expect(route?.operationId).toBe("workflows.instances.cancel");
    expect(
      route?.pathSegments.map((s) =>
        s.kind === "literal" ? s.value : s.kind === "parameter" ? `:${s.name}` : "*",
      ),
    ).toEqual(["v1", "meta", "workflows", "instances", ":instanceId", "cancel"]);
  });

  it("does not require an idempotency key, because a repeat lands already_requested", () => {
    expect(
      buildWorkflowCancellationRoutes(ctxFor(recordingCanceller().canceller))[0]?.route
        .idempotencyRequired,
    ).toBe(false);
  });
});

describe("statusForInstanceCancelOutcome", () => {
  it("reports an idempotent repeat as 200, not as a conflict", () => {
    // The caller's postcondition holds — the instance is cancelled or fenced — and only its
    // authorship does not. `planInstanceCancellation` tests this case before the refusals for
    // exactly that reason.
    expect(statusForInstanceCancelOutcome("already_requested")).toBe(200);
  });

  it("reports both refusals as 409 and an unknown instance as 404", () => {
    expect(statusForInstanceCancelOutcome("cancelled")).toBe(200);
    expect(statusForInstanceCancelOutcome("refused_terminal")).toBe(409);
    expect(statusForInstanceCancelOutcome("refused_not_cancellable")).toBe(409);
    expect(statusForInstanceCancelOutcome("unknown_instance")).toBe(404);
  });

  it("covers every declared outcome with a real status", () => {
    for (const outcome of INSTANCE_CANCEL_OUTCOMES) {
      expect(statusForInstanceCancelOutcome(outcome)).toBeGreaterThanOrEqual(200);
    }
  });

  it("gives a detail to every outcome but the one that needs none", () => {
    expect(detailForInstanceCancelOutcome("cancelled")).toBeNull();
    for (const outcome of INSTANCE_CANCEL_OUTCOMES.filter((o) => o !== "cancelled")) {
      expect(detailForInstanceCancelOutcome(outcome)?.length).toBeGreaterThan(0);
    }
  });

  it("tells a refused_not_cancellable caller to compensate instead", () => {
    expect(detailForInstanceCancelOutcome("refused_not_cancellable")).toContain("compensated");
  });
});

describe("readInstanceCancelBody", () => {
  it("accepts both dispositions with a reason", () => {
    for (const disposition of INSTANCE_CANCEL_DISPOSITIONS) {
      expect(readInstanceCancelBody({ disposition, reason: "why" })).toEqual({
        ok: true,
        body: { disposition, reason: "why" },
      });
    }
  });

  it("refuses an absent disposition rather than defaulting one", () => {
    const absent = readInstanceCancelBody({ reason: "why" });
    expect(absent.ok).toBe(false);
    expect(absent.ok === false ? absent.detail : "").toContain("no default");
    expect(readInstanceCancelBody({ disposition: null, reason: "why" }).ok).toBe(false);
  });

  it("refuses an absent body outright", () => {
    expect(readInstanceCancelBody(null).ok).toBe(false);
  });

  it("refuses an unknown or non-string disposition", () => {
    expect(readInstanceCancelBody({ disposition: "rollback", reason: "why" }).ok).toBe(false);
    expect(readInstanceCancelBody({ disposition: 1, reason: "why" }).ok).toBe(false);
    expect(readInstanceCancelBody({ disposition: "COMPENSATE", reason: "why" }).ok).toBe(false);
  });

  it("requires a non-empty reason, because a cancelled instance's record requires one", () => {
    expect(readInstanceCancelBody({ disposition: "abandon" }).ok).toBe(false);
    expect(readInstanceCancelBody({ disposition: "abandon", reason: "   " }).ok).toBe(false);
    expect(readInstanceCancelBody({ disposition: "abandon", reason: 7 }).ok).toBe(false);
  });

  it("trims the reason and refuses an over-long one at the schema's own cap", () => {
    expect(readInstanceCancelBody({ disposition: "abandon", reason: "  x  " })).toEqual({
      ok: true,
      body: { disposition: "abandon", reason: "x" },
    });
    const max = "y".repeat(MAX_INSTANCE_CANCEL_REASON_LENGTH);
    expect(readInstanceCancelBody({ disposition: "abandon", reason: max }).ok).toBe(true);
    expect(readInstanceCancelBody({ disposition: "abandon", reason: `${max}y` }).ok).toBe(false);
  });
});

describe("actorForInstanceCancel", () => {
  it("records a user principal as the requesting user", () => {
    expect(actorForInstanceCancel(principal())).toEqual({
      requestedByUserId: PRINCIPAL,
      requestedBySystem: null,
    });
  });

  it("records a non-user principal as a system actor, never as a user", () => {
    // `cancelled_by_user_id` is a foreign key to `meta.users`; a service account's uuid is not
    // there, so attributing it as a user would make the next projection upsert violate the key.
    for (const kind of ["service_account", "ai_architect", "system"] as const) {
      const actor = actorForInstanceCancel(principal({ principalKind: kind }));
      expect(actor.requestedByUserId).toBeNull();
      expect(actor.requestedBySystem).toBe(`${kind}:${PRINCIPAL}`);
    }
  });
});

describe("effectsFor", () => {
  it("reports what a real cancellation did", () => {
    expect(effectsFor(CANCELLED)).toEqual({
      compensationOutcome: "executed",
      compensatedActivityIds: ["act_posted"],
      unreversedActivityIds: [],
      cancelledTimerIds: ["tmr_1"],
      beforeHandlerActivityIds: ["act_sched"],
      cooperativeAbortActivityIds: ["act_flight"],
      signalDeliveredActivityIds: ["act_flight"],
    });
  });

  it("reports unreversed side effects rather than leaving them silent", () => {
    const abandoned = {
      ...CANCELLED,
      compensationOutcome: "skipped_by_request" as const,
      compensatedActivityIds: [],
      unreversedActivityIds: ["act_posted"],
    };
    expect(effectsFor(abandoned).unreversedActivityIds).toEqual(["act_posted"]);
  });

  it("nulls every field for a non-cancelling outcome instead of passing EMPTY_PLAN's filler", () => {
    for (const outcome of INSTANCE_CANCEL_OUTCOMES.filter((o) => o !== "cancelled")) {
      const effects = effectsFor(refusal(outcome));
      // Not `skipped_by_request`: a repeat whose first request compensated in full would otherwise
      // be told the rollback was skipped at its own request.
      expect(effects.compensationOutcome).toBeNull();
      expect(effects.unreversedActivityIds).toBeNull();
      expect(effects.compensatedActivityIds).toBeNull();
    }
  });
});

describe("the cancel handler", () => {
  it("cancels for a granted role and reports what happened", async () => {
    const { canceller, calls } = recordingCanceller();
    const res = await callWith(ctxFor(canceller));
    expect(res.status).toBe(200);
    expect(res.body["outcome"]).toBe("cancelled");
    expect(res.body["compensationOutcome"]).toBe("executed");
    expect(res.body["signalDeliveredActivityIds"]).toEqual(["act_flight"]);
    expect(res.body["statusBefore"]).toBe("running");
    expect(calls).toEqual([
      {
        instanceId: INSTANCE,
        disposition: "abandon",
        reason: "superseded",
        requestedByUserId: PRINCIPAL,
        requestedBySystem: null,
      },
    ]);
  });

  it("names the unreversed activities a disposition left standing", async () => {
    const { canceller } = recordingCanceller({
      result: {
        ...CANCELLED,
        compensationOutcome: "deferred_to_human",
        compensatedActivityIds: [],
        unreversedActivityIds: ["act_posted"],
      },
    });
    const res = await callWith(ctxFor(canceller), {
      parsedBody: { disposition: "compensate", reason: "wrong customer" },
    });
    expect(res.status).toBe(200);
    expect(res.body["compensationOutcome"]).toBe("deferred_to_human");
    expect(res.body["unreversedActivityIds"]).toEqual(["act_posted"]);
  });

  it("400s a body with no disposition, before reaching the engine", async () => {
    const { canceller, calls } = recordingCanceller();
    const res = await callWith(ctxFor(canceller), { parsedBody: { reason: "superseded" } });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("400s a null body, rather than cancelling with an inferred disposition", async () => {
    const { canceller, calls } = recordingCanceller();
    expect((await callWith(ctxFor(canceller), { parsedBody: null })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("400s a missing reason and an unknown disposition", async () => {
    const { canceller, calls } = recordingCanceller();
    expect(
      (await callWith(ctxFor(canceller), { parsedBody: { disposition: "abandon" } })).status,
    ).toBe(400);
    expect(
      (await callWith(ctxFor(canceller), { parsedBody: { disposition: "nope", reason: "x" } }))
        .status,
    ).toBe(400);
    expect(calls).toEqual([]);
  });

  it("400s a malformed instance id before touching the engine", async () => {
    const { canceller, calls } = recordingCanceller();
    const res = await callWith(ctxFor(canceller), { params: { instanceId: "wfi_SHOUT" } });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("takes the tenant from the credential, never from the body or the path", async () => {
    const { canceller, calls } = recordingCanceller();
    await callWith(ctxFor(canceller), {
      parsedBody: { ...GOOD_BODY, tenantId: OTHER_TENANT },
    });
    // Nothing tenant-shaped reaches the engine at all; the scoping is the pre-read refusal below.
    expect(calls[0]).not.toHaveProperty("tenantId");
  });

  it("reports another tenant's instance as unknown, not as forbidden", async () => {
    const { canceller, calls } = recordingCanceller({
      snapshot: { instanceId: INSTANCE, tenantId: OTHER_TENANT, status: "running" },
    });
    const res = await callWith(ctxFor(canceller));
    expect(res.status).toBe(404);
    expect(res.body["outcome"]).toBe("unknown_instance");
    expect(calls).toEqual([]);
  });

  it("404s an instance that does not exist", async () => {
    const { canceller, calls } = recordingCanceller({ snapshot: null });
    const res = await callWith(ctxFor(canceller));
    expect(res.status).toBe(404);
    expect(res.body["compensationOutcome"]).toBeNull();
    expect(calls).toEqual([]);
  });

  it("records the authenticated principal, never a body-supplied requester", async () => {
    const { canceller, calls } = recordingCanceller();
    await callWith(ctxFor(canceller), {
      parsedBody: { ...GOOD_BODY, requestedByUserId: OTHER_TENANT, requestedBySystem: "somebody" },
    });
    expect(calls[0]?.requestedByUserId).toBe(PRINCIPAL);
    expect(calls[0]?.requestedBySystem).toBeNull();
  });

  it("attributes a service-account cancellation to a system actor", async () => {
    const { canceller, calls } = recordingCanceller();
    await callWith(ctxFor(canceller), {
      principal: principal({ principalKind: "service_account" }),
    });
    expect(calls[0]?.requestedByUserId).toBeNull();
    expect(calls[0]?.requestedBySystem).toBe(`service_account:${PRINCIPAL}`);
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

  it("admits a principal whose grant is a secondary role", async () => {
    const { canceller } = recordingCanceller();
    const ctx = ctxFor(canceller, {
      principalRoles: () => ({ primaryRole: "cashier", secondaryRoles: ["erp_admin"] }),
    });
    expect((await callWith(ctx)).status).toBe(200);
  });

  it("refuses a principal with no resolvable tenant, which would be an unscoped cancel", async () => {
    const { canceller, calls } = recordingCanceller();
    const res = await callWith(ctxFor(canceller), { principal: principal({ tenantId: null }) });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("reports an idempotent repeat as 200 with no invented compensation outcome", async () => {
    const { canceller } = recordingCanceller({ result: refusal("already_requested") });
    const res = await callWith(ctxFor(canceller));
    expect(res.status).toBe(200);
    expect(res.body["outcome"]).toBe("already_requested");
    expect(res.body["compensationOutcome"]).toBeNull();
  });

  it("409s a closed instance and a status the transition map does not admit", async () => {
    const terminal = recordingCanceller({
      result: refusal("refused_terminal"),
      snapshot: { instanceId: INSTANCE, tenantId: TENANT, status: "completed" },
    });
    const first = await callWith(ctxFor(terminal.canceller));
    expect(first.status).toBe(409);
    expect(first.body["statusBefore"]).toBe("completed");

    const failed = recordingCanceller({
      result: refusal("refused_not_cancellable"),
      snapshot: { instanceId: INSTANCE, tenantId: TENANT, status: "failed" },
    });
    const second = await callWith(ctxFor(failed.canceller));
    expect(second.status).toBe(409);
    expect(second.body["outcome"]).toBe("refused_not_cancellable");
    expect(second.body["statusBefore"]).toBe("failed");
  });

  it("never turns a refusal into a 500", async () => {
    for (const outcome of INSTANCE_CANCEL_OUTCOMES) {
      const { canceller } = recordingCanceller({
        result: outcome === "cancelled" ? CANCELLED : refusal(outcome),
      });
      const res = await callWith(ctxFor(canceller));
      expect(res.status).toBeLessThan(500);
    }
  });

  it("503s an unreadable instance, because nothing was attempted", async () => {
    const { canceller, calls } = recordingCanceller({ readThrows: true });
    const res = await callWith(ctxFor(canceller));
    expect(res.status).toBe(503);
    expect(res.body["error"]).toBe("cancellation_unavailable");
    expect(JSON.stringify(res.body)).not.toContain("workflow_instances");
    expect(calls).toEqual([]);
  });

  it("500s a throw from the cancellation itself, because the fence may already be in the log", async () => {
    const { canceller } = recordingCanceller({ cancelThrows: true });
    const res = await callWith(ctxFor(canceller));
    expect(res.status).toBe(500);
    expect(res.body["error"]).toBe("cancellation_incomplete");
    expect(String(res.body["detail"])).toContain("partially applied");
  });

  it("notifies onDecided with the outcome, the tenant and the instance", async () => {
    const seen: Array<{ outcome: string; tenantId: string; instanceId: string }> = [];
    const { canceller } = recordingCanceller();
    await callWith(
      ctxFor(canceller, {
        onDecided: (result, tenantId, instanceId) =>
          seen.push({ outcome: result.outcome, tenantId, instanceId }),
      }),
    );
    expect(seen).toEqual([{ outcome: "cancelled", tenantId: TENANT, instanceId: INSTANCE }]);
  });

  it("does not notify onDecided for a request the route itself refused", async () => {
    const seen: string[] = [];
    const { canceller } = recordingCanceller({ snapshot: null });
    await callWith(ctxFor(canceller, { onDecided: (r) => seen.push(r.outcome) }));
    expect(seen).toEqual([]);
  });
});
