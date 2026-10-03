import { describe, expect, it } from "vitest";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput } from "@crossengin/api-gateway-runtime";

import {
  DELETION_REQUEST_READ_OPERATION,
  DELETION_REQUEST_REJECTED_OPERATION,
  DELETION_REQUEST_SUBMITTED_OPERATION,
  DELETION_REQUEST_VERIFIED_OPERATION,
  SubmitDeletionRequestBodySchema,
  buildDeletionRequestRoutes,
  newRequestId,
  requestHandle,
  type DeletionRequestEvent,
  type DeletionRequestLike,
  type DeletionRequestRoutesContext,
} from "./deletion-request-routes.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const CALLER = "11111111-1111-1111-1111-111111111111";
const REQ = "dreq_abcdefgh1234";
const TOMB = "tomb_aaaabbbbccccdddd";
const AT = "2026-10-03T13:00:00.000Z";

function principal(over: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    principalId: CALLER,
    tenantId: null,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [],
    mfaProofAgeSeconds: null,
    resolvedAt: AT,
    ...over,
  };
}

function requestOf(over: Partial<DeletionRequestLike> = {}): DeletionRequestLike {
  return {
    id: REQ,
    tenantId: TENANT,
    subjectIdentifier: "subject@example.test",
    legalBasis: "article_17_right_to_erasure",
    status: "submitted",
    submittedAt: AT,
    submittedBy: "subject@example.test",
    deadlineAt: "2026-11-02T13:00:00.000Z",
    verificationMethod: null,
    verifiedAt: null,
    verifiedBy: null,
    inProgressAt: null,
    completedAt: null,
    completionSha256: null,
    rejectedAt: null,
    tombstoneId: null,
    ...over,
  };
}

interface Harness {
  readonly ctx: DeletionRequestRoutesContext;
  readonly events: DeletionRequestEvent[];
  readonly submits: Array<Record<string, unknown>>;
  readonly transitions: Array<{ to: string; fields: Record<string, unknown> }>;
}

function harness(
  over: Partial<DeletionRequestRoutesContext> = {},
  behaviour: {
    readonly stored?: DeletionRequestLike | null;
    readonly readThrows?: boolean;
    readonly submitThrows?: unknown;
    readonly transitionThrows?: unknown;
    readonly transitionReturnsNull?: boolean;
  } = {},
): Harness {
  const events: DeletionRequestEvent[] = [];
  const submits: Array<Record<string, unknown>> = [];
  const transitions: Array<{ to: string; fields: Record<string, unknown> }> = [];
  const ctx: DeletionRequestRoutesContext = {
    store: {
      submit: async (input): Promise<DeletionRequestLike> => {
        submits.push({ ...input });
        if (behaviour.submitThrows !== undefined) throw behaviour.submitThrows;
        return requestOf({ id: input.requestId, deadlineAt: input.deadlineAt });
      },
      read: async (): Promise<DeletionRequestLike | null> => {
        if (behaviour.readThrows === true) throw new Error("a stored row no longer parses");
        return behaviour.stored === undefined ? requestOf() : behaviour.stored;
      },
      transition: async (_id, to, fields): Promise<DeletionRequestLike | null> => {
        transitions.push({ to, fields: { ...fields } });
        if (behaviour.transitionThrows !== undefined) throw behaviour.transitionThrows;
        if (behaviour.transitionReturnsNull === true) return null;
        return requestOf({ status: to, verifiedAt: AT, verifiedBy: CALLER });
      },
    },
    principalRoles: (p) => ({
      primaryRole: p === null ? "anonymous" : "platform_admin",
      secondaryRoles: [],
    }),
    submitRoles: new Set(["platform_admin"]),
    verifyRoles: new Set(["platform_admin"]),
    recordAction: async (event): Promise<void> => {
      events.push(event);
    },
    newRequestId: () => REQ,
    clock: () => new Date(AT),
    ...over,
  };
  return { ctx, events, submits, transitions };
}

const SUBMIT = "platform.deletion_requests.submit";
const VERIFY = "platform.deletion_requests.verify";
const REJECT = "platform.deletion_requests.reject";
const READ = "platform.deletion_requests.read";

function handlerFor(ctx: DeletionRequestRoutesContext, op: string): Handler {
  const found = buildDeletionRequestRoutes(ctx).find((r) => r.route.operationId === op);
  if (found === undefined) throw new Error(`no route for ${op}`);
  return found.handler;
}

async function call(
  ctx: DeletionRequestRoutesContext,
  op: string,
  over: Partial<HandlerInput> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const out = await handlerFor(ctx, op)({
    request: {} as HandlerInput["request"],
    route: {} as HandlerInput["route"],
    principal: principal(),
    params: { id: REQ },
    parsedBody: null,
    ...over,
  });
  if (out.kind !== "json") throw new Error(`expected json, got ${out.kind}`);
  return { status: out.status, body: out.body as Record<string, unknown> };
}

const SUBMIT_BODY = {
  tenantId: TENANT,
  subjectIdentifier: "subject@example.test",
  submittedBy: "subject@example.test",
};

describe("the route declarations", () => {
  it("are submit, verify, reject and read", () => {
    const routes = buildDeletionRequestRoutes(harness().ctx);
    expect(
      routes.map((r) => ({
        method: r.route.method,
        path: r.route.pathSegments
          .map((s) => {
            if (s.kind === "literal") return s.value;
            return s.kind === "parameter" ? `{${s.name}}` : "*";
          })
          .join("/"),
      })),
    ).toEqual([
      { method: "POST", path: "v1/platform/deletion-requests" },
      { method: "POST", path: "v1/platform/deletion-requests/{id}/verify" },
      { method: "POST", path: "v1/platform/deletion-requests/{id}/reject" },
      { method: "GET", path: "v1/platform/deletion-requests/{id}" },
    ]);
  });

  it("requires an idempotency key on the submit alone", () => {
    const routes = buildDeletionRequestRoutes(harness().ctx);
    // The id is generated server-side, so a retry without a key opens a *second* request for the same
    // subject — and both would run. Nothing else here creates anything.
    expect(routes.map((r) => r.route.idempotencyRequired)).toEqual([true, false, false, false]);
  });
});

describe("newRequestId", () => {
  it("builds an id the column's CHECK accepts", () => {
    expect(newRequestId("3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8")).toBe(
      "dreq_3f2a1b4c5d6e4f708192a3b4c5d6e7f8",
    );
  });
});

describe("requestHandle", () => {
  it("carries the tombstone and the digest once there is one", () => {
    const handle = requestHandle(
      requestOf({ status: "completed", tombstoneId: TOMB, completionSha256: "b".repeat(64) }),
    );
    expect(handle["tombstoneId"]).toBe(TOMB);
    expect(handle["completionSha256"]).toBe("b".repeat(64));
    expect(handle["terminal"]).toBe(true);
  });

  it("is not terminal while the deletion is still in flight", () => {
    expect(requestHandle(requestOf({ status: "in_progress", inProgressAt: AT }))["terminal"]).toBe(
      false,
    );
  });
});

describe("submit", () => {
  it("creates a submitted request and returns the handle", async () => {
    const h = harness();
    const res = await call(h.ctx, SUBMIT, { parsedBody: SUBMIT_BODY });
    expect(res.status).toBe(201);
    expect(res.body["requestId"]).toBe(REQ);
    expect(res.body["status"]).toBe("submitted");
    expect(h.events[0]?.operation).toBe(DELETION_REQUEST_SUBMITTED_OPERATION);
  });

  it("computes the deadline from the deployment's window, not the body", async () => {
    const h = harness({ deadlineDays: 30 });
    await call(h.ctx, SUBMIT, { parsedBody: SUBMIT_BODY });
    // Article 12(3) is the platform's commitment, and the contract caps it — a body field could only
    // ask for something shorter or trip a refusal on a typo.
    expect(h.submits[0]?.["deadlineAt"]).toBe("2026-11-02T13:00:00.000Z");
  });

  it("refuses a body that names a deadline", () => {
    const parsed = SubmitDeletionRequestBodySchema.safeParse({
      ...SUBMIT_BODY,
      deadlineAt: "2026-12-01T00:00:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a non-uuid tenant id", async () => {
    const h = harness();
    const res = await call(h.ctx, SUBMIT, { parsedBody: { ...SUBMIT_BODY, tenantId: "nope" } });
    expect(res.status).toBe(400);
    expect(h.submits).toEqual([]);
  });

  it("reports a contract refusal as a 400, not a 500", async () => {
    const h = harness({}, { submitThrows: new Error("Article 12(3) caps deadlineAt") });
    const res = await call(h.ctx, SUBMIT, { parsedBody: SUBMIT_BODY });
    expect(res.status).toBe(400);
    expect(String(res.body["detail"])).toContain("Article 12(3)");
  });

  it("refuses a role without the submit grant", async () => {
    const h = harness({ submitRoles: new Set() });
    const res = await call(h.ctx, SUBMIT, { parsedBody: SUBMIT_BODY });
    // Fail-closed: an empty grant is nobody, never everybody.
    expect(res.status).toBe(403);
    expect(h.submits).toEqual([]);
  });

  it("refuses an unauthenticated caller", async () => {
    const h = harness();
    const res = await call(h.ctx, SUBMIT, { principal: null, parsedBody: SUBMIT_BODY });
    expect(res.status).toBe(401);
  });

  it("does not fail the request when the audit line cannot be written", async () => {
    const errors: string[] = [];
    const h = harness({
      recordAction: async (): Promise<void> => {
        throw new Error("audit unreachable");
      },
      onRecordError: (_e, op) => errors.push(op),
    });
    const res = await call(h.ctx, SUBMIT, { parsedBody: SUBMIT_BODY });
    // Nothing has been destroyed at this point, so refusing would block the flow without protecting
    // anything — unlike the erasure's recorder (ADR-0316).
    expect(res.status).toBe(201);
    expect(errors).toEqual([DELETION_REQUEST_SUBMITTED_OPERATION]);
  });
});

describe("verify", () => {
  it("moves the request to verified as the caller and returns 202", async () => {
    const h = harness();
    const res = await call(h.ctx, VERIFY, { parsedBody: { verificationMethod: "email_link" } });
    // 202, because verified is the runner's queue and nothing here ran the deletion.
    expect(res.status).toBe(202);
    expect(h.transitions[0]?.to).toBe("verified");
    expect(h.transitions[0]?.fields["verifiedBy"]).toBe(CALLER);
    expect(h.transitions[0]?.fields["verificationMethod"]).toBe("email_link");
    expect(h.events[0]?.operation).toBe(DELETION_REQUEST_VERIFIED_OPERATION);
  });

  it("refuses a verifier who is the submitter", async () => {
    const h = harness({}, { stored: requestOf({ submittedBy: CALLER }) });
    const res = await call(h.ctx, VERIFY, { parsedBody: { verificationMethod: "email_link" } });
    // Verification is the platform attesting the identity check passed; the person who typed the
    // request in cannot be the one who attests it.
    expect(res.status).toBe(403);
    expect(res.body["error"]).toBe("four_eyes_required");
    expect(h.transitions).toEqual([]);
  });

  it("refuses an id the column's CHECK would reject", async () => {
    const h = harness();
    const res = await call(h.ctx, VERIFY, {
      params: { id: "not-a-dreq" },
      parsedBody: { verificationMethod: "email_link" },
    });
    expect(res.status).toBe(400);
  });

  it("404s a request that is not there", async () => {
    const h = harness({}, { stored: null });
    const res = await call(h.ctx, VERIFY, { parsedBody: { verificationMethod: "email_link" } });
    expect(res.status).toBe(404);
  });

  it("503s an unreadable request rather than reading as an absence", async () => {
    const h = harness({}, { readThrows: true });
    const res = await call(h.ctx, VERIFY, { parsedBody: { verificationMethod: "email_link" } });
    expect(res.status).toBe(503);
  });

  it("reports an illegal transition as a 409", async () => {
    const h = harness({}, { transitionThrows: new Error("completed -> verified is not legal") });
    const res = await call(h.ctx, VERIFY, { parsedBody: { verificationMethod: "email_link" } });
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("illegal_transition");
  });

  it("reports a lost race as a 409, not a success", async () => {
    const h = harness({}, { transitionReturnsNull: true });
    const res = await call(h.ctx, VERIFY, { parsedBody: { verificationMethod: "email_link" } });
    // The in-predicate re-assertion did not match: somebody moved it in between.
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("concurrent_modification");
  });

  it("refuses a role with only the submit grant", async () => {
    const h = harness({ verifyRoles: new Set(["compliance_officer"]) });
    const res = await call(h.ctx, VERIFY, { parsedBody: { verificationMethod: "email_link" } });
    expect(res.status).toBe(403);
  });
});

describe("reject", () => {
  it("records the reason and returns the handle", async () => {
    const h = harness();
    const res = await call(h.ctx, REJECT, { parsedBody: { reason: "identity never verified" } });
    expect(res.status).toBe(200);
    expect(h.transitions[0]?.to).toBe("rejected");
    expect(h.transitions[0]?.fields["rejectedReason"]).toBe("identity never verified");
    expect(h.events[0]?.operation).toBe(DELETION_REQUEST_REJECTED_OPERATION);
  });

  it("requires a reason", async () => {
    const h = harness();
    const res = await call(h.ctx, REJECT, { parsedBody: {} });
    expect(res.status).toBe(400);
    expect(h.transitions).toEqual([]);
  });

  it("is the verify grant, not the submit one", async () => {
    const h = harness({ verifyRoles: new Set() });
    const res = await call(h.ctx, REJECT, { parsedBody: { reason: "no" } });
    expect(res.status).toBe(403);
  });
});

describe("read", () => {
  it("returns the handle and records the read", async () => {
    const h = harness({}, { stored: requestOf({ status: "completed", tombstoneId: TOMB }) });
    const res = await call(h.ctx, READ);
    expect(res.status).toBe(200);
    expect(res.body["tombstoneId"]).toBe(TOMB);
    expect(h.events[0]?.operation).toBe(DELETION_REQUEST_READ_OPERATION);
    expect(h.events[0]?.tombstoneId).toBe(TOMB);
  });

  it("503s an unreadable row rather than 404ing it", async () => {
    const h = harness({}, { readThrows: true });
    const res = await call(h.ctx, READ);
    // This is the route a caller polls to learn whether a deletion happened; a 404 would read as
    // "no such request", which is the opposite of true (ADR-0289).
    expect(res.status).toBe(503);
    expect(res.body["error"]).toBe("request_unreadable");
  });

  it("404s a missing request", async () => {
    const h = harness({}, { stored: null });
    expect((await call(h.ctx, READ)).status).toBe(404);
  });

  it("grants the read to either the submitter's or the verifier's role by default", async () => {
    const h = harness({
      submitRoles: new Set(["support"]),
      verifyRoles: new Set(["platform_admin"]),
    });
    expect((await call(h.ctx, READ)).status).toBe(200);
  });

  it("narrows to readRoles when one is configured", async () => {
    const h = harness({ readRoles: new Set(["auditor"]) });
    expect((await call(h.ctx, READ)).status).toBe(403);
  });
});
