import type {
  NotificationDispatch,
  NotificationTemplate,
  TemplateContent,
} from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  CHANNEL_TAKES_RENDERED_CONTENT,
  DISPATCH_CONTENT_ABSENCES,
  templateContentSource,
  type ApprovedTemplateLookup,
} from "./delivery-content.js";
import {
  renderedEmailComposer,
  renderedSmsComposer,
  renderedVoiceComposer,
} from "./delivery-senders-env.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

function dispatch(channel: NotificationDispatch["channel"]): NotificationDispatch {
  return {
    id: `disp_${"a".repeat(32)}`,
    tenantId: TENANT,
    templateId: "invoice.approved",
    templateVersion: "1.0.0",
    locale: "en-US",
    channel,
    category: "transactional",
    priority: "normal",
    audienceJson: { kind: "tenant_admins", tenantId: TENANT },
    variablesSha256: "b".repeat(64),
    correlationId: null,
    idempotencyKey: "k",
    status: "rendering",
    queuedAt: "2026-08-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    recipientCount: 1,
    deliveredCount: 0,
    failedCount: 0,
    suppressedCount: 0,
    cancelledReason: null,
    requestedBy: null,
    requestingSystem: "operate-server",
  };
}

function template(content: TemplateContent): NotificationTemplate {
  return {
    id: "ntpl_abcdefgh",
    tenantId: TENANT,
    templateId: "invoice.approved",
    version: "1.0.0",
    locale: "en-US",
    channel: content.channel,
    category: "transactional",
    status: "approved",
    content,
    variables: [],
    bodySizeBytes: 10,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "22222222-2222-4222-8222-222222222222",
    approvedAt: "2026-08-01T00:00:00.000Z",
    approvedBy: "33333333-3333-4333-8333-333333333333",
    deprecatedAt: null,
    supersededByTemplateId: null,
  };
}

function lookup(found: NotificationTemplate | null): ApprovedTemplateLookup & { asked: number } {
  const l = {
    asked: 0,
    async find(): Promise<NotificationTemplate | null> {
      l.asked += 1;
      return found;
    },
  };
  return l;
}

describe("delivery-content — templateContentSource", () => {
  it("renders an approved email template into subject, plaintext and HTML", async () => {
    const source = templateContentSource(
      lookup(
        template({
          channel: "email",
          subject: "Invoice approved",
          htmlBody: "<p>Your invoice is approved.</p>",
          plaintextBody: "Your invoice is approved.",
        }),
      ),
    );
    expect(await source(dispatch("email"))).toEqual({
      kind: "rendered",
      content: {
        subject: "Invoice approved",
        body: "Your invoice is approved.",
        htmlBody: "<p>Your invoice is approved.</p>",
      },
    });
  });

  it("renders sms as its plain body and voice as its plain fallback, never its SSML", async () => {
    const sms = templateContentSource(lookup(template({ channel: "sms", body: "Approved." })));
    expect(await sms(dispatch("sms"))).toEqual({
      kind: "rendered",
      content: { subject: "", body: "Approved.", htmlBody: null },
    });
    const voice = templateContentSource(
      lookup(
        template({
          channel: "voice_call",
          ssmlBody: "<speak>Approved &amp; done.</speak>",
          fallbackTextBody: "Approved and done.",
          voice: "alice",
        }),
      ),
    );
    expect(await voice(dispatch("voice_call"))).toEqual({
      kind: "rendered",
      content: { subject: "", body: "Approved and done.", htmlBody: null },
    });
  });

  // The ledger keeps `variables_sha256` and never the variables, so a placeholder has no value at
  // delivery time. Sending the template with a blank where the value belongs would be worse than
  // the identifier-only notice.
  it("declines a template with a placeholder rather than sending it with a blank", async () => {
    const source = templateContentSource(
      lookup(template({ channel: "sms", body: "Invoice {{invoiceNumber}} approved." })),
    );
    expect(await source(dispatch("sms"))).toEqual({
      kind: "not_rendered",
      reason: "variables_not_persisted",
    });
  });

  it("does not look a template up for a channel that takes no rendered content", async () => {
    const l = lookup(template({ channel: "sms", body: "x" }));
    const source = templateContentSource(l);
    for (const channel of ["push_mobile", "in_app", "webhook"] as const) {
      expect(await source(dispatch(channel))).toEqual({
        kind: "not_rendered",
        reason: "channel_not_rendered_here",
      });
    }
    expect(l.asked).toBe(0);
  });

  it("answers no_approved_template and template_unreadable without throwing", async () => {
    expect(await templateContentSource(lookup(null))(dispatch("sms"))).toEqual({
      kind: "not_rendered",
      reason: "no_approved_template",
    });
    const throwing: ApprovedTemplateLookup = {
      async find() {
        throw new Error("connection reset");
      },
    };
    expect(await templateContentSource(throwing)(dispatch("sms"))).toEqual({
      kind: "not_rendered",
      reason: "template_unreadable",
    });
  });

  it("keeps push out of rendered content, so ADR-0310's payload rule cannot be routed around", () => {
    expect(CHANNEL_TAKES_RENDERED_CONTENT.push_mobile).toBe(false);
    expect(DISPATCH_CONTENT_ABSENCES).toContain("variables_not_persisted");
  });
});

describe("delivery-content — the provider composers", () => {
  const base = {
    dispatchId: "disp_1",
    tenantId: TENANT,
    templateId: "invoice.approved",
    locale: "en-US",
    recipientAddress: "a@x.test",
    attemptNumber: 1,
  };
  const content = { subject: "Invoice approved", body: "Approved.", htmlBody: "<p>Approved.</p>" };

  it("sends the rendered content when the request carries it", () => {
    // The request a composer is handed is operate-server's, which carries `content`; the composer is
    // typed against the provider's narrower `SendRequest`, so the field arrives as an extra key.
    const email = { ...base, channel: "email" as const, content };
    const sms = { ...base, channel: "sms" as const, content };
    const voice = { ...base, channel: "voice_call" as const, content };
    expect(renderedEmailComposer(email)).toEqual({
      subject: "Invoice approved",
      textBody: "Approved.",
      htmlBody: "<p>Approved.</p>",
    });
    expect(renderedSmsComposer(sms)).toBe("Approved.");
    expect(renderedVoiceComposer(voice)).toBe("Approved.");
  });

  it("falls back to the provider's identifier-only notice when it does not", () => {
    const email = renderedEmailComposer({ ...base, channel: "email" });
    expect(email.subject).toContain("invoice.approved");
    expect(email.htmlBody).toBeUndefined();
    expect(renderedSmsComposer({ ...base, channel: "sms" })).toContain("invoice.approved");
    expect(renderedVoiceComposer({ ...base, channel: "voice_call" })).toContain(
      "Please sign in",
    );
  });
});
