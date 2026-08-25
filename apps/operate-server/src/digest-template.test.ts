import {
  CHANNEL_CAPABILITIES,
  DigestBatchSchema,
  NotificationTemplateSchema,
  TemplateContentSchema,
  TemplateVariableSchema,
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
  renderDigest,
  templateLabel,
} from "./digest-template.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
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
      content: override,
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
      content: override,
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
      content: override,
    });
    expect(rendered.title).toBe("1 notifications");
    expect(rendered.severity).toBe("info");
    expect(rendered.body).toContain("<p>");
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
