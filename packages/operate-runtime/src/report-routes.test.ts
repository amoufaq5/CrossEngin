import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import {
  REPORT_RUN_OPERATION_ID,
  buildReportHandler,
  reportRouteDefinition,
  type ReportRunner,
} from "./report-routes.js";

function input(over: { principal?: ResolvedPrincipal | null; report?: string; query?: Record<string, string | string[]> }): HandlerInput {
  return {
    request: { query: over.query ?? {} } as unknown as HandlerInput["request"],
    route: reportRouteDefinition(),
    principal: over.principal ?? null,
    params: over.report !== undefined ? { report: over.report } : {},
    parsedBody: null,
  };
}

const principal = { tenantId: "t1" } as unknown as ResolvedPrincipal;

describe("reportRouteDefinition", () => {
  it("is a single GET /v1/reports/:report route", () => {
    const route = reportRouteDefinition();
    expect(route.operationId).toBe(REPORT_RUN_OPERATION_ID);
    expect(route.method).toBe("GET");
    expect(route.pathSegments).toEqual([
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "reports" },
      { kind: "parameter", name: "report", pattern: null },
    ]);
    expect(route.apiVersion).toBe("v1");
  });
});

describe("buildReportHandler", () => {
  const runner = (data: unknown | null): ReportRunner => ({ run: async () => data });
  const out = async (handler: Handler, inp: HandlerInput) => handler(inp);

  it("401 when the principal has no tenant", async () => {
    const res = await out(buildReportHandler(runner({ kind: "kpi" })), input({ principal: null, report: "x" }));
    expect(res.kind === "json" && res.status).toBe(401);
  });

  it("404 (fail-closed) when the runner returns null", async () => {
    const res = await out(buildReportHandler(runner(null)), input({ principal, report: "ghost" }));
    expect(res.kind === "json" && res.status).toBe(404);
    if (res.kind === "json") expect((res.body as { error: string }).error).toBe("report_unavailable");
  });

  it("200 with the runner's report data", async () => {
    const data = { kind: "kpi", name: "n", value: 42 };
    const res = await out(buildReportHandler(runner(data)), input({ principal, report: "sales" }));
    expect(res.kind === "json" && res.status).toBe(200);
    if (res.kind === "json") expect(res.body).toEqual(data);
  });

  it("passes the report name + tenant + query to the runner", async () => {
    let seen: { name: string; tenantId: string; query: unknown } | null = null;
    const r: ReportRunner = {
      run: async (name, args) => {
        seen = { name, tenantId: args.tenantId, query: args.query };
        return { ok: true };
      },
    };
    await out(buildReportHandler(r), input({ principal, report: "revenue", query: { from: "2026" } }));
    expect(seen).toEqual({ name: "revenue", tenantId: "t1", query: { from: "2026" } });
  });
});
