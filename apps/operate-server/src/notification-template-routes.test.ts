import type { PathSegment, ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import {
  canTransitionTemplate,
  type NotificationTemplate,
  type TemplateStatus,
} from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  TEMPLATE_TRANSITION_ROUTES,
  buildNotificationTemplateRoutes,
  derivedBodySizeBytes,
  markupRefusals,
  pinsTrustedOrigin,
  resolveTemplateGrant,
  validateTemplateContent,
  type ContentRefusal,
  type NotificationTemplateRoutesContext,
  type NotificationTemplateStoreLike,
  type TemplateListPageLike,
  type TemplateListQueryLike,
  type TemplateTransitionOutcomeLike,
  type TemplateTransitionRequestLike,
} from "./notification-template-routes.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const AUTHOR = "00000000-0000-4000-8000-0000000000a1";
const APPROVER = "00000000-0000-4000-8000-0000000000a2";

const AUTHOR_ROLE = "notification_author";
const APPROVER_ROLE = "notification_approver";
const PRIVILEGED_CATEGORY_ROLE = "notification_platform_author";

const NOW = new Date("2026-10-01T00:00:00.000Z");

const TEMPLATE_ID = "ntpl_cafebabe01";

function emailContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "email",
    subject: "Invoice {{number}}",
    htmlBody: '<p>Hello <strong>{{name}}</strong> — <a href="https://app.test/invoices/{{number}}">view</a></p>',
    plaintextBody: "Hello {{name}}",
    ...overrides,
  };
}

const VARIABLES = [
  { name: "number", type: "string" },
  { name: "name", type: "string" },
];

function draftBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    templateId: "invoice.issued",
    version: "1.0.0",
    locale: "en-US",
    channel: "email",
    category: "system_notice",
    content: emailContent(),
    variables: VARIABLES,
    ...overrides,
  };
}

/** A store that actually enforces the lifecycle, so a route bug shows up as a wrong record. */
class FakeTemplateStore implements NotificationTemplateStoreLike {
  readonly rows = new Map<string, NotificationTemplate>();
  readonly transitions: TemplateTransitionRequestLike[] = [];
  nextCreateConflicts = false;

  seed(overrides: Partial<NotificationTemplate> = {}): NotificationTemplate {
    const template: NotificationTemplate = {
      id: TEMPLATE_ID,
      tenantId: TENANT,
      templateId: "invoice.issued",
      version: "1.0.0",
      locale: "en-US",
      channel: "email",
      category: "system_notice",
      status: "draft",
      content: {
        channel: "email",
        subject: "Invoice {{number}}",
        htmlBody: "<p>Hello</p>",
        plaintextBody: "Hello",
      },
      variables: [{ name: "number", type: "string", required: true, redactInLogs: false }],
      bodySizeBytes: 40,
      createdAt: "2026-09-01T00:00:00.000Z",
      createdBy: AUTHOR,
      approvedAt: null,
      approvedBy: null,
      deprecatedAt: null,
      supersededByTemplateId: null,
      ...overrides,
    };
    this.rows.set(template.id, template);
    return template;
  }

  async createDraft(
    tenantId: string,
    template: NotificationTemplate,
  ): Promise<NotificationTemplate | null> {
    if (this.nextCreateConflicts) return null;
    if (template.tenantId !== tenantId) throw new Error("tenant mismatch reached the store");
    this.rows.set(template.id, template);
    return template;
  }

  async get(tenantId: string, ntplId: string): Promise<NotificationTemplate | null> {
    const found = this.rows.get(ntplId);
    return found !== undefined && found.tenantId === tenantId ? found : null;
  }

  async list(tenantId: string, query: TemplateListQueryLike): Promise<TemplateListPageLike> {
    const data = [...this.rows.values()].filter(
      (t) =>
        t.tenantId === tenantId &&
        (query.status === undefined || t.status === query.status) &&
        (query.channel === undefined || t.channel === query.channel),
    );
    return { data, nextCursor: null };
  }

  async transition(
    tenantId: string,
    ntplId: string,
    request: TemplateTransitionRequestLike,
  ): Promise<TemplateTransitionOutcomeLike> {
    this.transitions.push(request);
    const current = await this.get(tenantId, ntplId);
    if (current === null) return { kind: "not_found" };
    if (!canTransitionTemplate(current.status, request.to)) {
      return { kind: "illegal_transition", from: current.status, to: request.to };
    }
    if (request.to === "approved" && current.createdBy === request.actorId) {
      return { kind: "four_eyes", authorId: current.createdBy };
    }
    const next: NotificationTemplate = {
      ...current,
      status: request.to,
      ...(request.to === "approved"
        ? { approvedAt: request.at, approvedBy: request.actorId }
        : {}),
      ...(request.to === "draft" ? { approvedAt: null, approvedBy: null } : {}),
      ...(request.to === "deprecated" ? { deprecatedAt: request.at } : {}),
    };
    this.rows.set(ntplId, next);
    return { kind: "transitioned", template: next };
  }
}

interface Harness {
  readonly ctx: NotificationTemplateRoutesContext;
  readonly store: FakeTemplateStore;
}

function makeCtx(overrides: Partial<NotificationTemplateRoutesContext> = {}): Harness {
  const store = new FakeTemplateStore();
  const ctx: NotificationTemplateRoutesContext = {
    store,
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" }),
    authorRoles: new Set([AUTHOR_ROLE]),
    approverRoles: new Set([APPROVER_ROLE]),
    newTemplateId: () => TEMPLATE_ID,
    clock: () => NOW,
    ...overrides,
  };
  return { ctx, store };
}

function principal(
  role: string | null,
  opts: { tenantId?: string | null; principalId?: string } = {},
): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: opts.principalId ?? AUTHOR,
    tenantId: opts.tenantId === undefined ? TENANT : opts.tenantId,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-09-01T00:00:00.000Z",
  } as ResolvedPrincipal;
}

function input(
  p: ResolvedPrincipal | null,
  opts: {
    query?: Record<string, string>;
    params?: Record<string, string>;
    body?: Record<string, unknown> | null;
  } = {},
): HandlerInput {
  return {
    request: { query: opts.query ?? {} } as never,
    route: {} as never,
    principal: p,
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  };
}

function findHandler(ctx: NotificationTemplateRoutesContext, op: string): Handler {
  const found = buildNotificationTemplateRoutes(ctx).find((r) => r.route.operationId === op);
  if (found === undefined) throw new Error(`no route ${op}`);
  return found.handler;
}

type JsonOut = HandlerOutput & { status: number; body: Record<string, unknown> };

async function call(
  ctx: NotificationTemplateRoutesContext,
  op: string,
  p: ResolvedPrincipal | null,
  opts: Parameters<typeof input>[1] = {},
): Promise<JsonOut> {
  return (await findHandler(ctx, op)(input(p, opts))) as JsonOut;
}

function pathOf(segments: readonly PathSegment[]): string {
  return segments
    .map((s) => (s.kind === "literal" ? s.value : s.kind === "parameter" ? `:${s.name}` : "*"))
    .join("/");
}

function refusalCodes(out: JsonOut): readonly string[] {
  return (out.body["refusals"] as readonly ContentRefusal[] | undefined)?.map((r) => r.code) ?? [];
}

const ALL_OPS = [
  "notificationTemplates.list",
  "notificationTemplates.create",
  "notificationTemplates.get",
  ...TEMPLATE_TRANSITION_ROUTES.map((t) => t.op),
] as const;

describe("buildNotificationTemplateRoutes", () => {
  it("exposes the authoring surface and nothing else", () => {
    const { ctx } = makeCtx();
    const routes = buildNotificationTemplateRoutes(ctx);
    expect(routes.map((r) => r.route.operationId).sort()).toEqual([...ALL_OPS].sort());
    for (const r of routes) {
      expect(["GET", "POST"]).toContain(r.route.method);
      expect(pathOf(r.route.pathSegments)).toMatch(/^v1\/notification-templates/);
    }
  });

  it("declares only transitions the contract has", () => {
    for (const t of TEMPLATE_TRANSITION_ROUTES) {
      for (const from of t.from) {
        expect(canTransitionTemplate(from, t.to)).toBe(true);
      }
    }
  });

  it("refuses every route without a principal", async () => {
    const { ctx } = makeCtx();
    for (const op of ALL_OPS) {
      const out = await call(ctx, op, null, { params: { ntplId: TEMPLATE_ID } });
      expect(out.status).toBe(401);
    }
  });

  it("refuses every route for an unknown role, and configures nobody by default", async () => {
    const { ctx } = makeCtx({ authorRoles: new Set(), approverRoles: new Set() });
    for (const op of ALL_OPS) {
      const out = await call(ctx, op, principal(AUTHOR_ROLE), { params: { ntplId: TEMPLATE_ID } });
      expect(out.status).toBe(403);
    }
  });

  it("refuses a caller whose user id is not a uuid — an author must be a person", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, "notificationTemplates.create", principal(AUTHOR_ROLE, { principalId: "svc-key-1" }), {
      body: draftBody(),
    });
    expect(out.status).toBe(403);
  });

  it("refuses a caller with no resolvable tenant", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, "notificationTemplates.list", principal(AUTHOR_ROLE, { tenantId: null }));
    expect(out.status).toBe(403);
  });
});

describe("resolveTemplateGrant", () => {
  it("prefers the approver grant and carries the actor", () => {
    const { ctx } = makeCtx();
    expect(resolveTemplateGrant(ctx, principal(APPROVER_ROLE, { principalId: APPROVER }))).toEqual({
      kind: "approver",
      tenantId: TENANT,
      actorId: APPROVER,
      roles: [APPROVER_ROLE],
    });
    expect(resolveTemplateGrant(ctx, principal(AUTHOR_ROLE))?.kind).toBe("author");
    expect(resolveTemplateGrant(ctx, null)).toBeNull();
  });
});

describe("notificationTemplates.create", () => {
  it("creates a draft attributed to the caller, with a derived size and a server-assigned id", async () => {
    const { ctx, store } = makeCtx();
    const out = await call(ctx, "notificationTemplates.create", principal(AUTHOR_ROLE), {
      body: draftBody(),
    });
    expect(out.status).toBe(201);
    const template = out.body["template"] as NotificationTemplate;
    expect(template.status).toBe("draft");
    expect(template.createdBy).toBe(AUTHOR);
    expect(template.createdAt).toBe(NOW.toISOString());
    expect(template.id).toBe(TEMPLATE_ID);
    expect(template.tenantId).toBe(TENANT);
    expect(template.approvedBy).toBeNull();
    // Derived from the content, never taken from the request.
    expect(template.bodySizeBytes).toBe(derivedBodySizeBytes(template.content));
    expect(store.rows.get(TEMPLATE_ID)?.status).toBe("draft");
  });

  it("refuses a body that tries to set status, createdBy or the size itself", async () => {
    const { ctx, store } = makeCtx();
    for (const extra of [
      { status: "approved" },
      { createdBy: APPROVER },
      { approvedBy: APPROVER },
      { bodySizeBytes: 1 },
      { tenantId: TENANT },
    ]) {
      const out = await call(ctx, "notificationTemplates.create", principal(AUTHOR_ROLE), {
        body: draftBody(extra),
      });
      expect(out.status).toBe(400);
      expect(out.body["error"]).toBe("invalid_request");
    }
    expect(store.rows.size).toBe(0);
  });

  it("reports a duplicate version as a conflict rather than overwriting an approved body", async () => {
    const { ctx, store } = makeCtx();
    store.nextCreateConflicts = true;
    const out = await call(ctx, "notificationTemplates.create", principal(AUTHOR_ROLE), {
      body: draftBody(),
    });
    expect(out.status).toBe(409);
    expect(out.body["error"]).toBe("template_version_exists");
  });

  it("refuses a body whose content channel disagrees with the template channel", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, "notificationTemplates.create", principal(AUTHOR_ROLE), {
      body: draftBody({ channel: "sms", content: emailContent() }),
    });
    expect(out.status).toBe(400);
  });
});

describe("authored content the route refuses to store", () => {
  async function create(
    body: Record<string, unknown>,
    overrides: Partial<NotificationTemplateRoutesContext> = {},
    role = AUTHOR_ROLE,
  ): Promise<JsonOut> {
    const { ctx } = makeCtx(overrides);
    return call(ctx, "notificationTemplates.create", principal(role), { body });
  }

  it("refuses a script tag in an html body", async () => {
    const out = await create(
      draftBody({ content: emailContent({ htmlBody: "<p>hi</p><script>fetch('//evil.test')</script>" }) }),
    );
    expect(out.status).toBe(422);
    expect(out.body["error"]).toBe("template_content_rejected");
    expect(refusalCodes(out)).toContain("unsafe_markup");
  });

  it("refuses an event handler attribute, which no denylist of tags would catch", async () => {
    const out = await create(
      draftBody({ content: emailContent({ htmlBody: '<img src="https://a.test/x.png" onerror="alert(1)">' }) }),
    );
    expect(out.status).toBe(422);
    expect(
      (out.body["refusals"] as readonly ContentRefusal[]).some((r) =>
        r.detail.includes("attribute not allowed: onerror"),
      ),
    ).toBe(true);
  });

  it("refuses a javascript: action url, which z.string().url() accepts", async () => {
    const out = await create(
      draftBody({
        channel: "in_app",
        content: {
          channel: "in_app",
          title: "Hi {{name}}",
          htmlBody: "<p>Hello {{name}}</p>",
          actionUrl: "javascript:alert(document.cookie)",
          severity: "info",
        },
      }),
    );
    expect(out.status).toBe(422);
    expect(refusalCodes(out)).toContain("untrusted_url");
  });

  it("refuses an action url whose origin is chosen at render time", async () => {
    const out = await create(
      draftBody({
        channel: "in_app",
        content: {
          channel: "in_app",
          title: "Hi {{name}}",
          htmlBody: "<p>Hello {{name}}</p>",
          actionUrl: "https://app{{number}}",
          severity: "info",
        },
      }),
    );
    expect(out.status).toBe(422);
    expect(refusalCodes(out)).toContain("untrusted_url");
  });

  it("refuses a data: uri", async () => {
    const out = await create(
      draftBody({ content: emailContent({ htmlBody: '<img src="data:text/html;base64,PHNjcmlwdD4=">' }) }),
    );
    expect(out.status).toBe(422);
    expect(refusalCodes(out)).toContain("unsafe_markup");
  });

  it("refuses a placeholder the template does not declare", async () => {
    const out = await create(
      draftBody({ content: emailContent({ plaintextBody: "Hello {{secretToken}}" }) }),
    );
    expect(out.status).toBe(422);
    expect(refusalCodes(out)).toContain("undeclared_placeholder");
  });

  it("refuses a templated sender identity", async () => {
    const out = await create(
      draftBody({ content: emailContent({ fromName: "{{name}} Support" }) }),
    );
    expect(out.status).toBe(422);
    expect(refusalCodes(out)).toContain("templated_sender");
  });

  it("refuses a redactInLogs variable in a subject line", async () => {
    const out = await create(
      draftBody({
        content: emailContent({ subject: "Results for {{name}}" }),
        variables: [
          { name: "number", type: "string" },
          { name: "name", type: "string", redactInLogs: true },
        ],
      }),
    );
    expect(out.status).toBe(422);
    expect(refusalCodes(out)).toContain("redacted_variable_exposed");
  });

  it("refuses a webhook payload template that cannot render JSON", async () => {
    const out = await create(
      draftBody({
        channel: "webhook",
        content: {
          channel: "webhook",
          eventName: "invoice.issued",
          payloadJsonTemplate: '{"n": {{number}},,}',
          signatureAlgorithm: "hmac-sha256",
        },
        variables: [{ name: "number", type: "number" }],
      }),
    );
    expect(out.status).toBe(422);
    expect(refusalCodes(out)).toContain("unparseable_payload_template");
  });

  it("refuses a non-suppressible category without the privileged role, and allows it with one", async () => {
    const denied = await create(draftBody({ category: "security_alert" }));
    expect(denied.status).toBe(422);
    expect(refusalCodes(denied)).toContain("category_not_permitted");

    const allowed = await create(
      draftBody({ category: "security_alert" }),
      {
        authorRoles: new Set([PRIVILEGED_CATEGORY_ROLE]),
        nonSuppressibleCategoryRoles: new Set([PRIVILEGED_CATEGORY_ROLE]),
      },
      PRIVILEGED_CATEGORY_ROLE,
    );
    expect(allowed.status).toBe(201);
  });

  it("refuses a body over the channel's own limit, measured rather than declared", async () => {
    // Each in_app field is inside its own `max`, and together they are over the channel's
    // 65_536-byte cap: a per-field limit cannot see the total, which is why the size is derived.
    const over = await create(
      draftBody({
        channel: "in_app",
        content: {
          channel: "in_app",
          title: "T".repeat(200),
          htmlBody: `<p>${"x".repeat(65_500)}</p>`,
          severity: "info",
        },
        variables: [],
      }),
    );
    expect(over.status).toBe(422);
    expect(refusalCodes(over)).toContain("oversized_body");
    const within = await create(
      draftBody({ channel: "sms", content: { channel: "sms", body: "x".repeat(1599) } }),
    );
    expect(within.status).toBe(201);
  });

  it("accepts the safe markup an author actually needs", async () => {
    const out = await create(draftBody());
    expect(out.status).toBe(201);
  });
});

describe("validateTemplateContent helpers", () => {
  it("pins the origin only when it is fully literal", () => {
    expect(pinsTrustedOrigin("https://app.test/x")).toBe(true);
    expect(pinsTrustedOrigin("https://app.test")).toBe(true);
    expect(pinsTrustedOrigin("https://app.test/invoices/{{id}}")).toBe(true);
    expect(pinsTrustedOrigin("https://app{{id}}")).toBe(false);
    expect(pinsTrustedOrigin("http://app.test/x")).toBe(false);
    expect(pinsTrustedOrigin("{{url}}")).toBe(false);
    expect(pinsTrustedOrigin("javascript:alert(1)")).toBe(false);
  });

  it("names the offending construct and nothing else", () => {
    const refusals = markupRefusals(
      "content.htmlBody",
      "<iframe src=https://evil.test></iframe>",
      new Set(["p"]),
      new Set(["href"]),
    );
    expect(refusals.map((r) => r.detail)).toContain("tag not allowed: iframe");
  });

  it("returns every refusal at once, not the first", () => {
    const refusals = validateTemplateContent({
      content: {
        channel: "in_app",
        title: "{{unknown}}",
        htmlBody: "<script>x</script>",
        actionUrl: "javascript:alert(1)",
        severity: "info",
      },
      variables: [],
      channel: "in_app",
      category: "security_alert",
      mayAuthorNonSuppressible: false,
    });
    expect(new Set(refusals.map((r) => r.code))).toEqual(
      new Set(["category_not_permitted", "undeclared_placeholder", "unsafe_markup", "untrusted_url"]),
    );
  });
});

describe("the template lifecycle over HTTP", () => {
  async function move(
    ctx: NotificationTemplateRoutesContext,
    op: string,
    p: ResolvedPrincipal | null,
  ): Promise<JsonOut> {
    return call(ctx, op, p, { params: { ntplId: TEMPLATE_ID } });
  }

  it("submits, then approves with a second pair of eyes", async () => {
    const { ctx, store } = makeCtx();
    store.seed();
    const submitted = await move(ctx, "notificationTemplates.submit", principal(AUTHOR_ROLE));
    expect(submitted.status).toBe(200);
    expect(store.rows.get(TEMPLATE_ID)?.status).toBe("in_review");
    const approved = await move(
      ctx,
      "notificationTemplates.approve",
      principal(APPROVER_ROLE, { principalId: APPROVER }),
    );
    expect(approved.status).toBe(200);
    const template = approved.body["template"] as NotificationTemplate;
    expect(template.status).toBe("approved");
    expect(template.approvedBy).toBe(APPROVER);
    expect(template.approvedAt).toBe(NOW.toISOString());
  });

  it("REFUSES the author approving their own template", async () => {
    const { ctx, store } = makeCtx();
    store.seed({ status: "in_review", createdBy: AUTHOR });
    const out = await move(
      ctx,
      "notificationTemplates.approve",
      // Same person as `createdBy`, and holding the approver role: the role is not the rule.
      principal(APPROVER_ROLE, { principalId: AUTHOR }),
    );
    expect(out.status).toBe(403);
    expect(out.body["error"]).toBe("four_eyes_violation");
    expect(store.rows.get(TEMPLATE_ID)?.status).toBe("in_review");
    expect(store.rows.get(TEMPLATE_ID)?.approvedBy).toBeNull();
  });

  it("takes the approver from the principal, so a body cannot nominate someone else", async () => {
    const { ctx, store } = makeCtx();
    store.seed({ status: "in_review" });
    const handler = findHandler(ctx, "notificationTemplates.approve");
    const out = (await handler(
      input(principal(APPROVER_ROLE, { principalId: AUTHOR }), {
        params: { ntplId: TEMPLATE_ID },
        body: { actorId: APPROVER, approvedBy: APPROVER },
      }),
    )) as JsonOut;
    expect(out.status).toBe(403);
    expect(store.transitions.at(-1)?.actorId).toBe(AUTHOR);
  });

  it("needs an approver role to approve, reject, deprecate or retire", async () => {
    const { ctx, store } = makeCtx();
    store.seed({ status: "in_review" });
    for (const op of TEMPLATE_TRANSITION_ROUTES.filter((t) => t.need === "approver")) {
      const out = await move(ctx, op.op, principal(AUTHOR_ROLE));
      expect(out.status).toBe(403);
      expect(out.body["detail"]).toContain("approver");
    }
  });

  it("reports an illegal move as a conflict and leaves the row alone", async () => {
    const { ctx, store } = makeCtx();
    store.seed({ status: "draft" });
    const out = await move(
      ctx,
      "notificationTemplates.approve",
      principal(APPROVER_ROLE, { principalId: APPROVER }),
    );
    expect(out.status).toBe(409);
    expect(out.body["error"]).toBe("illegal_transition");
    expect(store.rows.get(TEMPLATE_ID)?.status).toBe("draft");
  });

  it("reports a row that moved underneath as a conflict, not a success", async () => {
    const { store } = makeCtx();
    store.seed({ status: "in_review" });
    const stale: NotificationTemplateStoreLike = {
      createDraft: (t, template) => store.createDraft(t, template),
      get: (t, id) => store.get(t, id),
      list: (t, q) => store.list(t, q),
      transition: async (): Promise<TemplateTransitionOutcomeLike> => ({
        kind: "conflict",
        from: "in_review",
      }),
    };
    const { ctx: staleCtx } = makeCtx({ store: stale });
    const out = await move(
      staleCtx,
      "notificationTemplates.approve",
      principal(APPROVER_ROLE, { principalId: APPROVER }),
    );
    expect(out.status).toBe(409);
    expect(out.body["error"]).toBe("template_changed");
  });

  it("404s a missing template and an impossible id", async () => {
    const { ctx } = makeCtx();
    const missing = await move(ctx, "notificationTemplates.submit", principal(AUTHOR_ROLE));
    expect(missing.status).toBe(404);
    const bad = await call(ctx, "notificationTemplates.get", principal(AUTHOR_ROLE), {
      params: { ntplId: "../../etc/passwd" },
    });
    expect(bad.status).toBe(404);
  });

  it("retires from every status the contract allows", async () => {
    for (const from of ["draft", "in_review", "approved", "deprecated"] as TemplateStatus[]) {
      const { ctx, store } = makeCtx();
      store.seed(
        from === "approved"
          ? { status: from, approvedAt: "2026-09-02T00:00:00.000Z", approvedBy: APPROVER }
          : from === "deprecated"
            ? { status: from, deprecatedAt: "2026-09-03T00:00:00.000Z" }
            : { status: from },
      );
      const out = await move(
        ctx,
        "notificationTemplates.retire",
        principal(APPROVER_ROLE, { principalId: APPROVER }),
      );
      expect(out.status).toBe(200);
      expect(store.rows.get(TEMPLATE_ID)?.status).toBe("retired");
    }
  });
});

describe("reading templates", () => {
  it("lists only the caller's own tenant, with the filters validated", async () => {
    const { ctx, store } = makeCtx();
    store.seed();
    store.seed({ id: "ntpl_dddddddd", tenantId: "00000000-0000-4000-8000-000000000009" });
    const out = await call(ctx, "notificationTemplates.list", principal(AUTHOR_ROLE), {
      query: { status: "draft" },
    });
    expect(out.status).toBe(200);
    expect((out.body["data"] as readonly NotificationTemplate[]).map((t) => t.id)).toEqual([
      TEMPLATE_ID,
    ]);
    const bad = await call(ctx, "notificationTemplates.list", principal(AUTHOR_ROLE), {
      query: { status: "live" },
    });
    expect(bad.status).toBe(400);
  });

  it("refuses the page rather than shortening it when a row cannot be read", async () => {
    const { store } = makeCtx();
    const failing: NotificationTemplateStoreLike = {
      createDraft: (t, template) => store.createDraft(t, template),
      get: (t, id) => store.get(t, id),
      list: async (): Promise<TemplateListPageLike> => {
        throw new Error("stored template invalid");
      },
      transition: (t, id, r) => store.transition(t, id, r),
    };
    const { ctx } = makeCtx({ store: failing });
    const out = await call(ctx, "notificationTemplates.list", principal(AUTHOR_ROLE));
    expect(out.status).toBe(400);
    expect(out.body["error"]).toBe("template_page_unreadable");
    // No error text from the store reaches the caller.
    expect(JSON.stringify(out.body)).not.toContain("stored template invalid");
  });

  it("reads one template", async () => {
    const { ctx, store } = makeCtx();
    store.seed();
    const out = await call(ctx, "notificationTemplates.get", principal(AUTHOR_ROLE), {
      params: { ntplId: TEMPLATE_ID },
    });
    expect(out.status).toBe(200);
    expect((out.body["template"] as NotificationTemplate).id).toBe(TEMPLATE_ID);
  });
});
