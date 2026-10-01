import { describe, expect, it } from "vitest";

import { buildSenderRegistryFromEnv } from "./delivery-senders-env.js";

const SES: NodeJS.ProcessEnv = {
  SES_REGION: "eu-west-1",
  SES_FROM_ADDRESS: "notices@example.com",
  SES_CONFIGURATION_SET: "crossengin-events",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  // 40 characters, as a real one is: the sender refuses a secret too short to derive a signing key
  // from, so a toy value here would test the refusal path and call it success.
  AWS_SECRET_ACCESS_KEY: "0123456789abcdefghij0123456789abcdefghij",
};

const TWILIO: NodeJS.ProcessEnv = {
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_API_KEY_SID: "SK00000000000000000000000000000000",
  TWILIO_API_KEY_SECRET: "shh",
  TWILIO_FROM_NUMBER: "+15555550100",
  TWILIO_STATUS_CALLBACK_URL: "https://api.example.com/v1/notifications/bounces",
};

describe("buildSenderRegistryFromEnv", () => {
  it("registers in_app with no configuration at all", () => {
    // The default deployment wants only in-app notices, and an empty registry would make every
    // delivery unroutable rather than merely the unconfigured channels.
    const { registry, report } = buildSenderRegistryFromEnv({});
    expect(registry.for("in_app")).not.toBeNull();
    expect(report.channels).toEqual(["in_app"]);
    expect(report.skipped).toEqual([]);
  });

  it("registers email once SES is fully configured", () => {
    const { registry, report } = buildSenderRegistryFromEnv({ ...SES });
    expect(registry.for("email")?.channel).toBe("email");
    expect(report.channels).toContain("email");
  });

  it("registers sms once Twilio is fully configured", () => {
    const { registry, report } = buildSenderRegistryFromEnv({ ...TWILIO });
    expect(registry.for("sms")?.channel).toBe("sms");
    expect(report.channels).toContain("sms");
  });

  it("registers both together", () => {
    const { report } = buildSenderRegistryFromEnv({ ...SES, ...TWILIO });
    expect([...report.channels].sort()).toEqual(["email", "in_app", "sms"]);
  });

  it("says nothing about a channel nobody tried to configure", () => {
    // Silence is the right answer for a deployment that only wants in-app; a warning per unused
    // provider would train an operator to ignore the ones that matter.
    const { report } = buildSenderRegistryFromEnv({ ...SES });
    expect(report.skipped.some((s) => s.startsWith("sms"))).toBe(false);
  });

  it("warns about a channel configured halfway rather than guessing", () => {
    // Sending nothing while looking healthy is the failure this exists to make loud.
    const { registry, report } = buildSenderRegistryFromEnv({
      SES_REGION: "eu-west-1",
      SES_FROM_ADDRESS: "notices@example.com",
    });
    expect(registry.for("email")).toBeNull();
    expect(report.skipped.some((s) => s.includes("AWS_SECRET_ACCESS_KEY"))).toBe(true);
  });

  it("warns when SES has no configuration set, because no bounce can then arrive", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...SES,
      SES_CONFIGURATION_SET: undefined,
    });
    expect(registry.for("email")).not.toBeNull();
    expect(report.skipped.some((s) => s.includes("SES_CONFIGURATION_SET"))).toBe(true);
  });

  it("warns when Twilio has no status callback, for the same reason", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...TWILIO,
      TWILIO_STATUS_CALLBACK_URL: undefined,
    });
    expect(registry.for("sms")).not.toBeNull();
    expect(report.skipped.some((s) => s.includes("TWILIO_STATUS_CALLBACK_URL"))).toBe(true);
  });

  it("accepts an auth token in place of an API key pair", () => {
    const { registry } = buildSenderRegistryFromEnv({
      TWILIO_ACCOUNT_SID: TWILIO["TWILIO_ACCOUNT_SID"],
      TWILIO_AUTH_TOKEN: "root-credential",
      TWILIO_FROM_NUMBER: "+15555550100",
    });
    expect(registry.for("sms")).not.toBeNull();
  });

  it("picks the messaging service when both sender identities are set, rather than crashing", () => {
    // The provider takes exactly one, so passing both through would throw out of boot. Two
    // plausible values are a configuration the operator meant, not a reason to refuse the channel.
    const { registry, report } = buildSenderRegistryFromEnv({
      ...TWILIO,
      TWILIO_MESSAGING_SERVICE_SID: "MG00000000000000000000000000000000",
    });
    expect(registry.for("sms")).not.toBeNull();
    expect(report.skipped.some((s) => s.includes("ignoring the number"))).toBe(true);
  });

  it("costs one channel, not the process, when a provider refuses its options", () => {
    // A credential that cannot sign is a boot-time typo, and taking the API down over it would be a
    // far worse outage than losing email until it is fixed.
    const { registry, report } = buildSenderRegistryFromEnv({
      ...SES,
      ...TWILIO,
      AWS_SECRET_ACCESS_KEY: "too-short",
    });
    expect(registry.for("email")).toBeNull();
    expect(registry.for("sms")).not.toBeNull();
    expect(report.skipped.some((s) => s.includes("refused its configuration"))).toBe(true);
  });

  it("refuses an API key sid with no secret rather than falling back to the auth token", () => {
    // Half a credential pair is a configuration mistake, and silently using the account's root
    // credential instead would be a privilege escalation nobody asked for.
    const { registry, report } = buildSenderRegistryFromEnv({
      TWILIO_ACCOUNT_SID: TWILIO["TWILIO_ACCOUNT_SID"],
      TWILIO_API_KEY_SID: "SK00000000000000000000000000000000",
      TWILIO_FROM_NUMBER: "+15555550100",
    });
    expect(registry.for("sms")).toBeNull();
    expect(report.skipped.some((s) => s.startsWith("sms"))).toBe(true);
  });

  it("accepts a messaging service in place of a from number", () => {
    const { registry } = buildSenderRegistryFromEnv({
      TWILIO_ACCOUNT_SID: TWILIO["TWILIO_ACCOUNT_SID"],
      TWILIO_AUTH_TOKEN: "t",
      TWILIO_MESSAGING_SERVICE_SID: "MG00000000000000000000000000000000",
    });
    expect(registry.for("sms")).not.toBeNull();
  });

  it("refuses Twilio with a credential but no sender identity", () => {
    const { registry } = buildSenderRegistryFromEnv({
      TWILIO_ACCOUNT_SID: TWILIO["TWILIO_ACCOUNT_SID"],
      TWILIO_AUTH_TOKEN: "t",
    });
    expect(registry.for("sms")).toBeNull();
  });

  it("sends to an endpoint override instead of the provider's own host", async () => {
    // The only observable of an override is where the request goes, so stub the global fetch the
    // senders fall back to and assert on the URL. Asserting the sender merely exists would pass
    // whether or not the override reached it.
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
      seen.push(String(input));
      return new Response("{}", { status: 500 });
    }) as typeof globalThis.fetch;
    try {
      const { registry } = buildSenderRegistryFromEnv({
        ...SES,
        ...TWILIO,
        TWILIO_FROM_NUMBER: undefined,
        TWILIO_MESSAGING_SERVICE_SID: "MG00000000000000000000000000000000",
        SES_ENDPOINT_URL: "http://127.0.0.1:9/ses",
        TWILIO_BASE_URL: "http://127.0.0.1:9/twilio",
      });
      const request = {
        dispatchId: "disp_1",
        tenantId: "00000000-0000-0000-0000-000000000001",
        templateId: "ntpl_1",
        locale: "en-US",
        attemptNumber: 1,
      };
      await registry
        .for("email")
        ?.send({ ...request, channel: "email", recipientAddress: "a@example.com" });
      await registry
        .for("sms")
        ?.send({ ...request, channel: "sms", recipientAddress: "+15555550111" });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("127.0.0.1:9/ses");
    expect(seen[1]).toContain("127.0.0.1:9/twilio");
    expect(seen.some((u) => u.includes("amazonaws.com") || u.includes("twilio.com"))).toBe(false);
  });

  it("treats a whitespace-only value as unset", () => {
    // An empty value in a compose file or a secret mount is far more common than a missing key, and
    // passing it through would fail at the provider instead of at boot.
    const { registry } = buildSenderRegistryFromEnv({ ...SES, AWS_SECRET_ACCESS_KEY: "   " });
    expect(registry.for("email")).toBeNull();
  });

  it("leaves an unconfigured channel unroutable rather than absent from the registry", () => {
    const { registry } = buildSenderRegistryFromEnv({});
    expect(registry.for("email")).toBeNull();
    expect(registry.for("sms")).toBeNull();
  });

  it("reports the channels it registered, in the registry's own order", () => {
    const { registry, report } = buildSenderRegistryFromEnv({ ...SES, ...TWILIO });
    expect(report.channels).toEqual(registry.channels());
  });

  it("does not read the ambient process environment when given one", () => {
    // Otherwise a test or a sidecar's stray AWS credentials would silently register a real sender.
    const { registry } = buildSenderRegistryFromEnv({ UNRELATED: "x" });
    expect(registry.channels()).toEqual(["in_app"]);
  });
});
