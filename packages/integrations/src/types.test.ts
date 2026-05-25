import { describe, expect, it } from "vitest";
import {
  INTEGRATION_KINDS,
  IntegrationAuthSchema,
  IntegrationDeclarationSchema,
  Iso8601DurationSchema,
  RateLimitSchema,
  TransformationSchema,
  VaultReferenceSchema,
} from "./types.js";

describe("INTEGRATION_KINDS", () => {
  it("contains all 12 v1 kinds", () => {
    expect(INTEGRATION_KINDS).toEqual([
      "outbound.http",
      "outbound.graphql",
      "outbound.hl7",
      "outbound.fhir",
      "outbound.edi",
      "outbound.sftp",
      "outbound.webhook",
      "inbound.webhook",
      "inbound.hl7",
      "inbound.fhir",
      "inbound.edi",
      "inbound.sftp",
    ]);
  });
});

describe("VaultReferenceSchema", () => {
  it("parses a vault path", () => {
    expect(VaultReferenceSchema.parse({ vault: "stripe.secretKey" })).toEqual({
      vault: "stripe.secretKey",
    });
  });

  it("rejects empty vault path", () => {
    expect(() => VaultReferenceSchema.parse({ vault: "" })).toThrow();
  });
});

describe("RateLimitSchema", () => {
  it.each(["60/min", "100/sec", "1000/hour", "10000/day"])("accepts %s", (rl) => {
    expect(RateLimitSchema.parse(rl)).toBe(rl);
  });

  it("rejects malformed rate limits", () => {
    expect(() => RateLimitSchema.parse("60 per minute")).toThrow();
    expect(() => RateLimitSchema.parse("60/")).toThrow();
    expect(() => RateLimitSchema.parse("/min")).toThrow();
    expect(() => RateLimitSchema.parse("60/year")).toThrow();
  });
});

describe("Iso8601DurationSchema", () => {
  it.each(["PT4H", "PT5M", "P28D", "P1Y", "PT24H", "P7D"])("accepts %s", (d) => {
    expect(Iso8601DurationSchema.parse(d)).toBe(d);
  });

  it("rejects malformed durations", () => {
    expect(() => Iso8601DurationSchema.parse("4 hours")).toThrow();
    expect(() => Iso8601DurationSchema.parse("PT")).toThrow();
  });
});

describe("IntegrationAuthSchema — all 8 methods", () => {
  it("parses none", () => {
    expect(IntegrationAuthSchema.parse({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("parses apiKey", () => {
    expect(() =>
      IntegrationAuthSchema.parse({
        kind: "apiKey",
        in: "header",
        name: "X-API-Key",
        value: { vault: "x.key" },
      }),
    ).not.toThrow();
  });

  it("parses bearer", () => {
    expect(() =>
      IntegrationAuthSchema.parse({
        kind: "bearer",
        token: { vault: "stripe.secretKey" },
      }),
    ).not.toThrow();
  });

  it("parses basic with username string + password vault ref", () => {
    expect(() =>
      IntegrationAuthSchema.parse({
        kind: "basic",
        username: "admin",
        password: { vault: "smtp.password" },
      }),
    ).not.toThrow();
  });

  it("parses oauth2.clientCredentials", () => {
    expect(() =>
      IntegrationAuthSchema.parse({
        kind: "oauth2.clientCredentials",
        tokenUrl: "https://auth.example.com/oauth/token",
        clientId: { vault: "x.clientId" },
        clientSecret: { vault: "x.clientSecret" },
        scope: "read write",
      }),
    ).not.toThrow();
  });

  it("parses oauth2.authorizationCode", () => {
    expect(() =>
      IntegrationAuthSchema.parse({
        kind: "oauth2.authorizationCode",
        authorizationUrl: "https://example.com/auth",
        tokenUrl: "https://example.com/token",
        clientId: { vault: "x.clientId" },
        clientSecret: { vault: "x.clientSecret" },
      }),
    ).not.toThrow();
  });

  it("parses mtls", () => {
    expect(() =>
      IntegrationAuthSchema.parse({
        kind: "mtls",
        ca: { vault: "lab.ca" },
        clientCert: { vault: "lab.cert" },
        clientKey: { vault: "lab.key" },
      }),
    ).not.toThrow();
  });

  it("parses hmac", () => {
    expect(() =>
      IntegrationAuthSchema.parse({
        kind: "hmac",
        secret: { vault: "twilio.secret" },
        algorithm: "sha256",
      }),
    ).not.toThrow();
  });

  it("rejects unknown auth kind", () => {
    expect(() => IntegrationAuthSchema.parse({ kind: "magic" })).toThrow();
  });
});

describe("TransformationSchema", () => {
  it("parses a declarative transform", () => {
    expect(() =>
      TransformationSchema.parse({
        kind: "declarative",
        spec: {
          drugId: "$response.data[0].setid",
          brandName: "$response.data[0].title",
        },
      }),
    ).not.toThrow();
  });

  it("parses a named transform", () => {
    expect(() =>
      TransformationSchema.parse({
        kind: "named",
        name: "drugFormularyResponse",
      }),
    ).not.toThrow();
  });
});

describe("IntegrationDeclarationSchema — outbound.http", () => {
  it("parses the DailyMed example", () => {
    const integration = {
      kind: "outbound.http" as const,
      label: { en: "DailyMed Drug Formulary" },
      auth: { kind: "none" as const },
      endpoint: "https://dailymed.nlm.nih.gov/dailymed/services/v2",
      rateLimit: "60/min",
      operations: [
        {
          name: "lookupDrug",
          method: "GET" as const,
          path: "/spls.json",
          query: { drug_name: "$input.name" },
          responseTransform: "drugFormularyResponse",
          cacheTtl: "PT24H",
        },
      ],
    };
    expect(() => IntegrationDeclarationSchema.parse(integration)).not.toThrow();
  });

  it("rejects outbound.http with non-URL endpoint", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "outbound.http",
        auth: { kind: "none" },
        endpoint: "not-a-url",
        operations: [{ name: "x", method: "GET", path: "/" }],
      }),
    ).toThrow();
  });

  it("rejects outbound.http with empty operations", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "outbound.http",
        auth: { kind: "none" },
        endpoint: "https://api.example.com",
        operations: [],
      }),
    ).toThrow();
  });
});

describe("IntegrationDeclarationSchema — inbound.webhook", () => {
  it("parses with HMAC verification", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "inbound.webhook",
        label: { en: "Stripe webhook" },
        endpoint: "/api/integrations/webhooks/stripe",
        verification: {
          kind: "hmac",
          header: "Stripe-Signature",
          secret: { vault: "stripe.webhookSecret" },
          algorithm: "sha256",
          tolerance: "PT5M",
        },
      }),
    ).not.toThrow();
  });

  it("parses with no verification (explicit opt-in)", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "inbound.webhook",
        endpoint: "/api/integrations/webhooks/unsigned",
        verification: { kind: "none" },
      }),
    ).not.toThrow();
  });

  it("rejects endpoint that is not a path", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "inbound.webhook",
        endpoint: "https://example.com/hook",
        verification: { kind: "none" },
      }),
    ).toThrow();
  });
});

describe("IntegrationDeclarationSchema — outbound.webhook", () => {
  it("parses with multiple event subscriptions", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "outbound.webhook",
        subscriptions: [
          {
            events: ["prescription.verified", "prescription.dispensed"],
            endpoint: "https://customer.example.com/crossengin-webhook",
            secret: { vault: "customer.webhookSecret" },
            retries: "exponential",
            deadLetter: "log",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects subscription with empty events", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "outbound.webhook",
        subscriptions: [
          {
            events: [],
            endpoint: "https://customer.example.com/hook",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("IntegrationDeclarationSchema — outbound.edi", () => {
  it("parses the MoH claims example", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "outbound.edi",
        label: { en: "MoH Claims (X12 837)" },
        transport: {
          kind: "sftp",
          host: "claims.moh.gov.ae",
          credentials: { vault: "moh.sftpCredentials" },
        },
        format: "x12",
        transactionSets: ["837", "835", "270/271"],
        schedule: "0 18 * * 1-5 Asia/Dubai",
        transform: "claimsToX12",
      }),
    ).not.toThrow();
  });
});

describe("IntegrationDeclarationSchema — outbound.hl7", () => {
  it("parses an HL7 send integration", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "outbound.hl7",
        auth: { kind: "mtls", clientCert: { vault: "hl7.cert" }, clientKey: { vault: "hl7.key" } },
        endpoint: "hl7.lab.example.com:2575",
        messageTypes: ["ORM^O01"],
      }),
    ).not.toThrow();
  });
});

describe("IntegrationDeclarationSchema — inbound.hl7", () => {
  it("parses the labResults example", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "inbound.hl7",
        label: { en: "Lab Results (HL7)" },
        endpoint: "/api/integrations/hl7/inbound",
        messageTypes: ["ORU^R01"],
        auth: { kind: "mtls", clientCert: { vault: "lab.cert" }, clientKey: { vault: "lab.key" } },
        transform: "labResultsToManifest",
        idempotencyKey: "$message.MSH-10",
      }),
    ).not.toThrow();
  });
});

describe("IntegrationDeclarationSchema — inbound.fhir", () => {
  it("parses with R4 + resource filter", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "inbound.fhir",
        endpoint: "/api/integrations/fhir/t1",
        fhirVersion: "R4",
        resourceTypes: ["Patient", "Observation"],
      }),
    ).not.toThrow();
  });
});

describe("IntegrationDeclarationSchema — inbound.sftp", () => {
  it("parses with polling schedule", () => {
    expect(() =>
      IntegrationDeclarationSchema.parse({
        kind: "inbound.sftp",
        transport: {
          kind: "sftp",
          host: "files.example.com",
          credentials: { vault: "files.creds" },
        },
        pollSchedule: "*/5 * * * *",
      }),
    ).not.toThrow();
  });
});

describe("IntegrationDeclarationSchema — discriminator", () => {
  it("rejects an unknown kind", () => {
    expect(() => IntegrationDeclarationSchema.parse({ kind: "outbound.morse" })).toThrow();
  });
});
