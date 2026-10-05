import { describe, expect, it } from "vitest";
import { matchRoute, type ResolvedPrincipal } from "@crossengin/api-gateway";
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
  DELETION_REQUEST_RECONCILED_OPERATION,
  DELETION_EVIDENCE_AUDITED_OPERATION,
  TOMBSTONE_SWEEP_AUDITED_OPERATION,
  type DeletionRequestEvent,
  type DeletionRequestLike,
  type DeletionRequestRoutesContext,
  type EvidenceAuditLike,
  type ReconciliationLike,
  type TombstoneAuditLike,
  type TombstoneAuditPageLike,
} from "./deletion-request-routes.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const CALLER = "11111111-1111-1111-1111-111111111111";
const REQ = "dreq_abcdefgh1234";
const TOMB = "tomb_aaaabbbbccccdddd";
const AT = "2026-10-03T13:00:00.000Z";

function principal(over: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    principalId: CALLER,
    tenantId: TENANT,
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

function verdictOf(over: Partial<ReconciliationLike> = {}): ReconciliationLike {
  return {
    requestId: REQ,
    tenantId: TENANT,
    verdict: "never_committed",
    tombstoneId: null,
    tombstoneIds: [],
    evidence: { ok: true, defects: [], matchesAttestations: true },
    applied: false,
    tenantRetired: null,
    strandedForMs: 7_200_000,
    detail: "no tombstone names this request, so its transaction did not commit",
    ...over,
  };
}

interface Harness {
  readonly ctx: DeletionRequestRoutesContext;
  readonly events: DeletionRequestEvent[];
  readonly submits: Array<Record<string, unknown>>;
  readonly transitions: Array<{ to: string; fields: Record<string, unknown> }>;
  readonly reconciled: Array<{ id: string; applyNeverCommitted: boolean | undefined }>;
  readonly strandedCalls: string[];
  readonly auditCalls: (number | undefined)[];
  readonly sweepCalls: Array<Record<string, unknown>>;
  readonly escalated: string[];
  readonly escalatedVerdicts: string[];
}

function harness(
  over: Partial<DeletionRequestRoutesContext> = {},
  behaviour: {
    readonly stored?: DeletionRequestLike | null;
    readonly readThrows?: boolean;
    readonly submitThrows?: unknown;
    readonly transitionThrows?: unknown;
    readonly transitionReturnsNull?: boolean;
    readonly verdict?: ReconciliationLike;
    readonly stranded?: readonly DeletionRequestLike[];
    readonly strandedThrows?: boolean;
    readonly findings?: readonly EvidenceAuditLike[];
    readonly auditThrows?: boolean;
    readonly sweep?: TombstoneAuditPageLike;
    readonly sweepThrows?: boolean;
  } = {},
): Harness {
  const events: DeletionRequestEvent[] = [];
  const submits: Array<Record<string, unknown>> = [];
  const transitions: Array<{ to: string; fields: Record<string, unknown> }> = [];
  const reconciled: Array<{ id: string; applyNeverCommitted: boolean | undefined }> = [];
  const strandedCalls: string[] = [];
  const auditCalls: (number | undefined)[] = [];
  const sweepCalls: Array<Record<string, unknown>> = [];
  const escalated: string[] = [];
  const escalatedVerdicts: string[] = [];
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
      stranded: async (olderThan): Promise<readonly DeletionRequestLike[]> => {
        strandedCalls.push(olderThan);
        if (behaviour.strandedThrows === true) throw new Error("a stored row no longer parses");
        return behaviour.stranded ?? [requestOf({ status: "in_progress", inProgressAt: AT })];
      },
    },
    reconciler: {
      assess: async (): Promise<ReconciliationLike> => behaviour.verdict ?? verdictOf(),
      auditCompleted: async (limit): Promise<readonly EvidenceAuditLike[]> => {
        auditCalls.push(limit);
        if (behaviour.auditThrows === true) throw new Error("a stored tombstone no longer parses");
        return behaviour.findings ?? [];
      },
      auditTombstones: async (input): Promise<TombstoneAuditPageLike> => {
        sweepCalls.push({ ...input });
        if (behaviour.sweepThrows === true) throw new Error("a stored tombstone no longer parses");
        return behaviour.sweep ?? sweepPageOf();
      },
      reconcileOne: async (request, opts): Promise<ReconciliationLike> => {
        reconciled.push({
          id: request.id,
          applyNeverCommitted: opts?.applyNeverCommitted,
        });
        return behaviour.verdict ?? verdictOf();
      },
    },
    reconcileRoles: new Set(["platform_admin"]),
    escalate: async (finding): Promise<void> => {
      escalated.push(finding.requestId);
    },
    escalateVerdict: async (result): Promise<void> => {
      escalatedVerdicts.push(result.verdict);
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
  return {
    ctx,
    events,
    submits,
    transitions,
    reconciled,
    strandedCalls,
    auditCalls,
    sweepCalls,
    escalated,
    escalatedVerdicts,
  };
}

const SUBMIT = "platform.deletion_requests.submit";
const VERIFY = "platform.deletion_requests.verify";
const REJECT = "platform.deletion_requests.reject";
const READ = "platform.deletion_requests.read";
const RECONCILE = "platform.deletion_requests.reconcile";
const STRANDED = "platform.deletion_requests.stranded";

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
  it("are submit, verify, reject, reconcile, the two unprovens, stranded and read", () => {
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
      { method: "POST", path: "v1/platform/deletion-requests/{id}/reconcile" },
      { method: "GET", path: "v1/platform/deletion-requests/unproven" },
      // The sweep hangs off `tombstones`, not `deletion-requests`, because it starts from the proofs
      // and the ones it exists for name no request at all (ADR-0327).
      { method: "GET", path: "v1/platform/tombstones/unproven" },
      { method: "GET", path: "v1/platform/deletion-requests/stranded" },
      { method: "GET", path: "v1/platform/deletion-requests/{id}" },
    ]);
  });

  it("requires an idempotency key on the submit alone", () => {
    const routes = buildDeletionRequestRoutes(harness().ctx);
    // The id is generated server-side, so a retry without a key opens a *second* request for the same
    // subject — and both would run. Nothing else here creates anything.
    expect(routes.map((r) => r.route.idempotencyRequired)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("matches /stranded as the literal route, not as a request whose id is 'stranded'", () => {
    // Pinned against the REAL matcher, because `matchRoute` returns the first declaration-order
    // match with no preference for a literal over a parameter — so this is a property of the order
    // these are declared in, and a comment could not enforce it.
    const routes = buildDeletionRequestRoutes(harness().ctx).map((r) => r.route);
    const at = new Date(AT);
    const matched = matchRoute(
      routes,
      "GET",
      "/v1/platform/deletion-requests/stranded",
      "v1",
      at,
    );
    expect(matched.outcome).toBe("matched");
    expect(matched.route?.operationId).toBe("platform.deletion_requests.stranded");
    const byId = matchRoute(routes, "GET", `/v1/platform/deletion-requests/${REQ}`, "v1", at);
    expect(byId.route?.operationId).toBe("platform.deletion_requests.read");
    expect(byId.pathParameters["id"]).toBe(REQ);
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

describe("stranded", () => {
  it("lists every in_progress request with its verdict, writing nothing", async () => {
    const h = harness();
    const res = await call(h.ctx, STRANDED);
    expect(res.status).toBe(200);
    const data = res.body["data"] as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect((data[0]?.["reconciliation"] as ReconciliationLike).verdict).toBe("never_committed");
    // A list is for looking at; applying is the POST.
    expect(h.reconciled).toEqual([]);
  });

  it("asks for everything in_progress, not just what is past the window", async () => {
    const h = harness();
    await call(h.ctx, STRANDED);
    // The window governs the inference from absence, not the listing (ADR-0322).
    expect(h.strandedCalls).toEqual([AT]);
  });

  it("503s when a stored request cannot be read", async () => {
    const h = harness({}, { strandedThrows: true });
    const res = await call(h.ctx, STRANDED);
    expect(res.status).toBe(503);
  });

  it("is its own grant, not the read one", async () => {
    const h = harness({ reconcileRoles: new Set(["sre"]), readRoles: new Set(["platform_admin"]) });
    expect((await call(h.ctx, STRANDED)).status).toBe(403);
  });

  it("refuses an ungranted caller before admitting whether reconciliation is even wired", async () => {
    const h = harness({ reconciler: undefined, reconcileRoles: new Set() });
    // Fail-closed ordering: a 501 would tell an unauthorised caller about the deployment's config.
    expect((await call(h.ctx, STRANDED)).status).toBe(403);
  });

  it("501s a granted caller when no reconciler is wired", async () => {
    const h = harness({ reconciler: undefined });
    expect((await call(h.ctx, STRANDED)).status).toBe(501);
  });
});

describe("reconcile", () => {
  it("applies a conclusive verdict and returns 200 with the refreshed handle", async () => {
    const h = harness(
      {},
      { verdict: verdictOf({ verdict: "completed_by_evidence", tombstoneId: TOMB, applied: true }) },
    );
    const res = await call(h.ctx, RECONCILE, { parsedBody: {} });
    expect(res.status).toBe(200);
    expect((res.body["reconciliation"] as ReconciliationLike).tombstoneId).toBe(TOMB);
    expect(h.events[0]?.operation).toBe(DELETION_REQUEST_RECONCILED_OPERATION);
    expect(h.events[0]?.detail).toBe("applied: completed_by_evidence");
  });

  it("does not authorise the inference by default", async () => {
    const h = harness();
    await call(h.ctx, RECONCILE, { parsedBody: {} });
    // An absence is an inference, so applying it is never a default.
    expect(h.reconciled).toEqual([{ id: REQ, applyNeverCommitted: false }]);
  });

  it("passes the operator's authorisation through when they give it", async () => {
    const h = harness({}, { verdict: verdictOf({ applied: true }) });
    const res = await call(h.ctx, RECONCILE, { parsedBody: { acceptNeverCommitted: true } });
    expect(h.reconciled).toEqual([{ id: REQ, applyNeverCommitted: true }]);
    expect(res.status).toBe(200);
  });

  it("409s a verdict that needs an operator, so a 200 cannot read as resolved", async () => {
    const h = harness();
    const res = await call(h.ctx, RECONCILE, { parsedBody: {} });
    expect(res.status).toBe(409);
    expect((res.body["reconciliation"] as ReconciliationLike).verdict).toBe("never_committed");
  });

  it("409s ambiguous evidence rather than choosing", async () => {
    const h = harness(
      {},
      {
        verdict: verdictOf({
          verdict: "ambiguous_evidence",
          tombstoneIds: [TOMB, "tomb_bbbbccccddddeeee"],
        }),
      },
    );
    const res = await call(h.ctx, RECONCILE, { parsedBody: { acceptNeverCommitted: true } });
    expect(res.status).toBe(409);
    expect((res.body["reconciliation"] as ReconciliationLike).tombstoneIds).toHaveLength(2);
  });

  it("records the assessment even when nothing was applied", async () => {
    const h = harness();
    await call(h.ctx, RECONCILE, { parsedBody: {} });
    expect(h.events[0]?.detail).toBe("assessed: never_committed");
  });

  it("refuses a body it does not recognise", async () => {
    const h = harness();
    const res = await call(h.ctx, RECONCILE, { parsedBody: { force: true } });
    expect(res.status).toBe(400);
    expect(h.reconciled).toEqual([]);
  });

  it("404s a request that is not there, and 503s one that will not parse", async () => {
    expect((await call(harness({}, { stored: null }).ctx, RECONCILE, { parsedBody: {} })).status).toBe(404);
    expect((await call(harness({}, { readThrows: true }).ctx, RECONCILE, { parsedBody: {} })).status).toBe(503);
  });

  it("refuses an id the column's CHECK would reject", async () => {
    const h = harness();
    const res = await call(h.ctx, RECONCILE, { params: { id: "stranded" }, parsedBody: {} });
    expect(res.status).toBe(400);
  });
});

const UNPROVEN = "platform.deletion_requests.unproven";

function findingOf(over: Partial<EvidenceAuditLike> = {}): EvidenceAuditLike {
  return {
    requestId: REQ,
    tenantId: TENANT,
    tombstoneId: TOMB,
    present: true,
    digestMatches: true,
    check: { ok: false, defects: ["scope_tampered"], matchesAttestations: false },
    detail: "tombstone does not verify: scope_tampered",
    ...over,
  };
}

describe("unproven", () => {
  it("matches as a literal route, like stranded", () => {
    const routes = buildDeletionRequestRoutes(harness().ctx).map((r) => r.route);
    const matched = matchRoute(
      routes,
      "GET",
      "/v1/platform/deletion-requests/unproven",
      "v1",
      new Date(AT),
    );
    expect(matched.route?.operationId).toBe(UNPROVEN);
  });

  it("returns the findings and says so when there are none", async () => {
    const h = harness();
    const res = await call(h.ctx, UNPROVEN);
    expect(res.status).toBe(200);
    expect(res.body["findings"]).toEqual([]);
    expect(res.body["clean"]).toBe(true);
  });

  it("reports a completed request whose proof no longer stands up", async () => {
    const h = harness({}, { findings: [findingOf()] });
    const res = await call(h.ctx, UNPROVEN);
    const findings = res.body["findings"] as EvidenceAuditLike[];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.check?.defects).toEqual(["scope_tampered"]);
    expect(res.body["clean"]).toBe(false);
  });

  it("records the audit even when it is clean", async () => {
    const h = harness();
    await call(h.ctx, UNPROVEN);
    // "We checked and found nothing" is the claim an auditor needs, and it cannot be made from the
    // absence of a log line.
    expect(h.events[0]?.operation).toBe("platform.deletion_evidence_audited");
    expect(h.events[0]?.status).toBe("clean");
    expect(h.events[0]?.detail).toBe("0 finding(s)");
  });

  it("records the audit against the reader's own tenant", async () => {
    const h = harness();
    await call(h.ctx, UNPROVEN, { principal: principal({ tenantId: TENANT }) });
    // The findings may span several tenants or none. ADR-0331 made a platform-scope row
    // expressible, so the old mechanical reason (`tenant_id` was NOT NULL) has expired — but
    // the decision has not: this record is about a *person*, and filing it in their tenant's
    // trail is what makes the read accountable to the people whose data it touched.
    expect(h.events[0]?.tenantId).toBe(TENANT);
  });

  it("refuses a reader whose tenant cannot be resolved, rather than serving unaudited", async () => {
    const h = harness();
    const res = await call(h.ctx, UNPROVEN, { principal: principal({ tenantId: null }) });
    // ADR-0313's rule: an unrecordable privileged read is refused.
    expect(res.status).toBe(503);
    expect(res.body["error"]).toBe("audit_unrecordable");
    expect(h.auditCalls).toEqual([]);
  });

  it("503s an unreadable audit rather than reporting it clean", async () => {
    const h = harness({}, { auditThrows: true });
    const res = await call(h.ctx, UNPROVEN);
    // An empty list would read as "every completed deletion is provable", the opposite of what is
    // known — and an unparseable row is itself the finding this route exists to surface.
    expect(res.status).toBe(503);
    expect(res.body["error"]).toBe("evidence_unreadable");
  });

  it("is the reconcile grant, and 501s when reconciliation is unwired", async () => {
    expect((await call(harness({ reconcileRoles: new Set(["sre"]) }).ctx, UNPROVEN)).status).toBe(403);
    expect((await call(harness({ reconciler: undefined }).ctx, UNPROVEN)).status).toBe(501);
  });
});

describe("escalation from the routes (ADR-0324)", () => {
  it("escalates each audit finding, even though a human triggered the look", async () => {
    const h = harness({}, { findings: [findingOf(), findingOf({ requestId: "dreq_two12345678" })] });
    await call(h.ctx, UNPROVEN);
    // The audit exists to find a compromise the chain cannot see; one found warrants the incident
    // regardless of who was looking, and the escalator is idempotent per episode.
    expect(h.escalated).toEqual([REQ, "dreq_two12345678"]);
  });

  it("does not fail the audit when escalation throws", async () => {
    const errors: string[] = [];
    const h = harness(
      {
        escalate: async (): Promise<void> => {
          throw new Error("incident store unreachable");
        },
        onRecordError: (_e, op) => errors.push(op),
      },
      { findings: [findingOf()] },
    );
    const res = await call(h.ctx, UNPROVEN);
    expect(res.status).toBe(200);
    expect(errors).toHaveLength(1);
  });

  it("escalates a verdict reached through the reconcile route", async () => {
    const h = harness({}, { verdict: verdictOf({ verdict: "evidence_unverified" }) });
    await call(h.ctx, RECONCILE, { parsedBody: {} });
    // A deployment may expose these routes without the scheduler (ADR-0321), in which case this is
    // the only path that would ever see one.
    expect(h.escalatedVerdicts).toEqual(["evidence_unverified"]);
  });

  it("records the stranded listing, which ADR-0323 flagged as its own inconsistency", async () => {
    const h = harness();
    await call(h.ctx, STRANDED);
    expect(h.events[0]?.operation).toBe("platform.deletion_requests_stranded_read");
    expect(h.events[0]?.tenantId).toBe(TENANT);
    expect(h.events[0]?.detail).toBe("1 stranded");
  });

  it("refuses the stranded listing when the reader's tenant cannot be resolved", async () => {
    const h = harness();
    const res = await call(h.ctx, STRANDED, { principal: principal({ tenantId: null }) });
    expect(res.status).toBe(503);
    expect(res.body["error"]).toBe("audit_unrecordable");
    expect(h.strandedCalls).toEqual([]);
  });
});

const SWEEP = "platform.tombstones.unproven";

function tombstoneFindingOf(over: Partial<TombstoneAuditLike> = {}): TombstoneAuditLike {
  return {
    tombstoneId: TOMB,
    tenantId: TENANT,
    reference: "unreferenced",
    // Null is the case this direction exists for: the synchronous deletion route writes no request.
    relatedDeletionRequestId: null,
    detail: "does not verify: scope_tampered",
    ...over,
  };
}

function sweepPageOf(over: Partial<TombstoneAuditPageLike> = {}): TombstoneAuditPageLike {
  return { examined: 412, findings: [], nextAfterTombstoneId: null, ...over };
}

/** A request carrying only the query, which is all `cursorParam` reads. */
function withQuery(query: Record<string, string | string[]>): HandlerInput["request"] {
  return { query } as never;
}

describe("the tombstone sweep (ADR-0327)", () => {
  it("matches as its own literal route, under tombstones rather than deletion-requests", () => {
    const routes = buildDeletionRequestRoutes(harness().ctx).map((r) => r.route);
    const matched = matchRoute(
      routes,
      "GET",
      "/v1/platform/tombstones/unproven",
      "v1",
      new Date(AT),
    );
    expect(matched.outcome).toBe("matched");
    expect(matched.route?.operationId).toBe(SWEEP);
  });

  it("refuses an unauthenticated caller", async () => {
    const h = harness();
    const res = await call(h.ctx, SWEEP, { principal: null });
    expect(res.status).toBe(401);
    expect(h.sweepCalls).toEqual([]);
  });

  it("is the reconcile grant, not the read one", async () => {
    const h = harness({ reconcileRoles: new Set(["sre"]), readRoles: new Set(["platform_admin"]) });
    const res = await call(h.ctx, SWEEP);
    expect(res.status).toBe(403);
    expect(h.sweepCalls).toEqual([]);
  });

  it("refuses an ungranted caller before admitting whether reconciliation is wired", async () => {
    const h = harness({ reconciler: undefined, reconcileRoles: new Set() });
    // Fail-closed ordering, as on stranded: a 501 would tell an unauthorised caller about the config.
    expect((await call(h.ctx, SWEEP)).status).toBe(403);
  });

  it("501s when no reconciler is wired at all", async () => {
    const h = harness({ reconciler: undefined });
    const res = await call(h.ctx, SWEEP);
    expect(res.status).toBe(501);
    expect(res.body["error"]).toBe("reconciliation_unavailable");
  });

  it("501s a reconciler that has no auditTombstones, and mounts the rest anyway", async () => {
    const h = harness({
      reconciler: {
        assess: async (): Promise<ReconciliationLike> => verdictOf(),
        auditCompleted: async (): Promise<readonly EvidenceAuditLike[]> => [],
        reconcileOne: async (): Promise<ReconciliationLike> => verdictOf(),
      },
    });
    // A different condition from the one above, and the reason the method is optional on the mirror:
    // a deployment on an older store gets the other two directions rather than no routes at all.
    expect((await call(h.ctx, SWEEP)).status).toBe(501);
    expect((await call(h.ctx, UNPROVEN)).status).toBe(200);
  });

  it("refuses a reader whose tenant cannot be resolved, rather than sweeping unaudited", async () => {
    const h = harness();
    const res = await call(h.ctx, SWEEP, { principal: principal({ tenantId: null }) });
    // ADR-0313's rule: an unrecordable privileged read is refused rather than served. Still a
    // refusal now that a platform-scope row exists (ADR-0331), and deliberately so — handing
    // this reader one would admit an *unattributable* privileged read, which is worse.
    expect(res.status).toBe(503);
    expect(res.body["error"]).toBe("audit_unrecordable");
    expect(h.sweepCalls).toEqual([]);
  });

  it("503s an unreadable sweep rather than reporting it clean", async () => {
    const h = harness({}, { sweepThrows: true });
    const res = await call(h.ctx, SWEEP);
    // The store re-parses every row, so a throw can itself be the finding; an empty list would claim
    // every proof on file is sound.
    expect(res.status).toBe(503);
    expect(res.body["error"]).toBe("evidence_unreadable");
    expect(String(res.body["detail"])).toContain("absence of findings");
  });

  it("returns the page, and says clean with the number it verified", async () => {
    const h = harness();
    const res = await call(h.ctx, SWEEP);
    expect(res.status).toBe(200);
    expect(res.body["examined"]).toBe(412);
    expect(res.body["findings"]).toEqual([]);
    // The combination is the point: "we verified 412 and found nothing" is a claim, where an empty
    // findings list on its own is indistinguishable from not having looked.
    expect(res.body["clean"]).toBe(true);
    expect(res.body["nextAfter"]).toBeNull();
  });

  it("reports a tombstone that no request names, which no other direction can see", async () => {
    const h = harness({}, { sweep: sweepPageOf({ examined: 3, findings: [tombstoneFindingOf()] }) });
    const res = await call(h.ctx, SWEEP);
    const findings = res.body["findings"] as TombstoneAuditLike[];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reference).toBe("unreferenced");
    expect(findings[0]?.relatedDeletionRequestId).toBeNull();
    expect(res.body["clean"]).toBe(false);
  });

  it("hands back the cursor the page ended on", async () => {
    const h = harness({}, { sweep: sweepPageOf({ nextAfterTombstoneId: TOMB }) });
    expect((await call(h.ctx, SWEEP)).body["nextAfter"]).toBe(TOMB);
  });

  it("passes ?after= through as afterTombstoneId", async () => {
    const h = harness();
    await call(h.ctx, SWEEP, { request: withQuery({ after: TOMB }) });
    expect(h.sweepCalls).toEqual([{ afterTombstoneId: TOMB }]);
  });

  it("passes nothing at all when after is absent or empty, never an empty string", async () => {
    const h = harness();
    await call(h.ctx, SWEEP);
    await call(h.ctx, SWEEP, { request: withQuery({}) });
    await call(h.ctx, SWEEP, { request: withQuery({ after: "" }) });
    // An empty `afterTombstoneId` is not the same question as none: the store would be asked for
    // tombstones ordered after `''`, and the sweep's first page would depend on collation.
    expect(h.sweepCalls).toEqual([{}, {}, {}]);
    for (const c of h.sweepCalls) expect("afterTombstoneId" in c).toBe(false);
  });

  it("takes the first value of a repeated ?after=", async () => {
    const h = harness();
    await call(h.ctx, SWEEP, { request: withQuery({ after: [TOMB, "tomb_bbbbccccddddeeee"] }) });
    expect(h.sweepCalls).toEqual([{ afterTombstoneId: TOMB }]);
  });

  it("records the read even when it is clean, with the examined count in the detail", async () => {
    const h = harness();
    await call(h.ctx, SWEEP);
    expect(h.events[0]?.status).toBe("clean");
    // The count is the claim; "0 finding(s)" alone would not say how much was looked at.
    expect(h.events[0]?.detail).toBe("412 examined, 0 finding(s)");
  });

  it("records the sweep's own operation, not the request audit's", async () => {
    const h = harness();
    await call(h.ctx, SWEEP);
    // Two different facts — one sweeps proofs, the other completed requests — and an auditor counting
    // either must not be counting both.
    expect(h.events[0]?.operation).toBe(TOMBSTONE_SWEEP_AUDITED_OPERATION);
    expect(h.events[0]?.operation).not.toBe(DELETION_EVIDENCE_AUDITED_OPERATION);
  });

  it("records findings with the first one's tombstone, and no request id when it has none", async () => {
    const h = harness({}, { sweep: sweepPageOf({ examined: 9, findings: [tombstoneFindingOf()] }) });
    await call(h.ctx, SWEEP);
    expect(h.events[0]?.status).toBe("findings");
    expect(h.events[0]?.tombstoneId).toBe(TOMB);
    // The row these findings are about need not belong to any request, so the event's requestId is a
    // placeholder rather than a borrowed id.
    expect(h.events[0]?.requestId).toBe("-");
    expect(h.events[0]?.detail).toBe("9 examined, 1 finding(s)");
  });

  it("names the related request when a finding has one", async () => {
    const finding = tombstoneFindingOf({ reference: "dangling", relatedDeletionRequestId: REQ });
    const h = harness({}, { sweep: sweepPageOf({ findings: [finding] }) });
    await call(h.ctx, SWEEP);
    expect(h.events[0]?.requestId).toBe(REQ);
  });

  it("records against the reader's own tenant", async () => {
    const elsewhere = tombstoneFindingOf({ tenantId: "11111111-2222-4333-8444-555555555555" });
    const h = harness({}, { sweep: sweepPageOf({ findings: [elsewhere] }) });
    await call(h.ctx, SWEEP);
    // Not the finding's tenant: a page can span several, and the audit row is about the read.
    expect(h.events[0]?.tenantId).toBe(TENANT);
  });

  it("does not fail the sweep when the audit line cannot be written", async () => {
    const errors: string[] = [];
    const h = harness({
      recordAction: async (): Promise<void> => {
        throw new Error("audit unreachable");
      },
      onRecordError: (_e, op) => errors.push(op),
    });
    const res = await call(h.ctx, SWEEP);
    expect(res.status).toBe(200);
    expect(errors).toEqual([TOMBSTONE_SWEEP_AUDITED_OPERATION]);
  });
});
