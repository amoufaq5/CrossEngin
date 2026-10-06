import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { CONTENT_CATEGORIES, NOTIFICATION_CHANNELS, type UserPreferenceMatrix } from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import { PreferenceRowUnreadableError } from "./preference-store.js";
import {
  ASSERTABLE_PREFERENCE_SOURCES,
  DEFAULT_PREFERENCE_SOURCE,
  PREFERENCE_ADMIN_OPERATION,
  PREFERENCE_CLEARED_OPERATION,
  PREFERENCE_DENIED_OPERATION,
  PREFERENCE_SET_OPERATION,
  PRIVILEGED_PREFERENCE_SOURCES,
  SUBJECT_BODY_KEYS,
  bodyNamesASubject,
  buildPreferenceRoutes,
  decideExpectation,
  decideKey,
  decideSource,
  matrixResponse,
  optedOutOfNonSuppressible,
  resolveSubject,
  type PreferenceAuditEvent,
  type PreferenceRoutesContext,
} from "./preference-routes.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "44444444-4444-4444-4444-444444444444";
const OTHER_USER = "55555555-5555-5555-5555-555555555555";
const NOW = new Date("2026-06-01T12:00:00.000Z");

function principal(over: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    principalId: USER,
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function matrix(entries: UserPreferenceMatrix["entries"] = []): UserPreferenceMatrix {
  return { userId: USER, tenantId: TENANT, updatedAt: "2026-05-01T00:00:00.000Z", entries };
}

interface Recorder {
  readonly store: PreferenceRoutesContext["store"];
  readonly puts: Array<Record<string, unknown>>;
  readonly clears: Array<Record<string, unknown>>;
}

function recordingStore(
  over: {
    readonly matrix?: UserPreferenceMatrix;
    readonly outcome?: "inserted" | "updated" | "reaffirmed" | "conflict";
    readonly putThrows?: unknown;
    readonly matrixThrows?: unknown;
    readonly clearThrows?: boolean;
    readonly cleared?: boolean;
  } = {},
): Recorder {
  const puts: Array<Record<string, unknown>> = [];
  const clears: Array<Record<string, unknown>> = [];
  return {
    puts,
    clears,
    store: {
      put: async (subject, write) => {
        puts.push({ ...subject, ...write });
        if (over.putThrows !== undefined) throw over.putThrows;
        return {
          outcome: over.outcome ?? "inserted",
          entry: {
            category: write.category,
            channel: write.channel,
            optedIn: write.optedIn,
            updatedAt: write.at,
            source: write.source,
          },
        };
      },
      clear: async (subject, key) => {
        clears.push({ ...subject, ...key });
        if (over.clearThrows === true) throw new Error("boom");
        return over.cleared ?? true;
      },
      matrixFor: async () => {
        if (over.matrixThrows !== undefined) throw over.matrixThrows;
        return over.matrix ?? matrix();
      },
    },
  };
}

function ctxFor(over: Partial<PreferenceRoutesContext> = {}): PreferenceRoutesContext {
  return {
    store: recordingStore().store,
    principalRoles: (p) => ({
      primaryRole: p === null ? "anonymous" : "erp_user",
      secondaryRoles: [],
    }),
    allowedRoles: new Set(["erp_user"]),
    clock: () => NOW,
    ...over,
  };
}

function auditing(over: { readonly throws?: boolean } = {}): {
  readonly audit: PreferenceRoutesContext["audit"];
  readonly events: PreferenceAuditEvent[];
} {
  const events: PreferenceAuditEvent[] = [];
  return {
    events,
    audit: async (event) => {
      events.push(event);
      if (over.throws === true) throw new Error("audit down");
    },
  };
}

function handlerFor(ctx: PreferenceRoutesContext, operationId: string): Handler {
  const found = buildPreferenceRoutes(ctx).find((r) => r.route.operationId === operationId);
  if (found === undefined) throw new Error(`no route ${operationId}`);
  return found.handler;
}

function inputFor(over: Partial<HandlerInput> = {}): HandlerInput {
  return {
    request: {} as HandlerInput["request"],
    route: {} as HandlerInput["route"],
    principal: principal(),
    params: { category: "marketing", channel: "email" },
    parsedBody: null,
    ...over,
  };
}

function body(out: HandlerOutput): Record<string, unknown> {
  return (out as { body: Record<string, unknown> }).body;
}

function status(out: HandlerOutput): number {
  return (out as { status: number }).status;
}

describe("preference-routes — constants and route shape", () => {
  it("mounts three routes with no admin grant", () => {
    const routes = buildPreferenceRoutes(ctxFor());
    expect(routes.map((r) => r.route.operationId)).toEqual([
      "notifications.preferences.read",
      "notifications.preferences.set",
      "notifications.preferences.clear",
    ]);
  });

  it("mounts the on-behalf route only when the admin grant is configured", () => {
    const routes = buildPreferenceRoutes(
      ctxFor({ adminRoles: new Set(["platform_admin"]), audit: auditing().audit }),
    );
    expect(routes.map((r) => r.route.operationId)).toContain(
      "notifications.preferences.set_on_behalf",
    );
  });

  it("refuses to construct an admin grant with no auditor", () => {
    expect(() => buildPreferenceRoutes(ctxFor({ adminRoles: new Set(["platform_admin"]) }))).toThrow(
      /must be recordable/,
    );
  });

  it("requires no idempotency key, because the natural key makes a retry a restatement", () => {
    for (const r of buildPreferenceRoutes(ctxFor())) {
      expect(r.route.idempotencyRequired).toBe(false);
    }
  });

  it("permits only user_set and admin_set over HTTP", () => {
    expect([...ASSERTABLE_PREFERENCE_SOURCES]).toEqual(["user_set", "admin_set"]);
    expect([...PRIVILEGED_PREFERENCE_SOURCES]).toEqual(["admin_set"]);
  });
});

describe("preference-routes — resolveSubject", () => {
  it("takes the subject from the credential", () => {
    const resolved = resolveSubject(ctxFor(), principal());
    expect(resolved.ok).toBe(true);
    expect(resolved.subject).toEqual({ tenantId: TENANT, userId: USER });
  });

  it("401s with no principal", () => {
    expect(status(resolveSubject(ctxFor(), null).denial!)).toBe(401);
  });

  it("403s a role outside the grant", () => {
    const ctx = ctxFor({ allowedRoles: new Set(["someone_else"]) });
    expect(status(resolveSubject(ctx, principal()).denial!)).toBe(403);
  });

  it("403s when the grant is empty, failing closed rather than open", () => {
    const ctx = ctxFor({ allowedRoles: new Set() });
    expect(status(resolveSubject(ctx, principal()).denial!)).toBe(403);
  });

  it("403s a principal with no resolvable tenant", () => {
    const resolved = resolveSubject(ctxFor(), principal({ tenantId: null }));
    expect(status(resolved.denial!)).toBe(403);
    expect(body(resolved.denial!)["detail"]).toMatch(/no tenant resolves/);
  });

  it("403s a service account, because user_id is a NOT NULL FK into meta.users", () => {
    const resolved = resolveSubject(
      ctxFor(),
      principal({ principalKind: "service_account" }),
    );
    expect(status(resolved.denial!)).toBe(403);
    expect(body(resolved.denial!)["detail"]).toMatch(/a preference is per user/);
  });

  it("403s a principalId that is not a uuid", () => {
    expect(status(resolveSubject(ctxFor(), principal({ principalId: "nope" })).denial!)).toBe(403);
  });
});

describe("preference-routes — decideKey", () => {
  it("accepts every category and channel the contract declares", () => {
    for (const category of CONTENT_CATEGORIES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        expect(decideKey(category, channel).kind).toBe("ok");
      }
    }
  });

  it("refuses an unknown category, listing the real ones", () => {
    const decision = decideKey("gossip", "email");
    expect(decision.kind).toBe("invalid");
    expect(decision.kind === "invalid" && decision.detail).toContain("marketing");
  });

  it("refuses an unknown channel", () => {
    expect(decideKey("marketing", "carrier_pigeon").kind).toBe("invalid");
  });

  it("refuses a non-string segment", () => {
    expect(decideKey(undefined, "email").kind).toBe("invalid");
  });
});

describe("preference-routes — decideSource", () => {
  it("defaults by surface and not by grant, so an admin's own click is still user_set", () => {
    expect(decideSource(undefined, false, "self")).toEqual({ kind: "ok", source: "user_set" });
    expect(decideSource(undefined, true, "self")).toEqual({ kind: "ok", source: "user_set" });
  });

  it("defaults the on-behalf surface to admin_set", () => {
    expect(decideSource(undefined, true, "on_behalf")).toEqual({ kind: "ok", source: "admin_set" });
  });

  it("names a default for every surface, totally", () => {
    for (const surface of ["self", "on_behalf"] as const) {
      expect(DEFAULT_PREFERENCE_SOURCE[surface]).toBeDefined();
    }
  });

  it("accepts user_set explicitly on the self surface", () => {
    expect(decideSource("user_set", false, "self")).toEqual({ kind: "ok", source: "user_set" });
  });

  it("refuses user_set on the on-behalf surface — an admin may not launder a change as consent", () => {
    const decision = decideSource("user_set", true, "on_behalf");
    expect(decision.kind).toBe("invalid");
    expect(decision.kind === "invalid" && decision.detail).toMatch(/acting on another user/);
  });

  it("403s admin_set for a caller without the grant", () => {
    expect(decideSource("admin_set", false, "self").kind).toBe("ungranted");
  });

  it("accepts admin_set for a caller with it", () => {
    expect(decideSource("admin_set", true, "self")).toEqual({ kind: "ok", source: "admin_set" });
  });

  it("refuses regulatory_requirement outright — the source that could switch off a security alert", () => {
    const decision = decideSource("regulatory_requirement", true, "self");
    expect(decision.kind).toBe("invalid");
  });

  it("refuses default_policy, which is the absence of a row rather than a row", () => {
    expect(decideSource("default_policy", true, "self").kind).toBe("invalid");
  });

  it("refuses import", () => {
    expect(decideSource("import", true, "self").kind).toBe("invalid");
  });

  it("refuses a non-string source", () => {
    expect(decideSource(7, true, "self").kind).toBe("invalid");
  });
});

describe("preference-routes — decideExpectation", () => {
  it("requires an expectation for an opt-in", () => {
    const decision = decideExpectation(undefined, true);
    expect(decision.kind).toBe("invalid");
    expect(decision.kind === "invalid" && decision.detail).toMatch(/expect is required/);
  });

  it("does not require one for an opt-out", () => {
    expect(decideExpectation(undefined, false)).toEqual({ kind: "ok" });
  });

  it("accepts each of the three expectations", () => {
    for (const expect_ of ["absent", "opted_in", "opted_out"] as const) {
      expect(decideExpectation(expect_, true)).toEqual({ kind: "ok", expect: expect_ });
    }
  });

  it("refuses an expectation it does not recognise", () => {
    expect(decideExpectation("maybe", true).kind).toBe("invalid");
  });
});

describe("preference-routes — the refusal the contract does not make", () => {
  for (const category of ["transactional", "security_alert"] as const) {
    it(`treats an opt-out of ${category} as a violation whatever the source`, () => {
      expect(optedOutOfNonSuppressible(category, false)).toBe(true);
      expect(optedOutOfNonSuppressible(category, true)).toBe(false);
    });
  }

  for (const category of ["system_notice", "operational_digest", "marketing"] as const) {
    it(`permits an opt-out of ${category}`, () => {
      expect(optedOutOfNonSuppressible(category, false)).toBe(false);
    });
  }

  it("400s a security_alert opt-out at the route, where the contract would have stored it", async () => {
    const recorder = recordingStore();
    const handler = handlerFor(ctxFor({ store: recorder.store }), "notifications.preferences.set");
    const out = await handler(
      inputFor({
        params: { category: "security_alert", channel: "email" },
        parsedBody: { optedIn: false },
      }),
    );
    expect(status(out)).toBe(400);
    expect(body(out)["detail"]).toMatch(/not suppressible/);
    expect(recorder.puts).toHaveLength(0);
  });

  it("400s it under admin_set too, which is the source the contract lets through", async () => {
    const audit = auditing();
    const recorder = recordingStore();
    const handler = handlerFor(
      ctxFor({
        store: recorder.store,
        adminRoles: new Set(["erp_user"]),
        audit: audit.audit,
      }),
      "notifications.preferences.set",
    );
    const out = await handler(
      inputFor({
        params: { category: "transactional", channel: "sms" },
        parsedBody: { optedIn: false, source: "admin_set" },
      }),
    );
    expect(status(out)).toBe(400);
    expect(recorder.puts).toHaveLength(0);
  });
});

describe("preference-routes — set", () => {
  it("writes the subject from the credential and the actor as updatedBy", async () => {
    const recorder = recordingStore();
    const handler = handlerFor(ctxFor({ store: recorder.store }), "notifications.preferences.set");
    const out = await handler(inputFor({ parsedBody: { optedIn: false } }));
    expect(status(out)).toBe(200);
    expect(recorder.puts[0]).toMatchObject({
      tenantId: TENANT,
      userId: USER,
      category: "marketing",
      channel: "email",
      optedIn: false,
      source: "user_set",
      updatedBy: USER,
    });
  });

  it("records an administrator's OWN preference as user_set, not admin_set", async () => {
    const recorder = recordingStore();
    const handler = handlerFor(
      ctxFor({
        store: recorder.store,
        principalRoles: () => ({ primaryRole: "platform_admin", secondaryRoles: ["erp_user"] }),
        adminRoles: new Set(["platform_admin"]),
        audit: auditing().audit,
      }),
      "notifications.preferences.set",
    );
    await handler(inputFor({ parsedBody: { optedIn: false } }));
    expect(recorder.puts[0]?.["source"]).toBe("user_set");
  });

  it("refuses a body that names a subject rather than ignoring it", async () => {
    for (const key of SUBJECT_BODY_KEYS) {
      const recorder = recordingStore();
      const handler = handlerFor(
        ctxFor({ store: recorder.store }),
        "notifications.preferences.set",
      );
      const out = await handler(
        inputFor({ parsedBody: { optedIn: false, [key]: OTHER_USER } }),
      );
      expect(status(out)).toBe(400);
      expect(body(out)["detail"]).toContain(key);
      expect(recorder.puts).toHaveLength(0);
    }
  });

  it("detects a named subject key", () => {
    expect(bodyNamesASubject({ userId: OTHER_USER })).toBe("userId");
    expect(bodyNamesASubject({ optedIn: true })).toBeNull();
    expect(bodyNamesASubject(null)).toBeNull();
  });

  it("400s a missing optedIn rather than defaulting it", async () => {
    const handler = handlerFor(ctxFor(), "notifications.preferences.set");
    const out = await handler(inputFor({ parsedBody: {} }));
    expect(status(out)).toBe(400);
    expect(body(out)["detail"]).toMatch(/optedIn is required/);
  });

  it("400s a non-boolean optedIn", async () => {
    const handler = handlerFor(ctxFor(), "notifications.preferences.set");
    expect(status(await handler(inputFor({ parsedBody: { optedIn: "yes" } })))).toBe(400);
  });

  it("400s an opt-in with no expectation", async () => {
    const recorder = recordingStore();
    const handler = handlerFor(ctxFor({ store: recorder.store }), "notifications.preferences.set");
    const out = await handler(inputFor({ parsedBody: { optedIn: true } }));
    expect(status(out)).toBe(400);
    expect(recorder.puts).toHaveLength(0);
  });

  it("passes an opt-in's expectation through to the store", async () => {
    const recorder = recordingStore();
    const handler = handlerFor(ctxFor({ store: recorder.store }), "notifications.preferences.set");
    await handler(inputFor({ parsedBody: { optedIn: true, expect: "opted_out" } }));
    expect(recorder.puts[0]?.["expect"]).toBe("opted_out");
  });

  it("omits expect entirely for an opt-out", async () => {
    const recorder = recordingStore();
    const handler = handlerFor(ctxFor({ store: recorder.store }), "notifications.preferences.set");
    await handler(inputFor({ parsedBody: { optedIn: false } }));
    expect(recorder.puts[0]).not.toHaveProperty("expect");
  });

  it("409s a conflict and hands back the stored entry", async () => {
    const recorder = recordingStore({ outcome: "conflict" });
    const handler = handlerFor(ctxFor({ store: recorder.store }), "notifications.preferences.set");
    const out = await handler(
      inputFor({ parsedBody: { optedIn: true, expect: "opted_out" } }),
    );
    expect(status(out)).toBe(409);
    expect(body(out)["outcome"]).toBe("conflict");
    expect(body(out)["entry"]).toBeDefined();
  });

  it("503s when the store is unavailable", async () => {
    const recorder = recordingStore({ putThrows: new Error("down") });
    const handler = handlerFor(ctxFor({ store: recorder.store }), "notifications.preferences.set");
    const out = await handler(inputFor({ parsedBody: { optedIn: false } }));
    expect(status(out)).toBe(503);
    expect(body(out)["error"]).toBe("preferences_unavailable");
  });

  it("503s with its own error when a stored row is unreadable, naming the defect", async () => {
    const recorder = recordingStore({
      putThrows: new PreferenceRowUnreadableError("entry_unparseable", "marketing", "bad source"),
    });
    const handler = handlerFor(ctxFor({ store: recorder.store }), "notifications.preferences.set");
    const out = await handler(inputFor({ parsedBody: { optedIn: false } }));
    expect(status(out)).toBe(503);
    expect(body(out)["error"]).toBe("preferences_unreadable");
    expect(body(out)["category"]).toBe("marketing");
  });

  it("records the self-service write after it lands", async () => {
    const audit = auditing();
    const handler = handlerFor(
      ctxFor({ audit: audit.audit }),
      "notifications.preferences.set",
    );
    await handler(inputFor({ parsedBody: { optedIn: false } }));
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      outcome: PREFERENCE_SET_OPERATION,
      onBehalf: false,
      granted: true,
      subjectUserId: USER,
      optedIn: false,
    });
  });

  it("still serves the write when the audit is down — a withdrawal must not be refused", async () => {
    const audit = auditing({ throws: true });
    const recorder = recordingStore();
    const handler = handlerFor(
      ctxFor({ store: recorder.store, audit: audit.audit }),
      "notifications.preferences.set",
    );
    const out = await handler(inputFor({ parsedBody: { optedIn: false } }));
    expect(status(out)).toBe(200);
    expect(recorder.puts).toHaveLength(1);
  });

  it("records a refused escalation and never 503s for it", async () => {
    const audit = auditing({ throws: true });
    const recorder = recordingStore();
    const handler = handlerFor(
      ctxFor({ store: recorder.store, audit: audit.audit }),
      "notifications.preferences.set",
    );
    const out = await handler(
      inputFor({ parsedBody: { optedIn: false, source: "admin_set" } }),
    );
    expect(status(out)).toBe(403);
    expect(audit.events[0]).toMatchObject({
      outcome: PREFERENCE_DENIED_OPERATION,
      granted: false,
      source: null,
    });
    expect(recorder.puts).toHaveLength(0);
  });
});

describe("preference-routes — set on behalf of another user", () => {
  function adminCtx(over: Partial<PreferenceRoutesContext> = {}): PreferenceRoutesContext {
    return ctxFor({
      principalRoles: () => ({ primaryRole: "platform_admin", secondaryRoles: ["erp_user"] }),
      allowedRoles: new Set(["erp_user"]),
      adminRoles: new Set(["platform_admin"]),
      audit: auditing().audit,
      ...over,
    });
  }

  it("writes against the named user, in the caller's tenant", async () => {
    const recorder = recordingStore();
    const audit = auditing();
    const handler = handlerFor(
      adminCtx({ store: recorder.store, audit: audit.audit }),
      "notifications.preferences.set_on_behalf",
    );
    const out = await handler(
      inputFor({
        params: { userId: OTHER_USER, category: "marketing", channel: "email" },
        parsedBody: { optedIn: false },
      }),
    );
    expect(status(out)).toBe(200);
    expect(recorder.puts[0]).toMatchObject({
      tenantId: TENANT,
      userId: OTHER_USER,
      // The caller, not the subject: the column says who changed it.
      updatedBy: USER,
      source: "admin_set",
    });
  });

  it("records BEFORE the write and refuses when it cannot record", async () => {
    const recorder = recordingStore();
    const handler = handlerFor(
      adminCtx({ store: recorder.store, audit: auditing({ throws: true }).audit }),
      "notifications.preferences.set_on_behalf",
    );
    const out = await handler(
      inputFor({
        params: { userId: OTHER_USER, category: "marketing", channel: "email" },
        parsedBody: { optedIn: false },
      }),
    );
    expect(status(out)).toBe(503);
    expect(body(out)["error"]).toBe("audit_unavailable");
    // The load-bearing assertion: nothing was written.
    expect(recorder.puts).toHaveLength(0);
  });

  it("names the on-behalf operation and the real subject in the audit event", async () => {
    const audit = auditing();
    const handler = handlerFor(
      adminCtx({ audit: audit.audit }),
      "notifications.preferences.set_on_behalf",
    );
    await handler(
      inputFor({
        params: { userId: OTHER_USER, category: "marketing", channel: "email" },
        parsedBody: { optedIn: false },
      }),
    );
    expect(audit.events[0]).toMatchObject({
      outcome: PREFERENCE_ADMIN_OPERATION,
      onBehalf: true,
      subjectUserId: OTHER_USER,
      principalId: USER,
    });
  });

  it("400s a userId that is not a uuid", async () => {
    const handler = handlerFor(adminCtx(), "notifications.preferences.set_on_behalf");
    const out = await handler(
      inputFor({
        params: { userId: "nope", category: "marketing", channel: "email" },
        parsedBody: { optedIn: false },
      }),
    );
    expect(status(out)).toBe(400);
  });

  it("403s a caller holding only the self grant", async () => {
    const recorder = recordingStore();
    const handler = handlerFor(
      adminCtx({
        store: recorder.store,
        principalRoles: () => ({ primaryRole: "erp_user", secondaryRoles: [] }),
      }),
      "notifications.preferences.set_on_behalf",
    );
    const out = await handler(
      inputFor({
        params: { userId: OTHER_USER, category: "marketing", channel: "email" },
        parsedBody: { optedIn: false },
      }),
    );
    expect(status(out)).toBe(403);
    expect(recorder.puts).toHaveLength(0);
  });
});

describe("preference-routes — read", () => {
  it("reports the whole grid with provenance, so a client never reimplements the default", async () => {
    const handler = handlerFor(ctxFor(), "notifications.preferences.read");
    const out = await handler(inputFor());
    expect(status(out)).toBe(200);
    const resolved = body(out)["resolved"] as Array<Record<string, unknown>>;
    expect(resolved).toHaveLength(CONTENT_CATEGORIES.length * NOTIFICATION_CHANNELS.length);
    expect(resolved.every((r) => r["from"] === "default")).toBe(true);
  });

  it("marks a stored pair as stored and leaves the rest on the default", async () => {
    const stored = matrix([
      {
        category: "operational_digest",
        channel: "email",
        optedIn: false,
        updatedAt: "2026-05-01T00:00:00.000Z",
        source: "user_set",
      },
    ]);
    const handler = handlerFor(
      ctxFor({ store: recordingStore({ matrix: stored }).store }),
      "notifications.preferences.read",
    );
    const resolved = body(await handler(inputFor()))["resolved"] as Array<Record<string, unknown>>;
    const hit = resolved.find(
      (r) => r["category"] === "operational_digest" && r["channel"] === "email",
    );
    expect(hit).toMatchObject({ optedIn: false, from: "stored", default: true });
    const miss = resolved.find(
      (r) => r["category"] === "operational_digest" && r["channel"] === "sms",
    );
    expect(miss).toMatchObject({ optedIn: true, from: "default" });
  });

  it("reports marketing as off by default and suppressible", () => {
    const resolved = matrixResponse(matrix())["resolved"] as Array<Record<string, unknown>>;
    const marketing = resolved.find(
      (r) => r["category"] === "marketing" && r["channel"] === "email",
    );
    expect(marketing).toMatchObject({ optedIn: false, default: false, suppressible: true });
  });

  it("reports security_alert as on and not suppressible", () => {
    const resolved = matrixResponse(matrix())["resolved"] as Array<Record<string, unknown>>;
    const alert = resolved.find(
      (r) => r["category"] === "security_alert" && r["channel"] === "email",
    );
    expect(alert).toMatchObject({ optedIn: true, default: true, suppressible: false });
  });

  it("503s preferences_unreadable rather than serving a matrix built past a bad row", async () => {
    const handler = handlerFor(
      ctxFor({
        store: recordingStore({
          matrixThrows: new PreferenceRowUnreadableError("entry_unparseable", "marketing", "bad"),
        }).store,
      }),
      "notifications.preferences.read",
    );
    const out = await handler(inputFor());
    expect(status(out)).toBe(503);
    expect(body(out)["error"]).toBe("preferences_unreadable");
  });

  it("503s preferences_unavailable for an ordinary store failure", async () => {
    const handler = handlerFor(
      ctxFor({ store: recordingStore({ matrixThrows: new Error("down") }).store }),
      "notifications.preferences.read",
    );
    expect(body(await handler(inputFor()))["error"]).toBe("preferences_unavailable");
  });

  it("403s an ungranted role before touching the store", async () => {
    const recorder = recordingStore();
    const handler = handlerFor(
      ctxFor({ store: recorder.store, allowedRoles: new Set(["nobody"]) }),
      "notifications.preferences.read",
    );
    expect(status(await handler(inputFor()))).toBe(403);
  });
});

describe("preference-routes — clear", () => {
  it("removes the row and reports the default that now governs", async () => {
    const recorder = recordingStore({ cleared: true });
    const handler = handlerFor(
      ctxFor({ store: recorder.store }),
      "notifications.preferences.clear",
    );
    const out = await handler(inputFor());
    expect(status(out)).toBe(200);
    expect(body(out)).toMatchObject({ outcome: "cleared", optedIn: false, from: "default" });
    expect(recorder.clears[0]).toMatchObject({ userId: USER, category: "marketing" });
  });

  it("reports absent when there was nothing to clear", async () => {
    const handler = handlerFor(
      ctxFor({ store: recordingStore({ cleared: false }).store }),
      "notifications.preferences.clear",
    );
    expect(body(await handler(inputFor()))["outcome"]).toBe("absent");
  });

  it("records the clear with a null optedIn, because a clear sets no value", async () => {
    const audit = auditing();
    const handler = handlerFor(
      ctxFor({ audit: audit.audit }),
      "notifications.preferences.clear",
    );
    await handler(inputFor());
    expect(audit.events[0]).toMatchObject({
      outcome: PREFERENCE_CLEARED_OPERATION,
      optedIn: null,
      source: null,
    });
  });

  it("400s an unknown category", async () => {
    const handler = handlerFor(ctxFor(), "notifications.preferences.clear");
    expect(
      status(await handler(inputFor({ params: { category: "gossip", channel: "email" } }))),
    ).toBe(400);
  });

  it("503s when the delete fails", async () => {
    const handler = handlerFor(
      ctxFor({ store: recordingStore({ clearThrows: true }).store }),
      "notifications.preferences.clear",
    );
    expect(status(await handler(inputFor()))).toBe(503);
  });
});
