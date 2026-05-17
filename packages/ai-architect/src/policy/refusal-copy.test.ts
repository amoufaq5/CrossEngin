import { describe, expect, it } from "vitest";
import {
  extractPlaceholders,
  findTemplate,
  formatRefusalMessage,
  RefusalTemplateSchema,
  TemplateRegistrySchema,
} from "./refusal-copy.js";

const now = "2026-05-13T10:00:00.000Z";

describe("RefusalTemplateSchema", () => {
  it("parses a template with allow-listed placeholders", () => {
    expect(() =>
      RefusalTemplateSchema.parse({
        id: "reduce_retention_en",
        refusal: "reduce_audit_retention_below_pack_minimum",
        locale: "en",
        title: "Reducing retention to {retentionYears} years is forbidden",
        body: "Pack '{packId}' requires a minimum retention. See {citation}.",
        citation: "21 CFR §11.10(e)",
      }),
    ).not.toThrow();
  });

  it("rejects placeholders not in the allowlist", () => {
    expect(() =>
      RefusalTemplateSchema.parse({
        id: "bad_template",
        refusal: "grant_cross_tenant_access",
        locale: "en",
        title: "{notInAllowlist}",
        body: "x",
        citation: "x",
      }),
    ).toThrow(/not in the allowlist/);
  });
});

describe("extractPlaceholders", () => {
  it("dedupes repeated placeholders", () => {
    expect(extractPlaceholders("Hello {userName}, {userName}!")).toEqual(["userName"]);
  });
});

describe("formatRefusalMessage", () => {
  const template = RefusalTemplateSchema.parse({
    id: "reduce_retention_en",
    refusal: "reduce_audit_retention_below_pack_minimum",
    locale: "en",
    title: "Retention {retentionYears}y refused",
    body: "Pack {packId} requires a minimum. See {citation}.",
    citation: "21 CFR §11.10(e)",
  });

  it("substitutes provided params", () => {
    const r = formatRefusalMessage({
      template,
      params: {
        retentionYears: "3",
        packId: "21-cfr-part-11",
        citation: "21 CFR §11.10(e)",
      },
    });
    expect(r.title).toBe("Retention 3y refused");
    expect(r.body).toBe("Pack 21-cfr-part-11 requires a minimum. See 21 CFR §11.10(e).");
  });

  it("throws when a required placeholder is missing", () => {
    expect(() =>
      formatRefusalMessage({
        template,
        params: { retentionYears: "3" },
      }),
    ).toThrow(/missing required placeholder 'packId'/);
  });
});

describe("TemplateRegistrySchema + findTemplate", () => {
  const registry = TemplateRegistrySchema.parse([
    {
      id: "ct_en",
      refusal: "grant_cross_tenant_access",
      locale: "en",
      title: "Cross-tenant access forbidden",
      body: "See {citation}.",
      citation: "ADR-0002",
    },
    {
      id: "ct_ar",
      refusal: "grant_cross_tenant_access",
      locale: "ar",
      title: "ممنوع الوصول عبر المستأجرين",
      body: "انظر {citation}.",
      citation: "ADR-0002",
    },
  ]);

  it("findTemplate returns exact-locale match", () => {
    const t = findTemplate(registry, "grant_cross_tenant_access", "ar");
    expect(t?.id).toBe("ct_ar");
  });

  it("findTemplate falls back to default locale when missing", () => {
    const t = findTemplate(registry, "grant_cross_tenant_access", "fr", "en");
    expect(t?.id).toBe("ct_en");
  });

  it("findTemplate returns null when no template matches the refusal", () => {
    expect(findTemplate(registry, "disable_cost_telemetry", "en")).toBeNull();
  });

  it("rejects duplicate template ids", () => {
    expect(() =>
      TemplateRegistrySchema.parse([
        {
          id: "dup",
          refusal: "grant_cross_tenant_access",
          locale: "en",
          title: "x",
          body: "x",
          citation: "x",
          reviewedAt: now,
        },
        {
          id: "dup",
          refusal: "disable_audit_log_globally",
          locale: "en",
          title: "x",
          body: "x",
          citation: "x",
        },
      ]),
    ).toThrow(/duplicate template id/);
  });

  it("rejects two templates for the same (refusal, locale)", () => {
    expect(() =>
      TemplateRegistrySchema.parse([
        {
          id: "a",
          refusal: "grant_cross_tenant_access",
          locale: "en",
          title: "x",
          body: "x",
          citation: "x",
        },
        {
          id: "b",
          refusal: "grant_cross_tenant_access",
          locale: "en",
          title: "y",
          body: "y",
          citation: "y",
        },
      ]),
    ).toThrow(/already has a template for locale/);
  });
});
