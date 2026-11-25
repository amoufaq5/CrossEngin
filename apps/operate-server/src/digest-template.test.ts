import {
  CHANNEL_CAPABILITIES,
  DigestBatchSchema,
  NotificationTemplateSchema,
  TemplateContentSchema,
  TemplateVariableSchema,
  renderTemplateContent,
  templatePlaceholders,
  validateRenderInput,
  type DigestBatch,
  type NotificationTemplate,
  type TemplateContent,
} from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import { summarizeDigest, type DigestMember, type DigestSummary } from "./digest-assembly.js";
import {
  DEFAULT_DIGEST_CONTENT,
  DIGEST_CHANNEL_LABELS,
  DIGEST_TEMPLATE_LABELS,
  DIGEST_TEMPLATE_VARIABLES,
  channelLabel,
  digestItemLines,
  digestLines,
  digestRenderContext,
  digestSummaryLine,
  DIGEST_OVERRIDE_REFUSALS,
  decideDigestOverride,
  onceDigestOverrideReporter,
  renderDigest,
  templateLabel,
  type DigestOverrideRefusedEvent,
} from "./digest-template.js";
import { htmlMarkupRefusals } from "./notification-template-routes.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const TEMPLATE_ROW = "55555555-5555-4555-8555-555555555555";

/** An override and a reporter that records what it is told (ADR-0476). */
function withOverride(
  content: TemplateContent,
  reports: DigestOverrideRefusedEvent[] = [],
  version = "1.0.0",
) {
  return {
    template: { content, templateRecordId: TEMPLATE_ROW, version, locale: "en" },
    onRefused: (event: DigestOverrideRefusedEvent) => {
      reports.push(event);
    },
  };
}
const USER = "22222222-2222-4222-8222-222222222222";
const AUTHOR = "44444444-4444-4444-8444-444444444444";

const digest = (overrides: Partial<DigestBatch> = {}): DigestBatch =>
  DigestBatchSchema.parse({
    id: "dgst_abcdefgh1234",
    tenantId: TENANT,
    userId: USER,
    channel: "email",
    frequency: "daily",
    status: "queued_for_assembly",
    openedAt: "2026-08-24T22:00:00.000Z",
    scheduledDispatchAt: "2026-08-25T07:00:00.000Z",
    assembledAt: null,
    dispatchedAt: null,
    itemCount: 3,
    maxItems: 50,
    dedupSha256: null,
    ...overrides,
  });

const member = (n: number, overrides: Partial<DigestMember> = {}): DigestMember => ({
  dispatchId: `disp_${String(n).padStart(12, "0")}`,
  rowId: `3333333${n}-3333-4333-8333-333333333333`,
  templateId: "design_review.approved",
  category: "system_notice",
  priority: "normal",
  locale: "en",
  correlationId: null,
  queuedAt: `2026-08-24T22:0${n}:00.000Z`,
  ...overrides,
});

const summaryOf = (counts: Readonly<Record<string, number>>): DigestSummary => ({
  digestId: "dgst_abcdefgh1234",
  itemCount: Object.values(counts).reduce((a, b) => a + b, 0),
  templateCounts: counts,
  earliestQueuedAt: "2026-08-24T22:00:00.000Z",
  latestQueuedAt: "2026-08-24T23:00:00.000Z",
});

const digestTemplate = (content: TemplateContent = DEFAULT_DIGEST_CONTENT): NotificationTemplate =>
  NotificationTemplateSchema.parse({
    id: "ntpl_digestdefault",
    tenantId: null,
    templateId: "notification.digest",
    version: "1.0.0",
    locale: "en",
    channel: "in_app",
    category: "operational_digest",
    status: "draft",
    content,
    variables: DIGEST_TEMPLATE_VARIABLES,
    bodySizeBytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: AUTHOR,
    approvedAt: null,
    approvedBy: null,
    deprecatedAt: null,
    supersededByTemplateId: null,
  });

describe("DIGEST_TEMPLATE_VARIABLES", () => {
  it("every declared variable passes TemplateVariableSchema", () => {
    for (const variable of DIGEST_TEMPLATE_VARIABLES) {
      expect(TemplateVariableSchema.safeParse(variable).success).toBe(true);
    }
  });

  it("declares the six documented variables", () => {
    expect(DIGEST_TEMPLATE_VARIABLES.map((v) => v.name).sort()).toEqual([
      "channelLabel",
      "earliestAt",
      "itemCount",
      "itemLines",
      "latestAt",
      "summaryLine",
    ]);
  });

  it("declares no duplicate variable names", () => {
    const names = DIGEST_TEMPLATE_VARIABLES.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("types itemCount as a number and the timestamps as dates", () => {
    const byName = new Map(DIGEST_TEMPLATE_VARIABLES.map((v) => [v.name, v]));
    expect(byName.get("itemCount")?.type).toBe("number");
    expect(byName.get("earliestAt")?.type).toBe("date");
    expect(byName.get("latestAt")?.type).toBe("date");
    expect(byName.get("summaryLine")?.type).toBe("string");
  });

  it("marks every variable required", () => {
    expect(DIGEST_TEMPLATE_VARIABLES.every((v) => v.required)).toBe(true);
  });
});

describe("DEFAULT_DIGEST_CONTENT", () => {
  it("passes TemplateContentSchema", () => {
    expect(TemplateContentSchema.safeParse(DEFAULT_DIGEST_CONTENT).success).toBe(true);
  });

  it("is an in_app content record with info severity", () => {
    expect(DEFAULT_DIGEST_CONTENT.channel).toBe("in_app");
    if (DEFAULT_DIGEST_CONTENT.channel !== "in_app") throw new Error("unreachable");
    expect(DEFAULT_DIGEST_CONTENT.severity).toBe("info");
    expect(DEFAULT_DIGEST_CONTENT.actionLabel).toBeTruthy();
  });

  it("fits the in_app channel body budget", () => {
    if (DEFAULT_DIGEST_CONTENT.channel !== "in_app") throw new Error("unreachable");
    expect(Buffer.byteLength(DEFAULT_DIGEST_CONTENT.htmlBody, "utf8")).toBeLessThanOrEqual(
      CHANNEL_CAPABILITIES.in_app.maxBodyBytes,
    );
  });

  it("uses only declared variables as placeholders", () => {
    const declared = new Set(DIGEST_TEMPLATE_VARIABLES.map((v) => v.name));
    for (const placeholder of templatePlaceholders(DEFAULT_DIGEST_CONTENT)) {
      expect(declared.has(placeholder)).toBe(true);
    }
  });

  it("mentions every required declared variable", () => {
    const placeholders = new Set(templatePlaceholders(DEFAULT_DIGEST_CONTENT));
    for (const variable of DIGEST_TEMPLATE_VARIABLES) {
      if (!variable.required) continue;
      expect(placeholders.has(variable.name)).toBe(true);
    }
  });

  it("builds a schema-valid NotificationTemplate", () => {
    expect(() => digestTemplate()).not.toThrow();
  });
});

describe("templateLabel / channelLabel", () => {
  it("labels the design review template ids", () => {
    expect(templateLabel("design_review.approved")).toBe("Design review approved");
    expect(templateLabel("design_review.rejected")).toBe("Design review rejected");
    expect(DIGEST_TEMPLATE_LABELS["design_review.approved"]).toBe("Design review approved");
  });

  it("falls back to the template id for an unknown template", () => {
    expect(templateLabel("shipment.delayed")).toBe("shipment.delayed");
  });

  it("does not inherit labels from Object.prototype", () => {
    expect(templateLabel("constructor")).toBe("constructor");
    expect(templateLabel("toString")).toBe("toString");
  });

  it("labels every notification channel", () => {
    expect(channelLabel("email")).toBe("Email");
    expect(channelLabel("in_app")).toBe("In-app");
    expect(channelLabel("push_mobile")).toBe("Mobile push");
    expect(Object.keys(DIGEST_CHANNEL_LABELS)).toHaveLength(6);
  });
});

describe("digestLines", () => {
  it("orders by count descending", () => {
    const lines = digestLines(summaryOf({ "a.one": 1, "b.two": 5, "c.three": 3 }));
    expect(lines.map((l) => l.templateId)).toEqual(["b.two", "c.three", "a.one"]);
  });

  it("breaks a count tie by template id ascending", () => {
    const lines = digestLines(summaryOf({ "z.last": 2, "a.first": 2, "m.mid": 2 }));
    expect(lines.map((l) => l.templateId)).toEqual(["a.first", "m.mid", "z.last"]);
  });

  it("carries the human label and the count", () => {
    const lines = digestLines(summaryOf({ "design_review.rejected": 4 }));
    expect(lines[0]).toEqual({
      templateId: "design_review.rejected",
      count: 4,
      label: "Design review rejected",
    });
  });

  it("falls back to the template id for an unknown kind", () => {
    const lines = digestLines(summaryOf({ "unknown.kind": 1 }));
    expect(lines[0]?.label).toBe("unknown.kind");
  });

  it("returns an empty list for an empty summary", () => {
    expect(digestLines(summaryOf({}))).toEqual([]);
  });
});

describe("digestSummaryLine / digestItemLines", () => {
  it("pluralizes both halves", () => {
    expect(digestSummaryLine(3, 2)).toBe("3 notifications from 2 kinds of update");
  });

  it("uses the singular for a single item of a single kind", () => {
    expect(digestSummaryLine(1, 1)).toBe("1 notification from 1 kind of update");
  });

  it("joins one line per kind", () => {
    const lines = digestLines(summaryOf({ "design_review.approved": 2, "order.shipped": 1 }));
    expect(digestItemLines(lines)).toBe("2 x Design review approved\n1 x Order shipped");
  });
});

describe("digestRenderContext", () => {
  it("builds the variables from the pool", () => {
    const context = digestRenderContext({
      digest: digest(),
      members: [member(1), member(2), member(3, { templateId: "order.shipped" })],
    });
    expect(context.variables["itemCount"]).toBe(3);
    expect(context.variables["summaryLine"]).toBe("3 notifications from 2 kinds of update");
    expect(context.variables["itemLines"]).toBe(
      "2 x Design review approved\n1 x Order shipped",
    );
    expect(context.variables["channelLabel"]).toBe("Email");
  });

  it("carries the earliest and latest queue times", () => {
    const context = digestRenderContext({
      digest: digest(),
      members: [member(3), member(1), member(2)],
    });
    expect(context.variables["earliestAt"]).toBe("2026-08-24T22:01:00.000Z");
    expect(context.variables["latestAt"]).toBe("2026-08-24T22:03:00.000Z");
  });

  it("matches the summary the sibling module computes", () => {
    const batch = digest();
    const members = [member(1), member(2)];
    const summary = summarizeDigest(batch, members);
    const context = digestRenderContext({ digest: batch, members });
    expect(context.variables["itemCount"]).toBe(summary.itemCount);
    expect(context.variables["earliestAt"]).toBe(summary.earliestQueuedAt);
  });

  it("defaults the locale to the pool's majority locale", () => {
    const context = digestRenderContext({
      digest: digest(),
      members: [
        member(1, { locale: "fr" }),
        member(2, { locale: "fr" }),
        member(3, { locale: "en" }),
      ],
    });
    expect(context.locale).toBe("fr");
  });

  it("honours an explicit locale over the pool", () => {
    const context = digestRenderContext({
      digest: digest(),
      members: [member(1, { locale: "fr" })],
      locale: "de",
    });
    expect(context.locale).toBe("de");
  });

  it("labels the digest's own channel, not a member's", () => {
    const context = digestRenderContext({
      digest: digest({ channel: "in_app" }),
      members: [member(1)],
    });
    expect(context.variables["channelLabel"]).toBe("In-app");
  });

  it("agrees with the declared variables under validateRenderInput", () => {
    const context = digestRenderContext({
      digest: digest(),
      members: [member(1), member(2)],
    });
    const result = validateRenderInput(digestTemplate(), context);
    expect(result.missing).toEqual([]);
    expect(result.typeMismatches).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("throws for an empty pool", () => {
    expect(() => digestRenderContext({ digest: digest(), members: [] })).toThrow(
      /no members to render/,
    );
  });
});

describe("renderDigest", () => {
  it("renders a single-kind pool", () => {
    const rendered = renderDigest({
      digest: digest(),
      members: [member(1), member(2)],
    });
    expect(rendered.title).toBe("2 notifications");
    expect(rendered.itemCount).toBe(2);
    expect(rendered.severity).toBe("info");
    expect(rendered.body).toContain("2 notifications from 1 kind of update");
    expect(rendered.body).toContain("2 x Design review approved");
  });

  it("renders a multi-kind pool in count order", () => {
    const rendered = renderDigest({
      digest: digest(),
      members: [
        member(1),
        member(2),
        member(3, { templateId: "order.shipped" }),
        member(4, { templateId: "order.shipped" }),
        member(5, { templateId: "order.shipped" }),
      ],
    });
    expect(rendered.title).toBe("5 notifications");
    const shipped = rendered.body.indexOf("3 x Order shipped");
    const approved = rendered.body.indexOf("2 x Design review approved");
    expect(shipped).toBeGreaterThanOrEqual(0);
    expect(approved).toBeGreaterThan(shipped);
  });

  it("leaves no unsubstituted placeholder behind", () => {
    const rendered = renderDigest({ digest: digest(), members: [member(1)] });
    expect(rendered.body).not.toMatch(/\{\{/);
    expect(rendered.title).not.toMatch(/\{\{/);
  });

  it("states the channel and the window", () => {
    const rendered = renderDigest({
      digest: digest({ channel: "push_mobile" }),
      members: [member(1), member(2)],
    });
    expect(rendered.body).toContain("Mobile push");
    expect(rendered.body).toContain("2026-08-24T22:01:00.000Z");
    expect(rendered.body).toContain("2026-08-24T22:02:00.000Z");
  });

  it("renders an accepted in_app override", () => {
    const override = TemplateContentSchema.parse({
      channel: "in_app",
      title: "Digest: {{itemCount}}",
      htmlBody: "<p>{{summaryLine}}</p><p>{{itemLines}}</p>",
      severity: "warning",
    });
    const rendered = renderDigest({
      digest: digest(),
      members: [member(1)],
      override: withOverride(override),
    });
    expect(rendered.title).toBe("Digest: 1");
    expect(rendered.severity).toBe("warning");
  });

  it("falls back to the built-in content when an override names an undeclared variable", () => {
    const override = TemplateContentSchema.parse({
      channel: "in_app",
      title: "{{tenantSlogan}}",
      htmlBody: "<p>{{tenantSlogan}} — {{summaryLine}}</p>",
      severity: "error",
    });
    const rendered = renderDigest({
      digest: digest(),
      members: [member(1), member(2)],
      override: withOverride(override),
    });
    expect(rendered.title).toBe("2 notifications");
    expect(rendered.severity).toBe("info");
    expect(rendered.body).not.toContain("tenantSlogan");
  });

  it("falls back to the built-in content for a non-in_app override", () => {
    const override = TemplateContentSchema.parse({
      channel: "sms",
      body: "{{summaryLine}}",
    });
    const rendered = renderDigest({
      digest: digest(),
      members: [member(1)],
      override: withOverride(override),
    });
    expect(rendered.title).toBe("1 notifications");
    expect(rendered.severity).toBe("info");
    expect(rendered.body).toContain("<p>");
  });

  // A stored override the authoring routes never vetted reaches a browser as markup, so the
  // allowlist is re-applied at render time. Each shape is one the contract parses.
  it.each([
    ["a script tag", "<p>{{summaryLine}}</p><script>fetch('/api/x')</script>"],
    ["an event handler", '<p>{{summaryLine}}</p><img src="https://cdn.example.test/x.png" onerror="alert(1)">'],
    ["a javascript: link", '<p><a href="javascript:alert(1)">{{summaryLine}}</a></p>'],
    ["an iframe", '<p>{{summaryLine}}</p><iframe src="https://evil.example.test/"></iframe>'],
    ["a style attribute", '<p style="position:fixed;inset:0">{{summaryLine}}</p>'],
    ["a data: URI", '<p><a href="data:text/html,x">{{summaryLine}}</a></p>'],
  ])("falls back to the built-in content for an override carrying %s", (_name, htmlBody) => {
    const override = TemplateContentSchema.parse({ channel: "in_app", title: "Mine", htmlBody, severity: "warning" });
    const rendered = renderDigest({ digest: digest(), members: [member(1), member(2)], override: withOverride(override) });
    expect(rendered.title).toBe("2 notifications");
    expect(rendered.severity).toBe("info");
    expect(rendered.body).toBe(renderDigest({ digest: digest(), members: [member(1), member(2)] }).body);
  });

  // The case only the source can see: rendered, `https://app{{channelLabel}}` becomes a URL with a
  // literal host and passes, while the authoring route refuses it because the origin is templated.
  it("falls back for a templated origin the authoring route would refuse, though its rendering passes", () => {
    const htmlBody = '<p><a href="https://app{{channelLabel}}">{{summaryLine}}</a></p>';
    expect(htmlMarkupRefusals("htmlBody", htmlBody).length).toBeGreaterThan(0);
    const override = TemplateContentSchema.parse({ channel: "in_app", title: "Mine", htmlBody, severity: "warning" });
    const asRendered = renderTemplateContent(override, digestRenderContext({ digest: digest(), members: [member(1)] }));
    expect(htmlMarkupRefusals("htmlBody", asRendered.rendered.body)).toEqual([]);
    const rendered = renderDigest({ digest: digest(), members: [member(1)], override: withOverride(override) });
    expect(rendered.title).toBe("1 notifications");
    expect(rendered.body).not.toContain("https://app");
  });

  // And the case only the rendering can see: a placeholder in a tag-name position is not a tag in
  // the source (`<{` opens nothing), and becomes one once substituted.
  // A placeholder in a tag-name position was invisible to the source scan before ADR-0476 (`<{`
  // opens nothing) and only the rendering caught it. The source scan refuses it now, so the reason
  // a reporter is told is the source one.
  it("falls back for a placeholder in a tag-name position, refused from the source", () => {
    const htmlBody = "<p>{{summaryLine}}</p><{{channelLabel}}>";
    expect(htmlMarkupRefusals("htmlBody", htmlBody).map((r) => r.code)).toEqual(["unsafe_markup"]);
    const override = TemplateContentSchema.parse({ channel: "in_app", title: "Mine", htmlBody, severity: "warning" });
    const reports: DigestOverrideRefusedEvent[] = [];
    const rendered = renderDigest({ digest: digest(), members: [member(1)], override: withOverride(override, reports) });
    expect(rendered.title).toBe("1 notifications");
    expect(rendered.body).not.toContain("<Email>");
    expect(rendered.overrideRefusal).toBe("override_refused_source");
    expect(reports.map((r) => r.reason)).toEqual(["override_refused_source"]);
  });

  it("keeps an override whose markup is all on the authoring allowlist", () => {
    const override = TemplateContentSchema.parse({
      channel: "in_app",
      title: "Mine",
      htmlBody:
        '<p><strong>{{summaryLine}}</strong></p><pre>{{itemLines}}</pre>' +
        '<p><a href="https://app.example.test/notifications" rel="noopener">Open</a></p>',
      severity: "warning",
    });
    const rendered = renderDigest({ digest: digest(), members: [member(1)], override: withOverride(override) });
    expect(rendered.title).toBe("Mine");
    expect(rendered.body).toContain('<a href="https://app.example.test/notifications"');
  });

  it("the built-in content passes the allowlist it falls back to", () => {
    const rendered = renderDigest({ digest: digest(), members: [member(1), member(2)] });
    expect(htmlMarkupRefusals("htmlBody", rendered.body)).toEqual([]);
  });

  it("escapes HTML coming from a member template id", () => {
    const rendered = renderDigest({
      digest: digest(),
      members: [member(1, { templateId: "<script>alert(1)</script>" })],
    });
    expect(rendered.body).not.toContain("<script>");
    expect(rendered.body).not.toContain("</script>");
    expect(rendered.body).toContain("script");
  });

  it("throws for an empty pool", () => {
    expect(() => renderDigest({ digest: digest(), members: [] })).toThrow(
      /no members to render/,
    );
  });
});

describe("digest override refusals are returned and reported (ADR-0476)", () => {
  const inApp = (htmlBody: string, title = "Mine") =>
    TemplateContentSchema.parse({ channel: "in_app", title, htmlBody, severity: "warning" });

  it("names the four refusals once each", () => {
    expect(DIGEST_OVERRIDE_REFUSALS).toEqual([
      "override_channel_not_rendered",
      "override_refused_source",
      "override_missing_variables",
      "override_refused_rendered",
    ]);
  });

  it.each([
    ["override_channel_not_rendered", TemplateContentSchema.parse({ channel: "sms", body: "{{summaryLine}}" }), 0],
    ["override_refused_source", inApp("<p>{{summaryLine}}</p><script>x()</script>"), 0],
    ["override_missing_variables", inApp("<p>{{tenantSlogan}} {{motto}} {{summaryLine}}</p>"), 2],
  ] as const)("returns and reports %s with the template's identity", (reason, content, missing) => {
    const reports: DigestOverrideRefusedEvent[] = [];
    const rendered = renderDigest({
      digest: digest(),
      members: [member(1)],
      override: withOverride(content, reports, "2.1.0"),
    });
    expect(rendered.overrideRefusal).toBe(reason);
    expect(rendered.title).toBe("1 notifications");
    expect(reports).toEqual([
      {
        tenantId: TENANT,
        templateRecordId: TEMPLATE_ROW,
        version: "2.1.0",
        locale: "en",
        reason,
        missingVariableCount: missing,
      },
    ]);
  });

  it("carries no body content in the report — not the source, the rendering or a variable name", () => {
    const reports: DigestOverrideRefusedEvent[] = [];
    renderDigest({
      digest: digest(),
      members: [member(1)],
      override: withOverride(inApp("<p>SECRET-COPY {{tenantSlogan}}</p>", "SECRET-TITLE"), reports),
    });
    const said = JSON.stringify(reports);
    expect(said).not.toContain("SECRET-COPY");
    expect(said).not.toContain("SECRET-TITLE");
    expect(said).not.toContain("tenantSlogan");
    expect(Object.keys(reports[0] ?? {}).sort()).toEqual([
      "locale",
      "missingVariableCount",
      "reason",
      "templateRecordId",
      "tenantId",
      "version",
    ]);
  });

  it("an applied override reports nothing and returns a null refusal", () => {
    const reports: DigestOverrideRefusedEvent[] = [];
    const rendered = renderDigest({
      digest: digest(),
      members: [member(1)],
      override: withOverride(inApp("<p>{{summaryLine}}</p>"), reports),
    });
    expect(rendered.overrideRefusal).toBeNull();
    expect(reports).toEqual([]);
  });

  it("no override at all is a null refusal, not a fallback", () => {
    expect(renderDigest({ digest: digest(), members: [member(1)] }).overrideRefusal).toBeNull();
  });

  // The rendered scan is not dead after the source scan learned placeholder positions: a value is
  // substituted escaped for markup (`<`, `>`, quotes) but not for a scheme, and the whole-body
  // scheme check only sees `javascript:` once it is in the body. A digest member's `templateId`
  // reaches `itemLines` and comes from a stored dispatch row, whose column constrains only length.
  it("reaches override_refused_rendered when a substituted value carries an executable scheme", () => {
    const reports: DigestOverrideRefusedEvent[] = [];
    const rendered = renderDigest({
      digest: digest(),
      members: [member(1, { templateId: "javascript:alert" })],
      override: withOverride(inApp("<p>{{itemLines}}</p>"), reports),
    });
    expect(rendered.overrideRefusal).toBe("override_refused_rendered");
    expect(reports.map((r) => r.reason)).toEqual(["override_refused_rendered"]);
    // control: the same override over an ordinary template id renders
    expect(
      renderDigest({
        digest: digest(),
        members: [member(1)],
        override: withOverride(inApp("<p>{{itemLines}}</p>")),
      }).overrideRefusal,
    ).toBeNull();
  });

  it("decideDigestOverride is the one decision the render and the report share", () => {
    const content = inApp("<p>{{tenantSlogan}}</p>");
    const context = digestRenderContext({ digest: digest(), members: [member(1)] });
    const decided = decideDigestOverride(content, context);
    expect(decided).toEqual({ kind: "refused", reason: "override_missing_variables", missing: 1 });
  });

  it("onceDigestOverrideReporter says a refusal once per template version and reason", () => {
    const sink: DigestOverrideRefusedEvent[] = [];
    const once = onceDigestOverrideReporter((e) => sink.push(e));
    const broken = inApp("<p>{{tenantSlogan}}</p>");
    for (let i = 0; i < 50; i += 1) {
      renderDigest({ digest: digest(), members: [member(1)], override: { ...withOverride(broken), onRefused: once } });
    }
    expect(sink).toHaveLength(1);
    // a new version is a new template, so it is said again
    renderDigest({ digest: digest(), members: [member(1)], override: { ...withOverride(broken, [], "1.0.1"), onRefused: once } });
    expect(sink).toHaveLength(2);
    // and the same version broken differently is a different finding
    renderDigest({
      digest: digest(),
      members: [member(1)],
      override: { ...withOverride(inApp("<p>{{summaryLine}}</p><script>x()</script>")), onRefused: once },
    });
    expect(sink.map((e) => e.reason)).toEqual([
      "override_missing_variables",
      "override_missing_variables",
      "override_refused_source",
    ]);
  });

  it("clears rather than freezes when its memory is full, so a refusal past the cap is still said", () => {
    const sink: DigestOverrideRefusedEvent[] = [];
    const once = onceDigestOverrideReporter((e) => sink.push(e), 2);
    const event = (templateRecordId: string): DigestOverrideRefusedEvent => ({
      tenantId: TENANT,
      templateRecordId,
      version: "1.0.0",
      locale: "en",
      reason: "override_missing_variables",
      missingVariableCount: 1,
    });
    once(event("a"));
    once(event("b"));
    once(event("c"));
    expect(sink.map((e) => e.templateRecordId)).toEqual(["a", "b", "c"]);
    once(event("c"));
    expect(sink).toHaveLength(3);
    once(event("a"));
    expect(sink).toHaveLength(4);
  });

  it("keys a report on the tenant, so two tenants' broken copies are each said", () => {
    const sink: DigestOverrideRefusedEvent[] = [];
    const once = onceDigestOverrideReporter((e) => sink.push(e));
    const base = {
      templateRecordId: TEMPLATE_ROW,
      version: "1.0.0",
      locale: "en",
      reason: "override_missing_variables" as const,
      missingVariableCount: 1,
    };
    once({ ...base, tenantId: TENANT });
    once({ ...base, tenantId: "99999999-9999-4999-8999-999999999999" });
    expect(sink).toHaveLength(2);
  });
});
