import { describe, expect, it } from "vitest";
import {
  CHANNEL_CAPABILITIES,
  EMAIL_PROVIDERS,
  NOTIFICATION_CHANNELS,
  PROVIDERS_BY_CHANNEL,
  PROVIDER_KINDS,
  ProviderConfigSchema,
  PUSH_PROVIDERS,
  SMS_PROVIDERS,
  VOICE_PROVIDERS,
  computeSmsSegments,
  isSingleSmsSegment,
  isWithinChannelLimits,
  providerSupportsChannel,
  type ProviderConfig,
} from "./channels.js";

const baseEmailProvider: ProviderConfig = {
  id: "prov_email1234",
  tenantId: "11111111-1111-1111-1111-111111111111",
  channel: "email",
  provider: "sendgrid",
  label: "Acme SendGrid",
  enabled: true,
  apiKeySha256: "a".repeat(64),
  endpointUrl: null,
  fromAddress: "noreply@acme.com",
  fromName: "Acme",
  webhookSecretSha256: null,
  rateLimitPerSecond: 100,
  retryMaxAttempts: 3,
  retryInitialBackoffSeconds: 2,
  createdAt: "2026-05-16T10:00:00.000Z",
  createdBy: "22222222-2222-2222-2222-222222222222",
};

describe("constants", () => {
  it("has 6 channels", () => {
    expect(NOTIFICATION_CHANNELS).toHaveLength(6);
  });
  it("has 5 email providers", () => {
    expect(EMAIL_PROVIDERS).toHaveLength(5);
  });
  it("has 5 sms providers", () => {
    expect(SMS_PROVIDERS).toHaveLength(5);
  });
  it("has 4 push providers", () => {
    expect(PUSH_PROVIDERS).toHaveLength(4);
  });
  it("has 2 voice providers", () => {
    expect(VOICE_PROVIDERS).toHaveLength(2);
  });
  it("PROVIDER_KINDS has 18 entries total", () => {
    expect(PROVIDER_KINDS).toHaveLength(18);
  });
});

describe("CHANNEL_CAPABILITIES", () => {
  it("sms requires opt-in", () => {
    expect(CHANNEL_CAPABILITIES.sms.requiresOptIn).toBe(true);
  });
  it("email does not require opt-in (transactional model)", () => {
    expect(CHANNEL_CAPABILITIES.email.requiresOptIn).toBe(false);
  });
  it("sms single segment limit is 160 bytes", () => {
    expect(CHANNEL_CAPABILITIES.sms.singleSegmentBytes).toBe(160);
  });
});

describe("providerSupportsChannel", () => {
  it("sendgrid supports email", () => {
    expect(providerSupportsChannel("sendgrid", "email")).toBe(true);
  });
  it("twilio supports sms but not email", () => {
    expect(providerSupportsChannel("twilio", "sms")).toBe(true);
    expect(providerSupportsChannel("twilio", "email")).toBe(false);
  });
});

describe("PROVIDERS_BY_CHANNEL", () => {
  it("in_app has only in_app_native", () => {
    expect(PROVIDERS_BY_CHANNEL.in_app).toEqual(["in_app_native"]);
  });
  it("webhook has only webhook_http", () => {
    expect(PROVIDERS_BY_CHANNEL.webhook).toEqual(["webhook_http"]);
  });
});

describe("ProviderConfigSchema", () => {
  it("accepts a valid email provider", () => {
    expect(() => ProviderConfigSchema.parse(baseEmailProvider)).not.toThrow();
  });

  it("rejects email without fromAddress", () => {
    expect(() =>
      ProviderConfigSchema.parse({ ...baseEmailProvider, fromAddress: null }),
    ).toThrow(/email provider requires fromAddress/);
  });

  it("rejects provider/channel mismatch (sendgrid on sms)", () => {
    expect(() =>
      ProviderConfigSchema.parse({
        ...baseEmailProvider,
        channel: "sms",
        provider: "sendgrid",
      }),
    ).toThrow(/does not support channel/);
  });

  it("rejects webhook without webhookSecretSha256", () => {
    expect(() =>
      ProviderConfigSchema.parse({
        ...baseEmailProvider,
        channel: "webhook",
        provider: "webhook_http",
        endpointUrl: "https://hooks.acme.com/notify",
        fromAddress: null,
        webhookSecretSha256: null,
      }),
    ).toThrow(/webhookSecretSha256/);
  });

  it("rejects sendgrid without apiKeySha256", () => {
    expect(() =>
      ProviderConfigSchema.parse({ ...baseEmailProvider, apiKeySha256: null }),
    ).toThrow(/apiKeySha256/);
  });
});

describe("isWithinChannelLimits", () => {
  it("returns true within sms limit", () => {
    expect(isWithinChannelLimits("sms", 100)).toBe(true);
  });
  it("returns false past sms limit", () => {
    expect(isWithinChannelLimits("sms", 2000)).toBe(false);
  });
});

describe("computeSmsSegments", () => {
  it("returns 0 for empty body", () => {
    expect(computeSmsSegments(0)).toBe(0);
  });
  it("returns 1 within single segment", () => {
    expect(computeSmsSegments(100)).toBe(1);
    expect(computeSmsSegments(160)).toBe(1);
  });
  it("returns 2 for ~300 bytes (multi-part)", () => {
    expect(computeSmsSegments(300)).toBe(2);
  });
  it("returns 4 for 460 bytes (3 × 153 + remainder)", () => {
    expect(computeSmsSegments(460)).toBe(4);
  });
});

describe("isSingleSmsSegment", () => {
  it("true at 160 bytes", () => {
    expect(isSingleSmsSegment(160)).toBe(true);
  });
  it("false at 161 bytes", () => {
    expect(isSingleSmsSegment(161)).toBe(false);
  });
});
