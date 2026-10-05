import { describe, expect, it } from "vitest";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput } from "@crossengin/api-gateway-runtime";

import {
  DELETABLE_TOMBSTONE_KINDS,
  DeleteTenantInputSchema,
  TENANT_DELETED_OPERATION,
  TENANT_DELETE_REFUSED_OPERATION,
  TENANT_TOMBSTONES_READ_OPERATION,
  buildTenantDeletionRoutes,
  newTombstoneId,
  tombstoneReceipt,
  type DeletionOutcomeLike,
  type StoredTombstoneLike,
  type TenantDeletionEvent,
  type TenantDeletionRoutesContext,
} from "./tenant-deletion-routes.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const CALLER = "11111111-1111-1111-1111-111111111111";
const APPROVER = "22222222-2222-2222-2222-222222222222";
const AT = "2026-10-03T13:00:00.000Z";
const TOMB = "tomb_aaaabbbbccccdddd";
const HASH = "f".repeat(64);

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

function storedOf(over: Partial<StoredTombstoneLike["record"]> = {}): StoredTombstoneLike {
  return {
    record: {
      id: TOMB,
      kind: "tenant_deletion",
      tenantId: TENANT,
      deletedAt: AT,
      scope: { schemas: ["t_abc"], tables: ["t_abc.invoice"], rowCount: 26 },
      contentManifestSha256: "a".repeat(64),
      proofSha256: "b".repeat(64),
      anchors: [{ kind: "internal_audit_log", reference: HASH }],
      ...over,
    },
    attestations: [
      { subsystem: "tenant_schema", outcome: "erased", attestedBy: "pipeline", attestedAt: AT },
    ],
    chainEntryHash: HASH,
    chainSequenceNumber: 42,
  };
}

const OK_OUTCOME: DeletionOutcomeLike = {
  ok: true,
  stored: storedOf(),
  erased: {
    schema: "t_abc",
    tables: ["t_abc.invoice"],
    rowCount: 26,
    storageBytes: 65536,
    alreadyAbsent: false,
  },
};

interface Harness {
  readonly ctx: TenantDeletionRoutesContext;
  readonly events: TenantDeletionEvent[];
  readonly deleteCalls: Array<Record<string, unknown>>;
  readonly retireCalls: string[];
}

function harness(
  over: Partial<TenantDeletionRoutesContext> = {},
  behaviour: {
    readonly outcome?: DeletionOutcomeLike;
    readonly deleteThrows?: unknown;
    readonly retireThrows?: boolean;
    readonly retires?: boolean;
    readonly listThrows?: boolean;
    readonly recordThrows?: boolean;
  } = {},
): Harness {
  const events: TenantDeletionEvent[] = [];
  const deleteCalls: Array<Record<string, unknown>> = [];
  const retireCalls: string[] = [];
  const ctx: TenantDeletionRoutesContext = {
    deleter: {
      delete: async (input): Promise<DeletionOutcomeLike> => {
        deleteCalls.push({ ...input });
        if (behaviour.deleteThrows !== undefined) throw behaviour.deleteThrows;
        return behaviour.outcome ?? OK_OUTCOME;
      },
      retire: async (tenantId): Promise<boolean> => {
        retireCalls.push(tenantId);
        if (behaviour.retireThrows === true) throw new Error("retire exploded");
        return behaviour.retires ?? true;
      },
      tombstonesFor: async (): Promise<readonly StoredTombstoneLike[]> => {
        if (behaviour.listThrows === true) throw new Error("a stored row no longer parses");
        return [storedOf()];
      },
    },
    principalRoles: (p) => ({
      primaryRole: p === null ? "anonymous" : "platform_admin",
      secondaryRoles: [],
    }),
    deleteRoles: new Set(["platform_admin"]),
    recordAction: async (event): Promise<void> => {
      if (behaviour.recordThrows === true) throw new Error("audit unreachable");
      events.push(event);
    },
    newTombstoneId: () => TOMB,
    clock: () => new Date(AT),
    ...over,
  };
  return { ctx, events, deleteCalls, retireCalls };
}

const DELETE = "platform.tenants.delete";
const LIST = "platform.tenants.tombstones";
const BODY = { approvedBy: APPROVER, confirmTenantId: TENANT };

function handlerFor(ctx: TenantDeletionRoutesContext, op: string): Handler {
  const found = buildTenantDeletionRoutes(ctx).find((r) => r.route.operationId === op);
  if (found === undefined) throw new Error(`no route for ${op}`);
  return found.handler;
}

async function call(
  ctx: TenantDeletionRoutesContext,
  op: string,
  over: Partial<HandlerInput> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const out = await handlerFor(ctx, op)({
    request: {} as HandlerInput["request"],
    route: {} as HandlerInput["route"],
    principal: principal(),
    params: { id: TENANT },
    parsedBody: null,
    ...over,
  });
  if (out.kind !== "json") throw new Error(`expected json, got ${out.kind}`);
  return { status: out.status, body: out.body as Record<string, unknown> };
}

describe("the route declarations", () => {
  it("are a POST delete and a GET tombstones", () => {
    const routes = buildTenantDeletionRoutes(harness().ctx);
    expect(
      routes.map((r) => ({
        method: r.route.method,
        path: r.route.pathSegments
          .map((s) => (s.kind === "literal" ? s.value : s.kind === "parameter" ? `:${s.name}` : "*"))
          .join("/"),
      })),
    ).toEqual([
      { method: "POST", path: "v1/platform/tenants/:id/delete" },
      { method: "GET", path: "v1/platform/tenants/:id/tombstones" },
    ]);
  });

  it("requires an idempotency key on the delete and not on the read", () => {
    const routes = buildTenantDeletionRoutes(harness().ctx);
    // A retried delete generates a new tombstone id, erases nothing the second time, and the
    // assembler refuses scope_empty — a 409 for a request that already succeeded.
    expect(routes.find((r) => r.route.operationId === DELETE)?.route.idempotencyRequired).toBe(true);
    expect(routes.find((r) => r.route.operationId === LIST)?.route.idempotencyRequired).toBe(false);
  });
});

describe("newTombstoneId", () => {
  it("produces an id the contract accepts", () => {
    expect(newTombstoneId("3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8")).toBe(
      "tomb_3f2a1b4c5d6e4f708192a3b4c5d6e7f8",
    );
  });

  it("throws rather than returning something the contract would refuse downstream", () => {
    expect(() => newTombstoneId("short")).toThrow(/invalid/);
  });
});

describe("DeleteTenantInputSchema", () => {
  it("defaults the kind and the optional lists", () => {
    const parsed = DeleteTenantInputSchema.parse(BODY);
    expect(parsed.kind).toBe("tenant_deletion");
    // The field is gone from the body: a remote caller cannot narrow the proof's reach, and an
    // omitted field cannot make it cover nothing (ADR-0328).
    expect("requiredSubsystems" in parsed).toBe(false);
    expect(parsed.attestations).toEqual([]);
  });

  it("rejects unknown keys and a non-uuid confirmation", () => {
    expect(DeleteTenantInputSchema.safeParse({ ...BODY, extra: 1 }).success).toBe(false);
    expect(DeleteTenantInputSchema.safeParse({ ...BODY, confirmTenantId: "nope" }).success).toBe(false);
  });

  it("accepts only the two kinds a tenant-scoped delete can produce", () => {
    expect([...DELETABLE_TOMBSTONE_KINDS]).toEqual(["tenant_deletion", "data_subject_erasure"]);
    expect(DeleteTenantInputSchema.safeParse({ ...BODY, kind: "scheduled_purge" }).success).toBe(false);
  });
});

describe("the delete route", () => {
  it("deletes, retires the tenant, and returns the receipt", async () => {
    const h = harness();
    const res = await call(h.ctx, DELETE, { parsedBody: BODY });
    expect(res.status).toBe(200);
    expect(res.body["deleted"]).toBe(true);
    expect(res.body["tenantRetired"]).toBe(true);
    const receipt = res.body["tombstone"] as Record<string, unknown>;
    // Not a bare "deleted": the receipt is the only thing that can later establish what was
    // destroyed.
    expect(receipt["tombstoneId"]).toBe(TOMB);
    expect(receipt["chainEntryHash"]).toBe(HASH);
    expect(receipt["proofSha256"]).toBe("b".repeat(64));
    expect(h.retireCalls).toEqual([TENANT]);
  });

  it("retires the tenant AFTER the pipeline, never before", async () => {
    const order: string[] = [];
    const h = harness({
      deleter: {
        delete: async (): Promise<DeletionOutcomeLike> => {
          order.push("pipeline");
          return OK_OUTCOME;
        },
        retire: async (): Promise<boolean> => {
          order.push("retire");
          return true;
        },
        tombstonesFor: async (): Promise<readonly StoredTombstoneLike[]> => [],
      },
    });
    await call(h.ctx, DELETE, { parsedBody: BODY });
    // ADR-0316's ordering: the tombstone's anchor references meta.tenants, so retiring first makes
    // the deletion unrecordable.
    expect(order).toEqual(["pipeline", "retire"]);
  });

  it("still reports the deletion when retiring the tenant row fails", async () => {
    const seen: string[] = [];
    const h = harness({ onRetireError: (_e, t) => seen.push(t) }, { retireThrows: true });
    const res = await call(h.ctx, DELETE, { parsedBody: BODY });
    // The data is gone and proven gone; a failure to retire leaves a visible, recoverable mismatch
    // and must not read as "the deletion failed".
    expect(res.status).toBe(200);
    expect(res.body["deleted"]).toBe(true);
    expect(res.body["tenantRetired"]).toBe(false);
    expect(seen).toEqual([TENANT]);
  });

  it("takes executedBy from the credential and refuses a self-approval", async () => {
    const h = harness();
    const res = await call(h.ctx, DELETE, { parsedBody: { ...BODY, approvedBy: CALLER } });
    expect(res.status).toBe(403);
    expect(res.body["error"]).toBe("four_eyes_required");
    expect(h.deleteCalls).toEqual([]);
  });

  it("passes the authenticated principal as executedBy", async () => {
    const h = harness();
    await call(h.ctx, DELETE, { parsedBody: BODY });
    expect(h.deleteCalls[0]?.["executedBy"]).toBe(CALLER);
    expect(h.deleteCalls[0]?.["approvedBy"]).toBe(APPROVER);
  });

  it("requires the body to confirm the tenant in the path", async () => {
    const h = harness();
    const res = await call(h.ctx, DELETE, {
      parsedBody: { approvedBy: APPROVER, confirmTenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    });
    expect(res.status).toBe(400);
    expect(h.deleteCalls).toEqual([]);
  });

  it("refuses a data_subject_erasure with no deletion request, before the drop", async () => {
    const h = harness();
    const res = await call(h.ctx, DELETE, {
      parsedBody: { ...BODY, kind: "data_subject_erasure" },
    });
    // The pipeline would abort after the drop had executed; refusing here keeps a recoverable
    // mistake from costing a rolled-back transaction over a tenant's data.
    expect(res.status).toBe(400);
    expect(String(res.body["detail"])).toContain("relatedDeletionRequestId");
    expect(h.deleteCalls).toEqual([]);
  });

  it("accepts a data_subject_erasure that names its request", async () => {
    const h = harness();
    const res = await call(h.ctx, DELETE, {
      parsedBody: { ...BODY, kind: "data_subject_erasure", relatedDeletionRequestId: "del_1" },
    });
    expect(res.status).toBe(200);
    expect(h.deleteCalls[0]?.["relatedDeletionRequestId"]).toBe("del_1");
  });

  it("reports a rolled-back pipeline as 409, saying the tenant is unchanged", async () => {
    const aborted = Object.assign(new Error("rolled back"), {
      name: "DeletionPipelineAborted",
      refusals: [{ stage: "assemble", reason: "subsystem_unattested", detail: "backups" }],
    });
    const h = harness({}, { deleteThrows: aborted });
    const res = await call(h.ctx, DELETE, { parsedBody: BODY });
    // Not a 500: nothing is broken. The deletion was refused after the drop and correctly undone.
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("deletion_rolled_back");
    expect(res.body["refusals"]).toEqual(["assemble/subsystem_unattested"]);
    expect(h.retireCalls).toEqual([]);
  });

  it("reports a returned refusal as 409 without retiring the tenant", async () => {
    const h = harness(
      {},
      {
        outcome: {
          ok: false,
          refusals: [{ stage: "erase", reason: "external_dependents", detail: "view public.x" }],
        },
      },
    );
    const res = await call(h.ctx, DELETE, { parsedBody: BODY });
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("deletion_refused");
    expect(h.retireCalls).toEqual([]);
    expect(h.events[0]?.operation).toBe(TENANT_DELETE_REFUSED_OPERATION);
  });

  it("records the deletion with its tombstone and chain hash", async () => {
    const h = harness();
    await call(h.ctx, DELETE, { parsedBody: BODY });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      operation: TENANT_DELETED_OPERATION,
      tombstoneId: TOMB,
      chainEntryHash: HASH,
      rowCount: 26,
      tenantRetired: true,
      approvedBy: APPROVER,
    });
  });

  it("does not fail the request when the audit record cannot be written", async () => {
    const seen: string[] = [];
    const h = harness({ onRecordError: (_e, op) => seen.push(op) }, { recordThrows: true });
    const res = await call(h.ctx, DELETE, { parsedBody: BODY });
    // Unlike the erasure's recorder, a deletion already has a stored anchored tombstone by here, so
    // a missing audit line is a gap in the operational trail and not in the proof.
    expect(res.status).toBe(200);
    expect(seen).toEqual([TENANT_DELETED_OPERATION]);
  });

  it("401s with no principal, 403s an ungranted role and an empty grant", async () => {
    expect((await call(harness().ctx, DELETE, { principal: null, parsedBody: BODY })).status).toBe(401);
    const cashier = harness({ principalRoles: () => ({ primaryRole: "cashier", secondaryRoles: [] }) });
    expect((await call(cashier.ctx, DELETE, { parsedBody: BODY })).status).toBe(403);
    expect(cashier.deleteCalls).toEqual([]);
    const ungranted = harness({ deleteRoles: new Set() });
    expect((await call(ungranted.ctx, DELETE, { parsedBody: BODY })).status).toBe(403);
  });
});

describe("the tombstones route", () => {
  it("lists receipts for a tenant", async () => {
    const h = harness();
    const res = await call(h.ctx, LIST);
    expect(res.status).toBe(200);
    const data = res.body["data"] as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0]?.["tombstoneId"]).toBe(TOMB);
    expect(h.events[0]?.operation).toBe(TENANT_TOMBSTONES_READ_OPERATION);
  });

  it("503s an unreadable stored row rather than returning an empty list", async () => {
    const h = harness({}, { listThrows: true });
    const res = await call(h.ctx, LIST);
    // The store re-parses every row, so a throw can mean a record no longer satisfies its contract.
    // An empty list would read as "this tenant was never deleted", which is the opposite of true.
    expect(res.status).toBe(503);
    expect(String(res.body["detail"])).toContain("do not treat this as an absence");
  });

  it("falls back to the delete grant when no read grant is configured", async () => {
    const h = harness({ readRoles: undefined });
    expect((await call(h.ctx, LIST)).status).toBe(200);
  });

  it("honours a separate read grant, so an auditor can read without deleting", async () => {
    const h = harness({
      deleteRoles: new Set(["platform_admin"]),
      readRoles: new Set(["auditor"]),
      principalRoles: () => ({ primaryRole: "auditor", secondaryRoles: [] }),
    });
    expect((await call(h.ctx, LIST)).status).toBe(200);
    // …and that auditor may not delete.
    expect((await call(h.ctx, DELETE, { parsedBody: BODY })).status).toBe(403);
  });
});

describe("tombstoneReceipt", () => {
  it("carries the digests, the anchor and who attested", () => {
    const receipt = tombstoneReceipt(storedOf());
    expect(receipt["contentManifestSha256"]).toBe("a".repeat(64));
    expect(receipt["chainSequenceNumber"]).toBe(42);
    expect(receipt["attestedBy"]).toEqual(["tenant_schema:pipeline"]);
    expect(receipt["retainedReason"]).toBeUndefined();
  });

  it("includes the retention prose when something was lawfully kept", () => {
    const receipt = tombstoneReceipt(storedOf({ retainedReason: "retained under tax_records_7y" }));
    expect(receipt["retainedReason"]).toContain("tax_records_7y");
  });
});
