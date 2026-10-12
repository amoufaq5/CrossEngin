import { describe, expect, it, vi } from "vitest";
import type { RouteDefinition, ResolvedPrincipal } from "@crossengin/api-gateway";
import { HandlerRegistry, type Handler, type HandlerInput } from "@crossengin/api-gateway-runtime";
import { TENANT_LIFECYCLE_STATES, type TenantLifecycleState } from "@crossengin/tenant-lifecycle";

import {
  CachedTenantStatusDirectory,
  DEFAULT_EXEMPT_OPERATION_PREFIXES,
  READ_BLOCKING_STATES,
  TENANT_GATE_DECISIONS,
  WRITE_BLOCKING_STATES,
  applyTenantStatusGate,
  surveyTenantStatusCoverage,
  tenantStatusDirectoryFromStore,
  withTenantStatus,
  type TenantGateDecision,
  type TenantStatusDirectory,
} from "./tenant-status-gate.js";
import type { TenantRecord } from "./platform-tenants.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

function route(method: RouteDefinition["method"]): RouteDefinition {
  return {
    id: "rt_abcdefgh",
    operationId: "invoice.list",
    method,
    pathSegments: [{ kind: "literal", value: "invoices" }],
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

function principal(tenantId: string | null): ResolvedPrincipal {
  return {
    principalId: "22222222-2222-4222-8222-222222222222",
    tenantId,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: ["erp_admin"],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-01-01T00:00:00.000Z",
  };
}

function input(
  method: RouteDefinition["method"],
  tenantId: string | null = TENANT,
): HandlerInput {
  return {
    request: {
      id: "req_1",
      method,
      path: "/v1/invoices",
      headers: {},
      query: {},
      receivedAt: "2026-01-01T00:00:00.000Z",
      tlsVersion: "1.3",
      clientIp: "203.0.113.1",
      bodyBytes: 0,
    } as unknown as HandlerInput["request"],
    route: { ...route(method) },
    principal: tenantId === null ? null : principal(tenantId),
    params: {},
    parsedBody: null,
  };
}

const ok: Handler = () => ({ kind: "json", status: 200, body: { ok: true } });

function directoryOf(status: TenantLifecycleState | null): TenantStatusDirectory {
  return { statusFor: async () => status };
}

describe("TENANT_GATE_DECISIONS", () => {
  it("names the seven outcomes", () => {
    expect(TENANT_GATE_DECISIONS).toEqual([
      "allowed",
      "no_tenant",
      "exempt",
      "writes_blocked",
      "reads_blocked",
      "tenant_unknown",
      "status_unavailable",
    ]);
  });

  it("is a closed set of string literals", () => {
    const d: TenantGateDecision = "writes_blocked";
    expect(TENANT_GATE_DECISIONS).toContain(d);
  });
});

describe("blocking-state derivations", () => {
  it("blocks writes in every state but active", () => {
    expect(WRITE_BLOCKING_STATES).toEqual([
      "suspended",
      "archived",
      "pending_deletion",
      "deleted",
    ]);
  });

  it("blocks reads only in deleted", () => {
    expect(READ_BLOCKING_STATES).toEqual(["deleted"]);
  });

  it("derives from the contract enum, so every state is classified", () => {
    for (const s of TENANT_LIFECYCLE_STATES) {
      const write = WRITE_BLOCKING_STATES.includes(s);
      const read = READ_BLOCKING_STATES.includes(s);
      // Reads blocked implies writes blocked — a state that forbids reading cannot permit writing.
      if (read) expect(write).toBe(true);
    }
  });
});

describe("withTenantStatus", () => {
  it("passes an active tenant's write through", async () => {
    const gated = withTenantStatus(ok, "invoice.create", {
      directory: directoryOf("active"),
    });
    const out = await gated(input("POST"));
    expect(out.status).toBe(200);
  });

  it("refuses a write for a suspended tenant with a 403 problem", async () => {
    const gated = withTenantStatus(ok, "invoice.create", {
      directory: directoryOf("suspended"),
    });
    const out = await gated(input("POST"));
    expect(out.status).toBe(403);
    expect(out.kind).toBe("json");
    if (out.kind !== "json") throw new Error("expected json");
    const body = out.body as Record<string, unknown>;
    expect(body["reason"]).toBe("tenant_writes_blocked");
    expect(body["tenantStatus"]).toBe("suspended");
    expect(out.headers?.["content-type"]).toBe("application/problem+json");
  });

  it("allows a read for a suspended tenant", async () => {
    const gated = withTenantStatus(ok, "invoice.list", {
      directory: directoryOf("suspended"),
    });
    expect((await gated(input("GET"))).status).toBe(200);
  });

  it("allows a read for an archived tenant and refuses its writes", async () => {
    const gated = withTenantStatus(ok, "invoice.list", {
      directory: directoryOf("archived"),
    });
    expect((await gated(input("GET"))).status).toBe(200);
    expect((await gated(input("PATCH"))).status).toBe(403);
  });

  it("refuses a pending_deletion write — the state this gate exists for", async () => {
    const gated = withTenantStatus(ok, "invoice.create", {
      directory: directoryOf("pending_deletion"),
    });
    const out = await gated(input("POST"));
    expect(out.status).toBe(403);
    if (out.kind !== "json") throw new Error("expected json");
    expect((out.body as Record<string, unknown>)["detail"]).toContain("read-only");
  });

  it("allows a pending_deletion read, so a tenant can export before erasure", async () => {
    const gated = withTenantStatus(ok, "invoice.list", {
      directory: directoryOf("pending_deletion"),
    });
    expect((await gated(input("GET"))).status).toBe(200);
  });

  it("refuses both directions for a deleted tenant", async () => {
    const gated = withTenantStatus(ok, "invoice.list", {
      directory: directoryOf("deleted"),
    });
    for (const m of ["GET", "HEAD", "POST", "DELETE"] as const) {
      const out = await gated(input(m));
      expect(out.status).toBe(403);
    }
  });

  it("treats every unsafe method as a write", async () => {
    const gated = withTenantStatus(ok, "invoice.x", { directory: directoryOf("suspended") });
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "CONNECT"] as const) {
      expect((await gated(input(m))).status).toBe(403);
    }
    for (const m of ["GET", "HEAD", "OPTIONS", "TRACE"] as const) {
      expect((await gated(input(m))).status).toBe(200);
    }
  });

  it("passes an unauthenticated request through — auth owns that case", async () => {
    const dir = { statusFor: vi.fn() };
    const gated = withTenantStatus(ok, "invoice.list", { directory: dir });
    expect((await gated(input("POST", null))).status).toBe(200);
    expect(dir.statusFor).not.toHaveBeenCalled();
  });

  it("refuses a tenant with no row as not provisioned", async () => {
    const gated = withTenantStatus(ok, "invoice.list", { directory: directoryOf(null) });
    const out = await gated(input("GET"));
    expect(out.status).toBe(403);
    if (out.kind !== "json") throw new Error("expected json");
    const body = out.body as Record<string, unknown>;
    expect(body["reason"]).toBe("tenant_not_provisioned");
    expect(body["tenantStatus"]).toBeNull();
  });

  it("answers 503 and not 403 when the state cannot be established", async () => {
    const gated = withTenantStatus(ok, "invoice.list", {
      directory: {
        statusFor: async () => {
          throw new Error("connection terminated");
        },
      },
    });
    const out = await gated(input("GET"));
    expect(out.status).toBe(503);
    if (out.kind !== "json") throw new Error("expected json");
    expect((out.body as Record<string, unknown>)["reason"]).toBe("tenant_status_unavailable");
    expect(out.headers?.["retry-after"]).toBe("5");
  });

  it("never runs the handler when it refuses", async () => {
    const handler = vi.fn(ok);
    const gated = withTenantStatus(handler, "invoice.create", {
      directory: directoryOf("deleted"),
    });
    await gated(input("POST"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns the handler unwrapped for an exempt prefix", async () => {
    const dir = { statusFor: vi.fn() };
    const gated = withTenantStatus(ok, "platform.tenants.reactivate", { directory: dir });
    expect(gated).toBe(ok);
    expect((await gated(input("POST"))).status).toBe(200);
    expect(dir.statusFor).not.toHaveBeenCalled();
  });

  it("exempts platform. by default and nothing else", () => {
    expect(DEFAULT_EXEMPT_OPERATION_PREFIXES).toEqual(["platform."]);
    for (const id of ["invoice.list", "meta.schema.read", "admin.settings.update"]) {
      expect(DEFAULT_EXEMPT_OPERATION_PREFIXES.some((p) => id.startsWith(p))).toBe(false);
    }
  });

  it("honours a caller's exempt prefixes instead of the default", async () => {
    const gated = withTenantStatus(ok, "meta.schema.read", {
      directory: directoryOf("deleted"),
      exemptOperationPrefixes: ["meta.schema."],
    });
    expect(gated).toBe(ok);
  });

  it("reports each refusal through events with the operation and tenant", async () => {
    const seen: { decision: string; operationId: string; tenantId: string }[] = [];
    const events = {
      onRefused: (i: { decision: TenantGateDecision; operationId: string; tenantId: string }) => {
        seen.push({ decision: i.decision, operationId: i.operationId, tenantId: i.tenantId });
      },
    };
    await withTenantStatus(ok, "a.b", { directory: directoryOf("suspended"), events })(
      input("POST"),
    );
    await withTenantStatus(ok, "c.d", { directory: directoryOf("deleted"), events })(input("GET"));
    await withTenantStatus(ok, "e.f", { directory: directoryOf(null), events })(input("GET"));
    expect(seen).toEqual([
      { decision: "writes_blocked", operationId: "a.b", tenantId: TENANT },
      { decision: "reads_blocked", operationId: "c.d", tenantId: TENANT },
      { decision: "tenant_unknown", operationId: "e.f", tenantId: TENANT },
    ]);
  });
});

describe("applyTenantStatusGate", () => {
  it("wraps every non-exempt handler and leaves the exempt ones identical", async () => {
    const registry = new HandlerRegistry();
    registry.register("invoice.list", ok);
    registry.register("invoice.create", ok);
    registry.register("platform.tenants.list", ok);
    const wrapped = applyTenantStatusGate(registry, { directory: directoryOf("suspended") });
    expect(wrapped).toBe(2);
    expect(registry.resolve("platform.tenants.list")).toBe(ok);
    expect(registry.resolve("invoice.create")).not.toBe(ok);
    const gatedCreate = registry.resolve("invoice.create");
    if (gatedCreate === null) throw new Error("missing handler");
    expect((await gatedCreate(input("POST"))).status).toBe(403);
  });

  it("covers the whole registry, so a route added before it cannot be missed", () => {
    const registry = new HandlerRegistry();
    for (let i = 0; i < 25; i += 1) registry.register(`e${i.toString()}.list`, ok);
    expect(applyTenantStatusGate(registry, { directory: directoryOf("active") })).toBe(25);
    expect(registry.size()).toBe(25);
    for (const id of registry.operationIds()) expect(registry.resolve(id)).not.toBe(ok);
  });

  it("keeps the registry's operation ids unchanged", () => {
    const registry = new HandlerRegistry();
    registry.register("b.list", ok);
    registry.register("a.list", ok);
    applyTenantStatusGate(registry, { directory: directoryOf("active") });
    expect(registry.operationIds()).toEqual(["b.list", "a.list"]);
  });
});

describe("CachedTenantStatusDirectory", () => {
  function clockAt(start: number): { now: () => Date; advance: (ms: number) => void } {
    let t = start;
    return { now: () => new Date(t), advance: (ms) => (t += ms) };
  }

  it("reads once inside the TTL", async () => {
    const statusFor = vi.fn(async () => "active" as TenantLifecycleState);
    const clock = clockAt(0);
    const dir = new CachedTenantStatusDirectory({ statusFor }, { ttlMs: 1000, now: clock.now });
    expect(await dir.statusFor(TENANT)).toBe("active");
    expect(await dir.statusFor(TENANT)).toBe("active");
    clock.advance(999);
    expect(await dir.statusFor(TENANT)).toBe("active");
    expect(statusFor).toHaveBeenCalledTimes(1);
  });

  it("re-reads once the TTL lapses", async () => {
    let value: TenantLifecycleState = "active";
    const statusFor = vi.fn(async () => value);
    const clock = clockAt(0);
    const dir = new CachedTenantStatusDirectory({ statusFor }, { ttlMs: 1000, now: clock.now });
    expect(await dir.statusFor(TENANT)).toBe("active");
    value = "pending_deletion";
    clock.advance(1000);
    expect(await dir.statusFor(TENANT)).toBe("pending_deletion");
    expect(statusFor).toHaveBeenCalledTimes(2);
  });

  it("holds an absence for the shorter absence TTL", async () => {
    const statusFor = vi.fn(async () => null);
    const clock = clockAt(0);
    const dir = new CachedTenantStatusDirectory(
      { statusFor },
      { ttlMs: 60_000, absenceTtlMs: 1000, now: clock.now },
    );
    expect(await dir.statusFor(TENANT)).toBeNull();
    clock.advance(1001);
    expect(await dir.statusFor(TENANT)).toBeNull();
    expect(statusFor).toHaveBeenCalledTimes(2);
  });

  it("propagates a first lookup failure — it has never known this tenant", async () => {
    const dir = new CachedTenantStatusDirectory({
      statusFor: async () => {
        throw new Error("down");
      },
    });
    await expect(dir.statusFor(TENANT)).rejects.toThrow("down");
  });

  it("serves the last known answer when a refresh fails", async () => {
    let fail = false;
    const statusFor = vi.fn(async () => {
      if (fail) throw new Error("down");
      return "suspended" as TenantLifecycleState;
    });
    const clock = clockAt(0);
    const errors: boolean[] = [];
    const dir = new CachedTenantStatusDirectory(
      { statusFor },
      {
        ttlMs: 1000,
        maxStaleMs: 10_000,
        now: clock.now,
        onRefreshError: (_t, _e, servedStale) => errors.push(servedStale),
      },
    );
    expect(await dir.statusFor(TENANT)).toBe("suspended");
    fail = true;
    clock.advance(2000);
    expect(await dir.statusFor(TENANT)).toBe("suspended");
    expect(errors).toEqual([true]);
  });

  it("stops serving a stale answer past maxStaleMs", async () => {
    let fail = false;
    const statusFor = async (): Promise<TenantLifecycleState> => {
      if (fail) throw new Error("down");
      return "active";
    };
    const clock = clockAt(0);
    const errors: boolean[] = [];
    const dir = new CachedTenantStatusDirectory(
      { statusFor },
      {
        ttlMs: 1000,
        maxStaleMs: 5000,
        now: clock.now,
        onRefreshError: (_t, _e, servedStale) => errors.push(servedStale),
      },
    );
    await dir.statusFor(TENANT);
    fail = true;
    clock.advance(5001);
    await expect(dir.statusFor(TENANT)).rejects.toThrow("down");
    expect(errors).toEqual([false]);
  });

  it("collapses concurrent cold lookups for one tenant into a single read", async () => {
    let calls = 0;
    const dir = new CachedTenantStatusDirectory({
      statusFor: async () => {
        calls += 1;
        await Promise.resolve();
        return "active";
      },
    });
    const all = await Promise.all([
      dir.statusFor(TENANT),
      dir.statusFor(TENANT),
      dir.statusFor(TENANT),
    ]);
    expect(all).toEqual(["active", "active", "active"]);
    expect(calls).toBe(1);
  });

  it("keys per tenant", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const dir = new CachedTenantStatusDirectory({
      statusFor: async (t) => (t === TENANT ? "active" : "deleted"),
    });
    expect(await dir.statusFor(TENANT)).toBe("active");
    expect(await dir.statusFor(other)).toBe("deleted");
  });

  it("clear() forces a re-read", async () => {
    const statusFor = vi.fn(async () => "active" as TenantLifecycleState);
    const dir = new CachedTenantStatusDirectory({ statusFor }, { ttlMs: 60_000 });
    await dir.statusFor(TENANT);
    dir.clear();
    await dir.statusFor(TENANT);
    expect(statusFor).toHaveBeenCalledTimes(2);
  });
});

describe("tenantStatusDirectoryFromStore", () => {
  function record(status: string): TenantRecord {
    return {
      id: TENANT,
      slug: "acme",
      name: "Acme",
      status: status as TenantRecord["status"],
      tier: "small",
      region: "eu",
      schemaName: "t_acme",
      searchLocale: "english",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("maps a row to its lifecycle state", async () => {
    const dir = tenantStatusDirectoryFromStore({
      getById: async () => record("pending_deletion"),
    });
    expect(await dir.statusFor(TENANT)).toBe("pending_deletion");
  });

  it("answers null for a missing row", async () => {
    const dir = tenantStatusDirectoryFromStore({ getById: async () => null });
    expect(await dir.statusFor(TENANT)).toBeNull();
  });

  it("throws rather than gating against a status the contract forbids", async () => {
    const dir = tenantStatusDirectoryFromStore({ getById: async () => record("past_due") });
    await expect(dir.statusFor(TENANT)).rejects.toThrow();
  });
});

describe("surveyTenantStatusCoverage", () => {
  it("separates missing, unreachable and write-blocked tenants", async () => {
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const d = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const dir: TenantStatusDirectory = {
      statusFor: async (t) => {
        if (t === a) return "active";
        if (t === b) return null;
        if (t === c) return "suspended";
        throw new Error("unreachable");
      },
    };
    const survey = await surveyTenantStatusCoverage(dir, [d, c, b, a]);
    expect(survey.checked).toEqual([a, b, c, d]);
    expect(survey.missing).toEqual([b]);
    expect(survey.blocked).toEqual([{ tenantId: c, status: "suspended" }]);
    expect(survey.unreachable).toEqual([d]);
  });

  it("deduplicates the ids it was given", async () => {
    const survey = await surveyTenantStatusCoverage(directoryOf("active"), [
      TENANT,
      TENANT,
      TENANT,
    ]);
    expect(survey.checked).toEqual([TENANT]);
  });

  it("reports nothing for an empty credential set", async () => {
    const survey = await surveyTenantStatusCoverage(directoryOf(null), []);
    expect(survey).toEqual({ checked: [], missing: [], unreachable: [], blocked: [] });
  });

  it("does not call an absence unreachable", async () => {
    const survey = await surveyTenantStatusCoverage(directoryOf(null), [TENANT]);
    expect(survey.missing).toEqual([TENANT]);
    expect(survey.unreachable).toEqual([]);
  });
});
