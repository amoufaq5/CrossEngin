import { describe, expect, it } from "vitest";

import {
  ActivityRegistry,
  createDefaultRegistry,
  echoTransformationHandler,
  noopAuditHandler,
  unsupportedHandler,
  type ActivityHandler,
  type ActivityInvocation,
} from "./activity-handlers.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function invocation(o: Partial<ActivityInvocation> = {}): ActivityInvocation {
  return {
    activityId: o.activityId ?? "wfa_act00001",
    instanceId: o.instanceId ?? "wfi_00000001",
    tenantId: o.tenantId ?? TENANT,
    definitionId: o.definitionId ?? "wfd_def00001",
    definitionActivityKey: o.definitionActivityKey ?? "do_thing",
    kind: o.kind ?? "transformation",
    attemptNumber: o.attemptNumber ?? 1,
    input: o.input ?? { foo: "bar" },
    variables: o.variables ?? {},
  };
}

describe("ActivityRegistry — resolution", () => {
  it("returns null when nothing is registered", () => {
    const r = new ActivityRegistry();
    expect(r.resolve({ kind: "http_call" })).toBeNull();
  });

  it("returns a kind-registered handler", () => {
    const r = new ActivityRegistry();
    const h: ActivityHandler = () => ({ status: "succeeded" });
    r.registerForKind("http_call", h);
    expect(r.resolve({ kind: "http_call" })).toBe(h);
  });

  it("returns a specific (definitionId + activityKey) handler ahead of kind", () => {
    const r = new ActivityRegistry();
    const generic: ActivityHandler = () => ({ status: "succeeded" });
    const specific: ActivityHandler = () => ({ status: "succeeded", output: { specific: true } });
    r.registerForKind("http_call", generic);
    r.registerForActivity("wfd_def00001", "post_invoice", specific);
    const resolved = r.resolve({
      kind: "http_call",
      definitionId: "wfd_def00001",
      activityKey: "post_invoice",
    });
    expect(resolved).toBe(specific);
  });

  it("falls back to kind when the specific handler is not registered", () => {
    const r = new ActivityRegistry();
    const generic: ActivityHandler = () => ({ status: "succeeded" });
    r.registerForKind("http_call", generic);
    const resolved = r.resolve({
      kind: "http_call",
      definitionId: "wfd_def00001",
      activityKey: "other_op",
    });
    expect(resolved).toBe(generic);
  });
});

describe("ActivityRegistry — size + has", () => {
  it("has() reflects resolution", () => {
    const r = new ActivityRegistry();
    expect(r.has({ kind: "http_call" })).toBe(false);
    r.registerForKind("http_call", () => ({ status: "succeeded" }));
    expect(r.has({ kind: "http_call" })).toBe(true);
  });

  it("size() counts specific + kind handlers", () => {
    const r = new ActivityRegistry();
    r.registerForKind("http_call", () => ({ status: "succeeded" }));
    r.registerForActivity("wfd_def00001", "k1", () => ({ status: "succeeded" }));
    r.registerForActivity("wfd_def00001", "k2", () => ({ status: "succeeded" }));
    expect(r.size()).toBe(3);
  });
});

describe("built-in handlers", () => {
  it("noopAuditHandler always succeeds", async () => {
    const result = await noopAuditHandler(invocation({ kind: "audit_emit" }));
    expect(result.status).toBe("succeeded");
  });

  it("echoTransformationHandler echoes input as output", async () => {
    const result = await echoTransformationHandler(invocation({ input: { x: 42 } }));
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.output).toEqual({ x: 42 });
    }
  });

  it("unsupportedHandler reports a typed failure", async () => {
    const result = await unsupportedHandler(invocation({ kind: "ai_call" }));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorCode).toBe("UNSUPPORTED_ACTIVITY");
      expect(result.retryable).toBe(false);
      expect(result.errorMessage).toContain("ai_call");
    }
  });
});

describe("createDefaultRegistry", () => {
  it("registers safe-by-default kinds (audit_emit + transformation)", () => {
    const r = createDefaultRegistry();
    expect(r.has({ kind: "audit_emit" })).toBe(true);
    expect(r.has({ kind: "transformation" })).toBe(true);
    expect(r.has({ kind: "http_call" })).toBe(false);
    expect(r.has({ kind: "ai_call" })).toBe(false);
  });

  it("returns instances that allow further registrations (chainable)", () => {
    const r = createDefaultRegistry().registerForKind("http_call", () => ({
      status: "succeeded",
    }));
    expect(r.has({ kind: "http_call" })).toBe(true);
  });
});
