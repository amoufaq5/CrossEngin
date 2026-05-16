import { describe, expect, it } from "vitest";
import {
  CONTENT_CATEGORIES,
  NotificationTemplateSchema,
  TEMPLATE_STATUSES,
  TEMPLATE_TRANSITIONS,
  VARIABLE_TYPES,
  canTransitionTemplate,
  isCategorySuppressible,
  requiresExplicitOptIn,
  validateRenderInput,
  type NotificationTemplate,
} from "./templates.js";

const baseEmailTemplate: NotificationTemplate = {
  id: "ntpl_invoice01",
  tenantId: "11111111-1111-1111-1111-111111111111",
  templateId: "billing.invoice_paid",
  version: "1.0.0",
  locale: "en-US",
  channel: "email",
  category: "transactional",
  status: "approved",
  content: {
    channel: "email",
    subject: "Your invoice was paid",
    htmlBody: "<p>Thanks for paying invoice {invoiceNumber}.</p>",
    plaintextBody: "Thanks for paying invoice {invoiceNumber}.",
  },
  variables: [
    {
      name: "invoiceNumber",
      type: "string",
      required: true,
      redactInLogs: false,
    },
  ],
  bodySizeBytes: 512,
  createdAt: "2026-05-16T10:00:00.000Z",
  createdBy: "22222222-2222-2222-2222-222222222222",
  approvedAt: "2026-05-16T10:30:00.000Z",
  approvedBy: "33333333-3333-3333-3333-333333333333",
  deprecatedAt: null,
  supersededByTemplateId: null,
};

describe("constants", () => {
  it("has 5 content categories", () => {
    expect(CONTENT_CATEGORIES).toHaveLength(5);
  });
  it("has 5 template statuses", () => {
    expect(TEMPLATE_STATUSES).toHaveLength(5);
  });
  it("has 6 variable types", () => {
    expect(VARIABLE_TYPES).toHaveLength(6);
  });
  it("transactional and security_alert are non-suppressible", () => {
    expect(isCategorySuppressible("transactional")).toBe(false);
    expect(isCategorySuppressible("security_alert")).toBe(false);
  });
  it("marketing requires explicit opt-in", () => {
    expect(requiresExplicitOptIn("marketing")).toBe(true);
  });
});

describe("canTransitionTemplate", () => {
  it("allows draft → in_review", () => {
    expect(canTransitionTemplate("draft", "in_review")).toBe(true);
  });
  it("blocks draft → approved (must review first)", () => {
    expect(canTransitionTemplate("draft", "approved")).toBe(false);
  });
  it("retired is terminal", () => {
    expect(TEMPLATE_TRANSITIONS.retired).toEqual([]);
  });
});

describe("NotificationTemplateSchema", () => {
  it("accepts a valid approved email template", () => {
    expect(() =>
      NotificationTemplateSchema.parse(baseEmailTemplate),
    ).not.toThrow();
  });

  it("rejects content channel mismatch (template=email, content=sms)", () => {
    expect(() =>
      NotificationTemplateSchema.parse({
        ...baseEmailTemplate,
        channel: "email",
        content: { channel: "sms", body: "x" },
      }),
    ).toThrow(/does not match template channel/);
  });

  it("rejects approved template missing approvedAt", () => {
    expect(() =>
      NotificationTemplateSchema.parse({
        ...baseEmailTemplate,
        approvedAt: null,
        approvedBy: null,
      }),
    ).toThrow(/approved template requires approvedAt/);
  });

  it("enforces four-eyes (approvedBy must differ from createdBy)", () => {
    expect(() =>
      NotificationTemplateSchema.parse({
        ...baseEmailTemplate,
        approvedBy: baseEmailTemplate.createdBy,
      }),
    ).toThrow(/four-eyes/);
  });

  it("rejects body size exceeding channel limit", () => {
    expect(() =>
      NotificationTemplateSchema.parse({
        ...baseEmailTemplate,
        bodySizeBytes: 10_000_000,
      }),
    ).toThrow(/exceeds channel limit/);
  });

  it("rejects duplicate variable names", () => {
    expect(() =>
      NotificationTemplateSchema.parse({
        ...baseEmailTemplate,
        variables: [
          { name: "x", type: "string", required: true, redactInLogs: false },
          { name: "x", type: "number", required: false, redactInLogs: false },
        ],
      }),
    ).toThrow(/duplicate variable name/);
  });

  it("accepts a valid SMS template", () => {
    expect(() =>
      NotificationTemplateSchema.parse({
        ...baseEmailTemplate,
        id: "ntpl_smscode01",
        templateId: "auth.mfa_code",
        channel: "sms",
        content: {
          channel: "sms",
          body: "Your code is {code}",
        },
        variables: [
          { name: "code", type: "string", required: true, redactInLogs: true },
        ],
        bodySizeBytes: 30,
      }),
    ).not.toThrow();
  });

  it("accepts a webhook template requiring hmac-sha256", () => {
    expect(() =>
      NotificationTemplateSchema.parse({
        ...baseEmailTemplate,
        id: "ntpl_webhook01",
        templateId: "integration.event",
        channel: "webhook",
        content: {
          channel: "webhook",
          eventName: "invoice.paid",
          payloadJsonTemplate: '{"invoiceNumber":"{invoiceNumber}"}',
          signatureAlgorithm: "hmac-sha256",
        },
        bodySizeBytes: 128,
      }),
    ).not.toThrow();
  });
});

describe("validateRenderInput", () => {
  it("returns ok=true when required vars present + correct types", () => {
    const r = validateRenderInput(baseEmailTemplate, {
      variables: { invoiceNumber: "INV-2026-001" },
      locale: "en-US",
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("reports missing required variables", () => {
    const r = validateRenderInput(baseEmailTemplate, {
      variables: {},
      locale: "en-US",
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("invoiceNumber");
  });

  it("reports type mismatches", () => {
    const r = validateRenderInput(baseEmailTemplate, {
      variables: { invoiceNumber: 12345 },
      locale: "en-US",
    });
    expect(r.ok).toBe(false);
    expect(r.typeMismatches[0]).toContain("invoiceNumber");
  });

  it("reports extra variables not declared in template", () => {
    const r = validateRenderInput(baseEmailTemplate, {
      variables: { invoiceNumber: "INV-1", surplus: "x" },
      locale: "en-US",
    });
    expect(r.extra).toEqual(["surplus"]);
  });

  it("validates date type via Date.parse", () => {
    const dateTemplate: NotificationTemplate = {
      ...baseEmailTemplate,
      id: "ntpl_dateexpire",
      variables: [
        {
          name: "expiresAt",
          type: "date",
          required: true,
          redactInLogs: false,
        },
      ],
    };
    expect(
      validateRenderInput(dateTemplate, {
        variables: { expiresAt: "2026-12-01T10:00:00Z" },
        locale: "en-US",
      }).ok,
    ).toBe(true);
    expect(
      validateRenderInput(dateTemplate, {
        variables: { expiresAt: "not-a-date" },
        locale: "en-US",
      }).ok,
    ).toBe(false);
  });

  it("validates url type via URL parse", () => {
    const urlTemplate: NotificationTemplate = {
      ...baseEmailTemplate,
      id: "ntpl_resetlink",
      variables: [
        { name: "link", type: "url", required: true, redactInLogs: false },
      ],
    };
    expect(
      validateRenderInput(urlTemplate, {
        variables: { link: "https://acme.com/reset?token=x" },
        locale: "en-US",
      }).ok,
    ).toBe(true);
    expect(
      validateRenderInput(urlTemplate, {
        variables: { link: "not a url" },
        locale: "en-US",
      }).ok,
    ).toBe(false);
  });

  it("validates currency must be cents-quantized", () => {
    const currencyTemplate: NotificationTemplate = {
      ...baseEmailTemplate,
      id: "ntpl_amount001",
      variables: [
        {
          name: "amount",
          type: "currency",
          required: true,
          redactInLogs: false,
        },
      ],
    };
    expect(
      validateRenderInput(currencyTemplate, {
        variables: { amount: 19.99 },
        locale: "en-US",
      }).ok,
    ).toBe(true);
    expect(
      validateRenderInput(currencyTemplate, {
        variables: { amount: 19.995 },
        locale: "en-US",
      }).ok,
    ).toBe(false);
  });
});
