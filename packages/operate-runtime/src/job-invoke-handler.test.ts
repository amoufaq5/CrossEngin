import type { HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import {
  buildJobInvokeHandler,
  type InvokedJobRun,
  type JobInvocationRequest,
  type JobInvoker,
} from "./job-invoke-handler.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function invokerOf(
  runs: readonly InvokedJobRun[],
  captured?: JobInvocationRequest[],
): JobInvoker {
  return {
    invoke: async (req) => {
      captured?.push(req);
      return runs;
    },
  };
}

function input(overrides: Partial<HandlerInput>): HandlerInput {
  return {
    request: {} as HandlerInput["request"],
    route: {} as HandlerInput["route"],
    principal: { tenantId: TENANT } as HandlerInput["principal"],
    params: {},
    parsedBody: null,
    ...overrides,
  };
}

function body(output: HandlerOutput): unknown {
  return output.kind === "json" ? output.body : undefined;
}

describe("buildJobInvokeHandler", () => {
  it("202s with the enqueued runs for a matching action", async () => {
    const captured: JobInvocationRequest[] = [];
    const handler = buildJobInvokeHandler(
      invokerOf([{ jobId: "reindex", runId: "run-1", inserted: true }], captured),
    );
    const out = await handler(input({ parsedBody: { action: "reindex-catalog", data: { scope: "all" } } }));
    expect(out.status).toBe(202);
    expect(body(out)).toEqual({ action: "reindex-catalog", runs: [{ jobId: "reindex", runId: "run-1", inserted: true }] });
    expect(captured[0]).toEqual({ tenantId: TENANT, action: "reindex-catalog", data: { scope: "all" } });
  });

  it("passes an idempotencyKey through and defaults data to {}", async () => {
    const captured: JobInvocationRequest[] = [];
    const handler = buildJobInvokeHandler(invokerOf([{ jobId: "j", runId: "r", inserted: true }], captured));
    await handler(input({ parsedBody: { action: "run", idempotencyKey: "k1" } }));
    expect(captured[0]).toEqual({ tenantId: TENANT, action: "run", data: {}, idempotencyKey: "k1" });
  });

  it("404s when no job listens for the action", async () => {
    const handler = buildJobInvokeHandler(invokerOf([]));
    const out = await handler(input({ parsedBody: { action: "unknown-action" } }));
    expect(out.status).toBe(404);
    expect(body(out)).toMatchObject({ error: "no_job_for_action" });
  });

  it("400s on a missing/blank action", async () => {
    const handler = buildJobInvokeHandler(invokerOf([]));
    expect((await handler(input({ parsedBody: {} }))).status).toBe(400);
    expect((await handler(input({ parsedBody: { action: "   " } }))).status).toBe(400);
  });

  it("401s when the principal has no tenant (tenant is authoritative, never a body field)", async () => {
    const handler = buildJobInvokeHandler(invokerOf([{ jobId: "j", runId: "r", inserted: true }]));
    const out = await handler(input({ principal: null, parsedBody: { action: "run", tenantId: "spoofed" } }));
    expect(out.status).toBe(401);
  });

  describe("role gating", () => {
    const runsInvoker = invokerOf([{ jobId: "j", runId: "r", inserted: true }]);
    const principalRoles = (p: { primaryRole?: string } | null) => ({
      primaryRole: (p?.primaryRole ?? "viewer") as string,
      secondaryRoles: [] as readonly string[],
    });

    function principalWithRole(role: string): HandlerInput["principal"] {
      return { tenantId: TENANT, primaryRole: role } as unknown as HandlerInput["principal"];
    }

    it("202s when the caller's role is in the allow-list", async () => {
      const handler = buildJobInvokeHandler(runsInvoker, {
        allowedRoles: new Set(["ops_admin"]),
        principalRoles: principalRoles as never,
      });
      const out = await handler(input({ principal: principalWithRole("ops_admin"), parsedBody: { action: "run" } }));
      expect(out.status).toBe(202);
    });

    it("403s when the caller's role is not in the allow-list", async () => {
      const handler = buildJobInvokeHandler(runsInvoker, {
        allowedRoles: new Set(["ops_admin"]),
        principalRoles: principalRoles as never,
      });
      const out = await handler(input({ principal: principalWithRole("cashier"), parsedBody: { action: "run" } }));
      expect(out.status).toBe(403);
      expect(body(out)).toMatchObject({ error: "forbidden" });
    });

    it("is fail-closed: an allow-list with no principalRoles bridge denies everyone", async () => {
      const handler = buildJobInvokeHandler(runsInvoker, { allowedRoles: new Set(["ops_admin"]) });
      const out = await handler(input({ principal: principalWithRole("ops_admin"), parsedBody: { action: "run" } }));
      expect(out.status).toBe(403);
    });

    it("is open when no allow-list is set (any authenticated tenant principal)", async () => {
      const handler = buildJobInvokeHandler(runsInvoker, { principalRoles: principalRoles as never });
      const out = await handler(input({ principal: principalWithRole("cashier"), parsedBody: { action: "run" } }));
      expect(out.status).toBe(202);
    });
  });
});
