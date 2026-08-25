import { describe, expect, it } from "vitest";
import {
  CONTENT_CATEGORIES,
  NotificationTemplateSchema,
  TEMPLATE_STATUSES,
  TEMPLATE_TRANSITIONS,
  VARIABLE_TYPES,
  canTransitionTemplate,
  isCategorySuppressible,
  renderTemplateContent,
  renderedSizeBytes,
  requiresExplicitOptIn,
  templatePlaceholders,
  validateRenderInput,
  type NotificationTemplate,
  type TemplateContent,
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

const ctx = (
  variables: Readonly<Record<string, unknown>>,
  locale = "en-US",
): { variables: Readonly<Record<string, unknown>>; locale: string } => ({
  variables,
  locale,
});

const emailContent = (over: Partial<Extract<TemplateContent, { channel: "email" }>> = {}): TemplateContent => ({
  channel: "email",
  subject: "Hello {{firstName}}",
  htmlBody: "<p>Hello {{firstName}}</p>",
  plaintextBody: "Hello {{firstName}}",
  ...over,
});

const inAppContent = (
  over: Partial<Extract<TemplateContent, { channel: "in_app" }>> = {},
): TemplateContent => ({
  channel: "in_app",
  title: "Notice for {{firstName}}",
  htmlBody: "<div>{{message}}</div>",
  severity: "warning",
  ...over,
});

const webhookContent = (payloadJsonTemplate: string): TemplateContent => ({
  channel: "webhook",
  eventName: "invoice.paid",
  payloadJsonTemplate,
  signatureAlgorithm: "hmac-sha256",
});

const voiceContent = (
  ssmlBody: string,
  fallbackTextBody: string,
): TemplateContent => ({
  channel: "voice_call",
  ssmlBody,
  fallbackTextBody,
  voice: "polly_joanna",
});

describe("renderTemplateContent — channel mapping", () => {
  it("renders email: subject → title, htmlBody → body, plaintextBody → plainBody", () => {
    const { rendered, missing } = renderTemplateContent(
      emailContent(),
      ctx({ firstName: "Ada" }),
    );
    expect(rendered).toEqual({
      channel: "email",
      title: "Hello Ada",
      body: "<p>Hello Ada</p>",
      plainBody: "Hello Ada",
      severity: null,
    });
    expect(missing).toEqual([]);
  });

  it("renders sms: empty title, no plainBody", () => {
    const { rendered } = renderTemplateContent(
      { channel: "sms", body: "Your code is {{code}}" },
      ctx({ code: "884210" }),
    );
    expect(rendered.title).toBe("");
    expect(rendered.body).toBe("Your code is 884210");
    expect(rendered.plainBody).toBeNull();
    expect(rendered.severity).toBeNull();
  });

  it("renders push_mobile: title + body, no plainBody", () => {
    const { rendered } = renderTemplateContent(
      {
        channel: "push_mobile",
        title: "Order {{orderId}}",
        body: "Shipped to {{city}}",
        deepLink: "https://acme.test/orders/{{orderId}}",
      },
      ctx({ orderId: "A-91", city: "Dubai" }),
    );
    expect(rendered.title).toBe("Order A-91");
    expect(rendered.body).toBe("Shipped to Dubai");
    expect(rendered.plainBody).toBeNull();
  });

  it("renders in_app: htmlBody → body and surfaces severity", () => {
    const { rendered } = renderTemplateContent(
      inAppContent(),
      ctx({ firstName: "Ada", message: "disk almost full" }),
    );
    expect(rendered.title).toBe("Notice for Ada");
    expect(rendered.body).toBe("<div>disk almost full</div>");
    expect(rendered.plainBody).toBeNull();
    expect(rendered.severity).toBe("warning");
  });

  it("renders webhook: eventName → title, payload template → body", () => {
    const { rendered } = renderTemplateContent(
      webhookContent('{"invoice":"{{invoiceNumber}}"}'),
      ctx({ invoiceNumber: "INV-7" }),
    );
    expect(rendered.title).toBe("invoice.paid");
    expect(rendered.body).toBe('{"invoice":"INV-7"}');
    expect(rendered.severity).toBeNull();
  });

  it("renders voice_call: ssmlBody → body, fallbackTextBody → plainBody", () => {
    const { rendered } = renderTemplateContent(
      voiceContent(
        "<speak>Hello {{firstName}}</speak>",
        "Hello {{firstName}}",
      ),
      ctx({ firstName: "Ada" }),
    );
    expect(rendered.title).toBe("");
    expect(rendered.body).toBe("<speak>Hello Ada</speak>");
    expect(rendered.plainBody).toBe("Hello Ada");
  });
});

describe("renderTemplateContent — placeholder syntax", () => {
  it("tolerates whitespace inside the braces", () => {
    const { rendered, missing } = renderTemplateContent(
      { channel: "sms", body: "Hi {{  firstName  }}!" },
      ctx({ firstName: "Ada" }),
    );
    expect(rendered.body).toBe("Hi Ada!");
    expect(missing).toEqual([]);
  });

  it("leaves single-brace text literal", () => {
    const { rendered, missing } = renderTemplateContent(
      { channel: "sms", body: "Hi {firstName}" },
      ctx({ firstName: "Ada" }),
    );
    expect(rendered.body).toBe("Hi {firstName}");
    expect(missing).toEqual([]);
  });

  it("leaves names that do not match the variable pattern literal", () => {
    const { rendered, missing } = renderTemplateContent(
      { channel: "sms", body: "{{First}} {{1st}} {{first-name}} {{}}" },
      ctx({}),
    );
    expect(rendered.body).toBe("{{First}} {{1st}} {{first-name}} {{}}");
    expect(missing).toEqual([]);
  });

  it("substitutes every occurrence of a repeated placeholder", () => {
    const { rendered } = renderTemplateContent(
      { channel: "sms", body: "{{code}}-{{code}}-{{ code }}" },
      ctx({ code: "77" }),
    );
    expect(rendered.body).toBe("77-77-77");
  });
});

describe("renderTemplateContent — value formatting", () => {
  it("renders a string value as-is", () => {
    const { rendered } = renderTemplateContent(
      { channel: "sms", body: "{{v}}" },
      ctx({ v: "  spaced  " }),
    );
    expect(rendered.body).toBe("  spaced  ");
  });

  it("formats a finite number with the context locale (en-US)", () => {
    const { rendered } = renderTemplateContent(
      { channel: "sms", body: "{{amount}}" },
      ctx({ amount: 1234567.5 }, "en-US"),
    );
    expect(rendered.body).toBe("1,234,567.5");
  });

  it("formats the same number differently for de-DE", () => {
    const { rendered } = renderTemplateContent(
      { channel: "sms", body: "{{amount}}" },
      ctx({ amount: 1234567.5 }, "de-DE"),
    );
    expect(rendered.body).toBe("1.234.567,5");
  });

  it("formats booleans as true / false", () => {
    const { rendered } = renderTemplateContent(
      { channel: "sms", body: "{{yes}}|{{no}}" },
      ctx({ yes: true, no: false }),
    );
    expect(rendered.body).toBe("true|false");
  });

  it("formats objects and arrays via JSON.stringify", () => {
    const { rendered } = renderTemplateContent(
      { channel: "sms", body: "{{obj}} {{arr}}" },
      ctx({ obj: { a: 1 }, arr: [1, 2] }),
    );
    expect(rendered.body).toBe('{"a":1} [1,2]');
  });
});

describe("renderTemplateContent — missing variables", () => {
  it("renders an absent variable as empty string and reports it", () => {
    const { rendered, missing } = renderTemplateContent(
      { channel: "sms", body: "Hi {{firstName}}!" },
      ctx({}),
    );
    expect(rendered.body).toBe("Hi !");
    expect(rendered.body).not.toContain("{{");
    expect(missing).toEqual(["firstName"]);
  });

  it("counts a null value as missing", () => {
    const { rendered, missing } = renderTemplateContent(
      { channel: "sms", body: "[{{v}}]" },
      ctx({ v: null }),
    );
    expect(rendered.body).toBe("[]");
    expect(missing).toEqual(["v"]);
  });

  it("counts an undefined value as missing", () => {
    const { missing } = renderTemplateContent(
      { channel: "sms", body: "[{{v}}]" },
      ctx({ v: undefined }),
    );
    expect(missing).toEqual(["v"]);
  });

  it("dedupes and sorts missing names across fields", () => {
    const { missing } = renderTemplateContent(
      emailContent({
        subject: "{{zeta}} {{alpha}}",
        htmlBody: "<p>{{alpha}}</p>",
        plaintextBody: "{{alpha}} {{mid}}",
      }),
      ctx({}),
    );
    expect(missing).toEqual(["alpha", "mid", "zeta"]);
  });

  it("reports placeholders from optional email fields that never surface", () => {
    const { rendered, missing } = renderTemplateContent(
      emailContent({
        subject: "static",
        htmlBody: "<p>static</p>",
        plaintextBody: "static",
        preheader: "{{preheaderVar}}",
        fromName: "{{fromVar}}",
      }),
      ctx({}),
    );
    expect(missing).toEqual(["fromVar", "preheaderVar"]);
    expect(rendered.title).toBe("static");
  });

  it("returns an empty missing list for a template with no placeholders", () => {
    const { missing } = renderTemplateContent(
      { channel: "sms", body: "static text" },
      ctx({}),
    );
    expect(missing).toEqual([]);
  });

  it("does not throw on any value type", () => {
    expect(() =>
      renderTemplateContent(
        { channel: "sms", body: "{{v}}" },
        ctx({ v: Symbol("x") }),
      ),
    ).not.toThrow();
  });
});

describe("renderTemplateContent — HTML escaping invariant", () => {
  it("escapes a script payload in an email html body", () => {
    const { rendered } = renderTemplateContent(
      emailContent({
        htmlBody: "<p>{{firstName}}</p>",
        plaintextBody: "{{firstName}}",
      }),
      ctx({ firstName: "<script>alert(1)</script>" }),
    );
    expect(rendered.body).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("leaves the same payload verbatim in the plaintext body", () => {
    const { rendered } = renderTemplateContent(
      emailContent({
        htmlBody: "<p>{{firstName}}</p>",
        plaintextBody: "{{firstName}}",
      }),
      ctx({ firstName: "<script>alert(1)</script>" }),
    );
    expect(rendered.plainBody).toBe("<script>alert(1)</script>");
  });

  it("escapes an in_app html body (stored XSS vector)", () => {
    const { rendered } = renderTemplateContent(
      inAppContent({ title: "t", htmlBody: "<div>{{message}}</div>" }),
      ctx({ message: '<img src=x onerror="alert(1)">' }),
    );
    expect(rendered.body).toBe(
      "<div>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</div>",
    );
  });

  it("escapes the ampersand first — no double escaping", () => {
    const { rendered } = renderTemplateContent(
      emailContent({ htmlBody: "<p>{{firstName}}</p>" }),
      ctx({ firstName: "Ben & Jerry's <b>" }),
    );
    expect(rendered.body).toBe("<p>Ben &amp; Jerry&#39;s &lt;b&gt;</p>");
    expect(rendered.body).not.toContain("&amp;amp;");
    expect(rendered.body).not.toContain("&amp;lt;");
  });

  it("does not escape the template's own markup, only substituted values", () => {
    const { rendered } = renderTemplateContent(
      inAppContent({ htmlBody: '<a href="/x">{{message}}</a>' }),
      ctx({ message: "safe" }),
    );
    expect(rendered.body).toBe('<a href="/x">safe</a>');
  });

  it("does not escape a value substituted into a plain title field", () => {
    const { rendered } = renderTemplateContent(
      inAppContent({ title: "{{firstName}}" }),
      ctx({ firstName: "<b>Ada</b>", message: "m" }),
    );
    expect(rendered.title).toBe("<b>Ada</b>");
  });
});

describe("renderTemplateContent — JSON escaping invariant", () => {
  it("JSON-escapes a double quote so the payload stays parseable", () => {
    const { rendered } = renderTemplateContent(
      webhookContent('{"note":"{{note}}"}'),
      ctx({ note: 'He said "hi"' }),
    );
    expect(rendered.body).toBe('{"note":"He said \\"hi\\""}');
    expect(JSON.parse(rendered.body)).toEqual({ note: 'He said "hi"' });
  });

  it("JSON-escapes a backslash", () => {
    const { rendered } = renderTemplateContent(
      webhookContent('{"path":"{{path}}"}'),
      ctx({ path: "C:\\temp\\x" }),
    );
    expect(JSON.parse(rendered.body)).toEqual({ path: "C:\\temp\\x" });
  });

  it("does not HTML-escape a webhook payload value", () => {
    const { rendered } = renderTemplateContent(
      webhookContent('{"note":"{{note}}"}'),
      ctx({ note: "a < b & c" }),
    );
    expect(JSON.parse(rendered.body)).toEqual({ note: "a < b & c" });
    expect(rendered.body).not.toContain("&amp;");
  });
});

describe("renderTemplateContent — SSML escaping", () => {
  it("escapes a value substituted into ssml (XML) but not the fallback text", () => {
    const { rendered } = renderTemplateContent(
      voiceContent("<speak>{{note}}</speak>", "{{note}}"),
      ctx({ note: "Tom & <Jerry>" }),
    );
    expect(rendered.body).toBe("<speak>Tom &amp; &lt;Jerry&gt;</speak>");
    expect(rendered.plainBody).toBe("Tom & <Jerry>");
  });
});

describe("templatePlaceholders", () => {
  it("dedupes and sorts names across every content field", () => {
    expect(
      templatePlaceholders(
        emailContent({
          subject: "{{zeta}}",
          htmlBody: "<p>{{alpha}} {{zeta}}</p>",
          plaintextBody: "{{alpha}}",
          preheader: "{{mid}}",
        }),
      ),
    ).toEqual(["alpha", "mid", "zeta"]);
  });

  it("returns an empty list when there are no placeholders", () => {
    expect(
      templatePlaceholders({ channel: "sms", body: "no vars here" }),
    ).toEqual([]);
  });

  it("covers webhook eventName and payload template", () => {
    expect(
      templatePlaceholders(
        webhookContent('{"a":"{{beta}}","b":"{{alpha}}"}'),
      ),
    ).toEqual(["alpha", "beta"]);
  });

  it("covers both voice_call bodies", () => {
    expect(
      templatePlaceholders(
        voiceContent("<speak>{{ssmlVar}}</speak>", "{{fallbackVar}}"),
      ),
    ).toEqual(["fallbackVar", "ssmlVar"]);
  });
});

describe("renderedSizeBytes", () => {
  it("sums title + body + plainBody for ASCII", () => {
    const { rendered } = renderTemplateContent(
      emailContent({
        subject: "abc",
        htmlBody: "de",
        plaintextBody: "f",
      }),
      ctx({}),
    );
    expect(renderedSizeBytes(rendered)).toBe(6);
  });

  it("counts multi-byte characters by UTF-8 length", () => {
    const { rendered } = renderTemplateContent(
      { channel: "sms", body: "é😀" },
      ctx({}),
    );
    expect(renderedSizeBytes(rendered)).toBe(6);
  });

  it("treats a null plainBody as empty", () => {
    const { rendered } = renderTemplateContent(
      { channel: "sms", body: "12345" },
      ctx({}),
    );
    expect(rendered.plainBody).toBeNull();
    expect(renderedSizeBytes(rendered)).toBe(5);
  });
});

describe("renderTemplateContent — round trip with a real template", () => {
  it("leaves missing empty when every declared variable resolves", () => {
    const template: NotificationTemplate = {
      ...baseEmailTemplate,
      content: {
        channel: "email",
        subject: "Invoice {{invoiceNumber}} paid",
        htmlBody: "<p>Thanks for paying invoice {{invoiceNumber}}.</p>",
        plaintextBody: "Thanks for paying invoice {{invoiceNumber}}.",
      },
    };
    const context = ctx({ invoiceNumber: "INV-2026-001" });
    expect(validateRenderInput(template, context).ok).toBe(true);
    expect(templatePlaceholders(template.content)).toEqual(
      template.variables.map((v) => v.name),
    );

    const { rendered, missing } = renderTemplateContent(
      template.content,
      context,
    );
    expect(missing).toEqual([]);
    expect(rendered.title).toBe("Invoice INV-2026-001 paid");
    expect(rendered.body).toBe(
      "<p>Thanks for paying invoice INV-2026-001.</p>",
    );
    expect(rendered.plainBody).toBe("Thanks for paying invoice INV-2026-001.");
    expect(renderedSizeBytes(rendered)).toBeLessThan(5_000_000);
  });
});
