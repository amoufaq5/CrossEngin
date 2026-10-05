import { generateKeyPairSync } from "node:crypto";
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

/*
 * One real 2048-bit RSA keypair and one EC keypair, generated once for the file rather than pasted
 * as fixtures. Generated because the EC case below is about what OpenSSL says when it decodes the
 * key, and a fixture would also be a committed private key — a thing nobody should have to decide
 * whether to rotate.
 */
const FCM_KEYPAIR = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const FCM_EC_KEYPAIR = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const FCM_CLIENT_EMAIL = "fcm-sender@crossengin-prod.iam.gserviceaccount.com";

function serviceAccountJson(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "crossengin-prod",
    private_key_id: "0123456789abcdef",
    private_key: FCM_KEYPAIR.privateKey,
    client_email: FCM_CLIENT_EMAIL,
    token_uri: "https://oauth2.googleapis.com/token",
    ...overrides,
  });
}

/** The key file verbatim in one variable — the form that cannot produce a mangled PEM. */
const FCM_JSON: NodeJS.ProcessEnv = {
  FCM_PROJECT_ID: "crossengin-prod",
  FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson(),
};

/** The split form, for a deployment that keeps the two fields in separate secrets. */
const FCM_PAIR: NodeJS.ProcessEnv = {
  FCM_PROJECT_ID: "crossengin-prod",
  FCM_SERVICE_ACCOUNT_CLIENT_EMAIL: FCM_CLIENT_EMAIL,
  FCM_SERVICE_ACCOUNT_PRIVATE_KEY: FCM_KEYPAIR.privateKey,
};

/**
 * Every 24-character window of the key's base64 body. A skipped-channel reason containing any one of
 * these has carried part of a private key into the boot log and whatever aggregates it — at which
 * point the key has to be rotated, which is a far worse outcome than the misconfiguration it was
 * reporting.
 */
const FCM_KEY_WINDOWS: readonly string[] = (() => {
  const body = FCM_KEYPAIR.privateKey
    .split("\n")
    .filter((line) => !line.startsWith("-----") && line.length > 0)
    .join("");
  const windows: string[] = [];
  for (let i = 0; i + 24 <= body.length; i += 1) windows.push(body.slice(i, i + 24));
  return windows;
})();

function expectNoKeyMaterial(messages: readonly string[]): void {
  const joined = messages.join("\n");
  const leaked = FCM_KEY_WINDOWS.find((window) => joined.includes(window));
  expect(leaked).toBeUndefined();
}

function fcmSkips(env: NodeJS.ProcessEnv): readonly string[] {
  return buildSenderRegistryFromEnv(env).report.skipped.filter((s) =>
    s.startsWith("push_mobile"),
  );
}

function voiceSkips(env: NodeJS.ProcessEnv): readonly string[] {
  return buildSenderRegistryFromEnv(env).report.skipped.filter((s) =>
    s.startsWith("voice"),
  );
}

/** Voice shares the SMS account and credential and brings its own, voice-capable, caller id. */
const VOICE: NodeJS.ProcessEnv = {
  ...TWILIO,
  TWILIO_VOICE_FROM_NUMBER: "+15555550199",
};

/** Records where requests go and what they carried, for the wiring that is only observable there. */
async function withRecordedFetch(
  respond: (url: string) => Response,
  run: () => Promise<void>,
): Promise<readonly { url: string; authorization: string; metadataFlavor: string }[]> {
  const seen: { url: string; authorization: string; metadataFlavor: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url,
      authorization: headers["authorization"] ?? "",
      metadataFlavor: headers["metadata-flavor"] ?? "",
    });
    return respond(url);
  }) as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

const DISPATCH = {
  dispatchId: "disp_1",
  tenantId: "00000000-0000-0000-0000-000000000001",
  templateId: "ntpl_1",
  locale: "en-US",
  attemptNumber: 1,
} as const;

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

describe("mobile push from the environment (ADR-0327)", () => {
  it("says nothing at all when nobody tried to configure push", () => {
    // Not wanted is not wanted-and-broken. A warning for every unconfigured channel is noise an
    // operator learns to scroll past, which is how the one that matters gets missed.
    const { registry, report } = buildSenderRegistryFromEnv({ ...SES });
    expect(registry.for("push_mobile")).toBeNull();
    expect(report.channels).not.toContain("push_mobile");
    expect(report.skipped.some((s) => s.startsWith("push_mobile"))).toBe(false);
  });

  it("warns when only the project id is set, because the operator has clearly started", () => {
    const skips = fcmSkips({ FCM_PROJECT_ID: "crossengin-prod" });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("FCM_SERVICE_ACCOUNT_JSON");
    expect(skips[0]).toContain("FCM_SERVICE_ACCOUNT_CLIENT_EMAIL");
    expect(skips[0]).toContain("FCM_SERVICE_ACCOUNT_PRIVATE_KEY");
  });

  it("warns when the credential is set but the project id is not", () => {
    // FCM has no sender identity other than the project, so a key with no project cannot send: the
    // half-configured channel has to be loud rather than inferred from the key file's `project_id`.
    const skips = fcmSkips({ FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson() });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("FCM_PROJECT_ID");
  });

  it("registers push_mobile from the verbatim key file, with nothing skipped", () => {
    const { registry, report } = buildSenderRegistryFromEnv({ ...FCM_JSON });
    expect(registry.for("push_mobile")?.channel).toBe("push_mobile");
    expect(report.channels).toContain("push_mobile");
    expect(report.skipped).toEqual([]);
  });

  it("names fcm as the provider behind the channel", () => {
    const { registry } = buildSenderRegistryFromEnv({ ...FCM_JSON });
    expect(registry.for("push_mobile")?.provider).toBe("fcm");
  });

  it("registers push_mobile from the split client-email and private-key pair", () => {
    const { registry, report } = buildSenderRegistryFromEnv({ ...FCM_PAIR });
    expect(registry.for("push_mobile")).not.toBeNull();
    expect(report.skipped).toEqual([]);
  });

  it("refuses the client email half on its own", () => {
    const skips = fcmSkips({
      FCM_PROJECT_ID: "crossengin-prod",
      FCM_SERVICE_ACCOUNT_CLIENT_EMAIL: FCM_CLIENT_EMAIL,
    });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("partial configuration is ignored rather than guessed");
  });

  it("refuses the private key half on its own", () => {
    const skips = fcmSkips({
      FCM_PROJECT_ID: "crossengin-prod",
      FCM_SERVICE_ACCOUNT_PRIVATE_KEY: FCM_KEYPAIR.privateKey,
    });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("FCM_SERVICE_ACCOUNT_CLIENT_EMAIL");
  });

  /*
   * The single most common way this configuration goes wrong: the key file's JSON holds
   * `"…KEY-----\nMIIE…"`, where `\n` is an escape `JSON.parse` resolves — but the same string lifted
   * into an env var, a `.env` file or a Kubernetes secret arrives with the backslash and the `n` as
   * two literal characters, and OpenSSL then refuses a PEM whose body is one 1600-character line.
   */
  it("accepts a split-form private key whose newlines arrived as two characters", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...FCM_PAIR,
      FCM_SERVICE_ACCOUNT_PRIVATE_KEY: FCM_KEYPAIR.privateKey.replace(/\n/g, "\\n"),
    });
    expect(registry.for("push_mobile")).not.toBeNull();
    expect(report.skipped).toEqual([]);
  });

  it("accepts the same mangling inside the JSON form", () => {
    const { registry } = buildSenderRegistryFromEnv({
      ...FCM_JSON,
      FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson({
        private_key: FCM_KEYPAIR.privateKey.replace(/\n/g, "\\n"),
      }),
    });
    expect(registry.for("push_mobile")).not.toBeNull();
  });

  it("skips rather than throws on malformed JSON", () => {
    const env = { ...FCM_JSON, FCM_SERVICE_ACCOUNT_JSON: "{not json" };
    expect(() => buildSenderRegistryFromEnv(env)).not.toThrow();
    const skips = fcmSkips(env);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("not valid JSON");
  });

  it("skips JSON that parses to something other than an object", () => {
    const skips = fcmSkips({ ...FCM_JSON, FCM_SERVICE_ACCOUNT_JSON: "[1,2]" });
    expect(skips[0]).toContain("not a JSON object");
  });

  it("skips a key file declaring a credential type other than a service account", () => {
    const skips = fcmSkips({
      ...FCM_JSON,
      FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson({ type: "authorized_user" }),
    });
    expect(skips[0]).toContain("is not a service account");
  });

  it("skips a private key that is not a PEM at all", () => {
    const skips = fcmSkips({
      ...FCM_PAIR,
      FCM_SERVICE_ACCOUNT_PRIVATE_KEY: "hunter2",
    });
    expect(skips[0]).toContain("not a PEM-encoded private key");
  });

  it("recognises the public half pasted into the private key variable", () => {
    const skips = fcmSkips({
      ...FCM_PAIR,
      FCM_SERVICE_ACCOUNT_PRIVATE_KEY: FCM_KEYPAIR.publicKey,
    });
    expect(skips[0]).toContain("is a public key, not a private key");
  });

  /*
   * Worth its own test because no textual check can catch it: an EC key is also wrapped in
   * `-----BEGIN PRIVATE KEY-----`, and `createSign("RSA-SHA256")` signs with it quite happily —
   * that name selects the digest and node takes the algorithm from the key. The result is a valid
   * ECDSA JWT that Google refuses as `invalid_grant`, the non-retryable kind, reported as "this
   * service account is wrong" for a key that is merely the wrong type. So it is a boot refusal.
   */
  it("refuses an EC key where Google requires RS256 over RSA", () => {
    const skips = fcmSkips({
      ...FCM_PAIR,
      FCM_SERVICE_ACCOUNT_PRIVATE_KEY: FCM_EC_KEYPAIR.privateKey,
    });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("requires RS256 over an RSA key");
  });

  it("refuses a non-https token endpoint, with no escape hatch for a local stand-in", () => {
    // The assertion POSTed to that endpoint is a bearer credential in its own right, so "it works
    // in staging over http" is exactly how a plaintext credential exchange reaches production.
    const skips = fcmSkips({ ...FCM_JSON, FCM_TOKEN_ENDPOINT: "http://localhost:8080/token" });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("tokenUri must be https");
  });

  it("accepts an https token endpoint override, for an egress proxy", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...FCM_JSON,
      FCM_TOKEN_ENDPOINT: "https://egress.internal.example/google/token",
    });
    expect(registry.for("push_mobile")).not.toBeNull();
    expect(report.skipped).toEqual([]);
  });

  it("prefers the verbatim key file over a split pair when both are set", () => {
    // The JSON form cannot have been mangled, so it is the better evidence of intent; a stale pair
    // left beside it must not be able to break a channel the key file fully configures.
    const { registry } = buildSenderRegistryFromEnv({
      ...FCM_JSON,
      FCM_SERVICE_ACCOUNT_CLIENT_EMAIL: "not-an-email",
      FCM_SERVICE_ACCOUNT_PRIVATE_KEY: "hunter2",
    });
    expect(registry.for("push_mobile")).not.toBeNull();
  });

  it("treats a whitespace-only credential as unset rather than passing it on", () => {
    const skips = fcmSkips({
      FCM_PROJECT_ID: "crossengin-prod",
      FCM_SERVICE_ACCOUNT_JSON: "   ",
    });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("partial configuration is ignored rather than guessed");
  });

  it("treats a whitespace-only project id as unset", () => {
    const skips = fcmSkips({ ...FCM_JSON, FCM_PROJECT_ID: "  " });
    expect(skips[0]).toContain("FCM_PROJECT_ID");
  });

  it("attributes every refusal to the channel it cost", () => {
    const skips = fcmSkips({ ...FCM_PAIR, FCM_SERVICE_ACCOUNT_PRIVATE_KEY: "hunter2" });
    expect(skips[0]).toMatch(/^push_mobile \(FCM\): refused its configuration: /);
  });

  /*
   * The test that matters most here. The refusals are built from credentials that *contain* the real
   * key, so a message that interpolated any of it would be caught — and a private key in a boot log
   * is a private key that has to be rotated.
   */
  it("never carries any part of the private key into a skipped reason", () => {
    const corrupt = `-----BEGIN PRIVATE KEY-----\n${FCM_KEY_WINDOWS[0] ?? ""}\n-----END PRIVATE KEY-----`;
    const broken: readonly NodeJS.ProcessEnv[] = [
      // The whole real key present, refused for the field beside it.
      { ...FCM_PAIR, FCM_SERVICE_ACCOUNT_CLIENT_EMAIL: "crossengin-prod" },
      { ...FCM_PAIR, FCM_TOKEN_ENDPOINT: "http://localhost:8080/token" },
      { ...FCM_JSON, FCM_TOKEN_ENDPOINT: "ftp://nope" },
      {
        ...FCM_JSON,
        FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson({ client_email: undefined }),
      },
      // A real slice of the key's body, in a PEM OpenSSL cannot decode.
      { ...FCM_PAIR, FCM_SERVICE_ACCOUNT_PRIVATE_KEY: corrupt },
      { ...FCM_JSON, FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson({ private_key: corrupt }) },
      // The key where the JSON belongs, which is a thing operators really do.
      { FCM_PROJECT_ID: "crossengin-prod", FCM_SERVICE_ACCOUNT_JSON: FCM_KEYPAIR.privateKey },
    ];
    const messages: string[] = [];
    for (const env of broken) {
      const skips = fcmSkips(env);
      expect(skips.length).toBeGreaterThan(0);
      messages.push(...skips);
    }
    expectNoKeyMaterial(messages);
  });

  it("costs the channel and never the boot, whatever the configuration says", () => {
    // A typo in one credential taking the whole API down would be a far worse outage than losing
    // push until it is fixed, which is the entire reason `construct` catches.
    const broken: readonly NodeJS.ProcessEnv[] = [
      { ...FCM_JSON, FCM_SERVICE_ACCOUNT_JSON: "{not json" },
      { ...FCM_PAIR, FCM_SERVICE_ACCOUNT_PRIVATE_KEY: FCM_EC_KEYPAIR.privateKey },
      { ...FCM_PAIR, FCM_SERVICE_ACCOUNT_PRIVATE_KEY: "hunter2" },
      { ...FCM_JSON, FCM_TOKEN_ENDPOINT: "not-a-url" },
      { ...FCM_JSON, FCM_BASE_URL: "not-a-url" },
    ];
    for (const env of broken) {
      expect(() => buildSenderRegistryFromEnv(env)).not.toThrow();
      expect(buildSenderRegistryFromEnv(env).registry.for("in_app")).not.toBeNull();
    }
  });

  it("leaves the other channels alone when FCM is broken", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...SES,
      ...TWILIO,
      ...FCM_PAIR,
      FCM_SERVICE_ACCOUNT_PRIVATE_KEY: "hunter2",
    });
    expect(registry.for("push_mobile")).toBeNull();
    expect([...report.channels].sort()).toEqual(["email", "in_app", "sms"]);
  });

  it("registers all four channels when all three providers are configured", () => {
    const { report } = buildSenderRegistryFromEnv({ ...SES, ...TWILIO, ...FCM_JSON });
    expect([...report.channels].sort()).toEqual([
      "email",
      "in_app",
      "push_mobile",
      "sms",
    ]);
    expect(report.skipped).toEqual([]);
  });

  it("sends to the overridden token and FCM endpoints rather than Google's own", async () => {
    // The only observable of an override is where the request goes. Asserting the sender merely
    // exists would pass whether or not either override reached the two objects that need them —
    // the token provider and the push sender are built separately and take one each.
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      seen.push(url);
      return url.includes("/token")
        ? new Response(
            JSON.stringify({ access_token: "ya29.stub", expires_in: 3599 }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("{}", { status: 500 });
    }) as typeof globalThis.fetch;
    try {
      const { registry } = buildSenderRegistryFromEnv({
        ...FCM_JSON,
        FCM_TOKEN_ENDPOINT: "https://egress.internal.example/google/token",
        FCM_BASE_URL: "https://fcm.internal.example",
      });
      await registry.for("push_mobile")?.send({
        dispatchId: "disp_1",
        tenantId: "00000000-0000-0000-0000-000000000001",
        channel: "push_mobile",
        templateId: "ntpl_1",
        locale: "en-US",
        // Shaped like a real registration token: the sender refuses a UUID outright, so a toy
        // address here would never reach the network and the assertion below would be vacuous.
        recipientAddress: `cE1:APA91b${"x".repeat(48)}`,
        attemptNumber: 1,
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual([
      "https://egress.internal.example/google/token",
      "https://fcm.internal.example/v1/projects/crossengin-prod/messages:send",
    ]);
    expect(
      seen.some((u) => u.includes("oauth2.googleapis.com") || u.includes("fcm.googleapis.com")),
    ).toBe(false);
  });
});

describe("voice from the environment (ADR-0328)", () => {
  it("says nothing at all when nobody tried to configure voice", () => {
    // SMS being configured is not an attempt to configure voice. `TWILIO_VOICE_*` are the only
    // variables that say "I want calls", which is what keeps an SMS-only deployment silent here.
    const { registry, report } = buildSenderRegistryFromEnv({ ...SES, ...TWILIO });
    expect(registry.for("voice_call")).toBeNull();
    expect(report.channels).not.toContain("voice_call");
    expect(report.skipped.some((s) => s.startsWith("voice"))).toBe(false);
  });

  it("registers voice_call on the SMS account with its own caller id", () => {
    const { registry, report } = buildSenderRegistryFromEnv({ ...VOICE });
    expect(registry.for("voice_call")?.channel).toBe("voice_call");
    expect(report.channels).toContain("voice_call");
    expect(report.skipped).toEqual([]);
  });

  it("names twilio_voice as the provider behind the channel", () => {
    expect(buildSenderRegistryFromEnv({ ...VOICE }).registry.for("voice_call")?.provider).toBe(
      "twilio_voice",
    );
  });

  /*
   * The decision this block exists to pin. `TWILIO_FROM_NUMBER` may be a short code, an alphanumeric
   * sender id, or a 10DLC number registered for messaging only — all valid SMS identities that
   * cannot place a call — and it may be absent entirely because SMS is configured with a messaging
   * service, which Calls has no analogue for. So the caller id is required and never inherited: a
   * channel that registers at boot, looks healthy and fails at the provider on every call is the
   * exact failure ADR-0301's rule exists to prevent.
   */
  it("never inherits TWILIO_FROM_NUMBER as the caller id", () => {
    const skips = voiceSkips({ ...TWILIO, TWILIO_VOICE_LANGUAGE: "en-GB" });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("TWILIO_VOICE_FROM_NUMBER");
    expect(skips[0]).toContain("never inherited from TWILIO_FROM_NUMBER");
    expect(buildSenderRegistryFromEnv({ ...TWILIO }).registry.for("voice_call")).toBeNull();
  });

  it("shares the SMS API key pair rather than making an operator restate it", async () => {
    // Observable only on the wire: voice is a ChannelSender in the same notification stack as SMS,
    // subject to the same preferences and suppressions, so it is the same credential for the same
    // job — unlike ADR-0326's `PAGE_SMS_*`, which is a different job and so shares nothing.
    const seen = await withRecordedFetch(
      () => new Response("{}", { status: 500 }),
      async () => {
        const { registry } = buildSenderRegistryFromEnv({
          ...VOICE,
          TWILIO_BASE_URL: "http://127.0.0.1:9/twilio",
        });
        await registry.for("voice_call")?.send({
          ...DISPATCH,
          channel: "voice_call",
          recipientAddress: "+15555550111",
        });
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://127.0.0.1:9/twilio/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json");
    const expected = Buffer.from(
      "SK00000000000000000000000000000000:shh",
      "utf8",
    ).toString("base64");
    expect(seen[0]?.authorization).toBe(`Basic ${expected}`);
  });

  it("accepts a voice-only credential, which overrides the shared one", async () => {
    const seen = await withRecordedFetch(
      () => new Response("{}", { status: 500 }),
      async () => {
        const { registry } = buildSenderRegistryFromEnv({
          ...VOICE,
          TWILIO_BASE_URL: "http://127.0.0.1:9/twilio",
          TWILIO_VOICE_API_KEY_SID: "SKvoice000000000000000000000000000",
          TWILIO_VOICE_API_KEY_SECRET: "voice-secret",
        });
        await registry.for("voice_call")?.send({
          ...DISPATCH,
          channel: "voice_call",
          recipientAddress: "+15555550111",
        });
      },
    );
    const expected = Buffer.from(
      "SKvoice000000000000000000000000000:voice-secret",
      "utf8",
    ).toString("base64");
    expect(seen[0]?.authorization).toBe(`Basic ${expected}`);
  });

  it("registers voice on a separate subaccount that brings its own credential", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...VOICE,
      TWILIO_VOICE_ACCOUNT_SID: "ACvoice00000000000000000000000000",
      TWILIO_VOICE_AUTH_TOKEN: "voice-root",
    });
    expect(registry.for("voice_call")).not.toBeNull();
    expect(report.skipped).toEqual([]);
  });

  /* One account's credential is never presented to another, however plausible the borrow looks. */
  it("refuses to present the SMS account's credential to a different subaccount", () => {
    const skips = voiceSkips({
      ...VOICE,
      TWILIO_VOICE_ACCOUNT_SID: "ACvoice00000000000000000000000000",
    });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("names an account other than TWILIO_ACCOUNT_SID");
  });

  it("borrows happily when the voice account sid names the same account", () => {
    const { registry } = buildSenderRegistryFromEnv({
      ...VOICE,
      TWILIO_VOICE_ACCOUNT_SID: TWILIO["TWILIO_ACCOUNT_SID"],
    });
    expect(registry.for("voice_call")).not.toBeNull();
  });

  it("refuses half a voice API key pair rather than falling back to an auth token", () => {
    // Silently substituting the account's root credential is a privilege escalation nobody asked
    // for — `buildTwilio`'s rule, and the same reason.
    const skips = voiceSkips({
      ...VOICE,
      TWILIO_VOICE_API_KEY_SID: "SKvoice000000000000000000000000000",
    });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("half a pair is refused");
  });

  it("accepts a voice auth token on its own", () => {
    const { registry } = buildSenderRegistryFromEnv({
      ...VOICE,
      TWILIO_VOICE_AUTH_TOKEN: "voice-root",
    });
    expect(registry.for("voice_call")).not.toBeNull();
  });

  it("refuses voice when the account has no credential anywhere", () => {
    const skips = voiceSkips({
      TWILIO_ACCOUNT_SID: TWILIO["TWILIO_ACCOUNT_SID"],
      TWILIO_VOICE_FROM_NUMBER: "+15555550199",
    });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("no credential for the Twilio account");
  });

  /*
   * A repeat count of `two` silently becoming 2, or an unknown detection mode silently becoming
   * off, is a deployment believing something untrue about an automated phone call. Every malformed
   * option costs the channel and says which variable did it.
   */
  it("refuses an unparseable repeat count rather than defaulting it", () => {
    const skips = voiceSkips({ ...VOICE, TWILIO_VOICE_REPEAT_COUNT: "two" });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("TWILIO_VOICE_REPEAT_COUNT");
    expect(buildSenderRegistryFromEnv({ ...VOICE, TWILIO_VOICE_REPEAT_COUNT: "two" }).registry.for("voice_call")).toBeNull();
  });

  it("refuses a repeat count outside the sender's range", () => {
    for (const repeat of ["0", "9"]) {
      const skips = voiceSkips({ ...VOICE, TWILIO_VOICE_REPEAT_COUNT: repeat });
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatch(/repeatCount|TWILIO_VOICE_REPEAT_COUNT/);
    }
  });

  it("accepts a repeat count inside it", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...VOICE,
      TWILIO_VOICE_REPEAT_COUNT: "3",
    });
    expect(registry.for("voice_call")).not.toBeNull();
    expect(report.skipped).toEqual([]);
  });

  it("refuses an unknown machine-detection mode, naming the ones Twilio takes", () => {
    const skips = voiceSkips({ ...VOICE, TWILIO_VOICE_MACHINE_DETECTION: "yes" });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("Detect");
    expect(skips[0]).toContain("DetectMessageEnd");
  });

  it("accepts both machine-detection modes", () => {
    for (const mode of ["Detect", "DetectMessageEnd"]) {
      const { registry, report } = buildSenderRegistryFromEnv({
        ...VOICE,
        TWILIO_VOICE_MACHINE_DETECTION: mode,
      });
      expect(registry.for("voice_call")).not.toBeNull();
      expect(report.skipped).toEqual([]);
    }
  });

  it("refuses a language that is not a locale, because it lands in a TwiML attribute", () => {
    const skips = voiceSkips({ ...VOICE, TWILIO_VOICE_LANGUAGE: "english" });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("language must look like en or en-US");
  });

  it("accepts a locale-shaped language", () => {
    const { report } = buildSenderRegistryFromEnv({
      ...VOICE,
      TWILIO_VOICE_LANGUAGE: "en-GB",
    });
    expect(report.skipped).toEqual([]);
  });

  /*
   * Unlike SMS, a missing status callback is **not** warned about. ADR-0310 gave voice no
   * bounce-webhook source on purpose — a busy line is not an invalid number the way a hard bounce is
   * an invalid address — so a carrier failure on a call produces no suppression whether or not a
   * callback is configured, and warning about its absence would promise handling that does not exist.
   */
  it("does not warn about a missing voice status callback", () => {
    const { registry, report } = buildSenderRegistryFromEnv({ ...VOICE });
    expect(registry.for("voice_call")).not.toBeNull();
    expect(report.skipped.some((s) => s.includes("TWILIO_VOICE_STATUS_CALLBACK_URL"))).toBe(
      false,
    );
  });

  it("accepts a status callback and asks Twilio for the answered event", async () => {
    const seen = await withRecordedFetch(
      () => new Response("{}", { status: 500 }),
      async () => {
        const { registry } = buildSenderRegistryFromEnv({
          ...VOICE,
          TWILIO_BASE_URL: "http://127.0.0.1:9/twilio",
          TWILIO_VOICE_STATUS_CALLBACK_URL: "https://api.example.com/v1/calls/status",
        });
        await registry.for("voice_call")?.send({
          ...DISPATCH,
          channel: "voice_call",
          recipientAddress: "+15555550111",
        });
      },
    );
    expect(seen).toHaveLength(1);
  });

  it("prefers a voice base url and otherwise inherits the SMS one", async () => {
    // A route is not a secret, so inheriting it is safe where inheriting a credential across
    // accounts is not: Calls and Messages are the same api.twilio.com host behind the same proxy.
    const seen = await withRecordedFetch(
      () => new Response("{}", { status: 500 }),
      async () => {
        const { registry } = buildSenderRegistryFromEnv({
          ...VOICE,
          TWILIO_BASE_URL: "http://127.0.0.1:9/shared",
          TWILIO_VOICE_BASE_URL: "http://127.0.0.1:9/voice",
        });
        await registry.for("voice_call")?.send({
          ...DISPATCH,
          channel: "voice_call",
          recipientAddress: "+15555550111",
        });
      },
    );
    expect(seen[0]?.url).toContain("127.0.0.1:9/voice");
    expect(seen[0]?.url).not.toContain("api.twilio.com");
  });

  /*
   * Unset, not half-configured — which is also why it is silent. An empty secret mount is far more
   * common than a missing key, and `value()` trims before `anyPresent` sees it, so a voice block
   * whose only variable is blank reads as "voice was never wanted". That is the same semantics the
   * SES and FCM blocks already have, and diverging for one channel would be worse than either rule.
   */
  it("treats a whitespace-only caller id as unset rather than as half-configured", () => {
    const { registry } = buildSenderRegistryFromEnv({
      ...VOICE,
      TWILIO_VOICE_FROM_NUMBER: "   ",
    });
    expect(registry.for("voice_call")).toBeNull();
    expect(voiceSkips({ ...VOICE, TWILIO_VOICE_FROM_NUMBER: "   " })).toEqual([]);
  });

  it("warns when a blank caller id sits beside another voice variable", () => {
    // Here the operator plainly started: a second `TWILIO_VOICE_*` variable is the evidence.
    const skips = voiceSkips({
      ...VOICE,
      TWILIO_VOICE_FROM_NUMBER: "   ",
      TWILIO_VOICE_REPEAT_COUNT: "2",
    });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("TWILIO_VOICE_FROM_NUMBER");
  });

  it("costs the channel and never the boot when the caller id is not E.164", () => {
    const env = { ...VOICE, TWILIO_VOICE_FROM_NUMBER: "555-0199" };
    expect(() => buildSenderRegistryFromEnv(env)).not.toThrow();
    const { registry } = buildSenderRegistryFromEnv(env);
    expect(registry.for("voice_call")).toBeNull();
    expect(registry.for("sms")).not.toBeNull();
    expect(voiceSkips(env)[0]).toContain("refused its configuration");
  });

  it("leaves every other channel registered when voice is broken", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...SES,
      ...VOICE,
      ...FCM_JSON,
      TWILIO_VOICE_MACHINE_DETECTION: "nope",
    });
    expect(registry.for("voice_call")).toBeNull();
    expect([...report.channels].sort()).toEqual([
      "email",
      "in_app",
      "push_mobile",
      "sms",
    ]);
  });

  it("registers all five channels when every provider is configured", () => {
    const { report } = buildSenderRegistryFromEnv({ ...SES, ...VOICE, ...FCM_JSON });
    expect([...report.channels].sort()).toEqual([
      "email",
      "in_app",
      "push_mobile",
      "sms",
      "voice_call",
    ]);
    expect(report.skipped).toEqual([]);
  });
});

describe("FCM credentials from the GCE metadata server (ADR-0328)", () => {
  const METADATA: NodeJS.ProcessEnv = {
    FCM_PROJECT_ID: "crossengin-prod",
    FCM_CREDENTIAL_SOURCE: "metadata_server",
  };

  /*
   * The route Google recommends, and the one where there is no key file to supply: with workload
   * identity the platform holds the credential and the network position *is* the credential. It is
   * therefore configured by nothing, which is precisely why it has to be declared — its absence of
   * configuration is indistinguishable from "push was never wanted".
   */
  it("registers push_mobile from a declared source and no credential at all", () => {
    const { registry, report } = buildSenderRegistryFromEnv({ ...METADATA });
    expect(registry.for("push_mobile")?.channel).toBe("push_mobile");
    expect(report.skipped).toEqual([]);
  });

  it("probes nothing at boot to decide", async () => {
    // A link-local request at boot would add this provider's timeout to every start and answer a
    // question the deployment already answered by declaring the source.
    const seen = await withRecordedFetch(
      () => new Response("{}", { status: 200 }),
      async () => {
        buildSenderRegistryFromEnv({ ...METADATA });
        return Promise.resolve();
      },
    );
    expect(seen).toEqual([]);
  });

  it("refuses an unrecognised credential source, naming both", () => {
    const skips = fcmSkips({ ...METADATA, FCM_CREDENTIAL_SOURCE: "workload_identity" });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("service_account");
    expect(skips[0]).toContain("metadata_server");
  });

  it("names both options when a half-started push configuration has no source", () => {
    const skips = fcmSkips({ FCM_PROJECT_ID: "crossengin-prod" });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("FCM_SERVICE_ACCOUNT_JSON");
    expect(skips[0]).toContain("FCM_CREDENTIAL_SOURCE=metadata_server");
  });

  it("still needs a project id, which the metadata server cannot supply", () => {
    const skips = fcmSkips({ FCM_CREDENTIAL_SOURCE: "metadata_server" });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("FCM_PROJECT_ID");
  });

  it("warns when service_account is declared with no key beside it", () => {
    const skips = fcmSkips({
      FCM_PROJECT_ID: "crossengin-prod",
      FCM_CREDENTIAL_SOURCE: "service_account",
    });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("FCM_SERVICE_ACCOUNT_JSON");
  });

  it("honours a declared key source, as the inferred one already did", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...FCM_JSON,
      FCM_CREDENTIAL_SOURCE: "service_account",
    });
    expect(registry.for("push_mobile")).not.toBeNull();
    expect(report.skipped).toEqual([]);
  });

  /* Two plausible configurations, resolved here and the loser named — `buildTwilio`'s rule. */
  it("lets the declared source win over a key left beside it, and says so", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...FCM_JSON,
      FCM_CREDENTIAL_SOURCE: "metadata_server",
    });
    expect(registry.for("push_mobile")).not.toBeNull();
    expect(report.skipped.some((s) => s.includes("service-account key") && s.includes("ignored"))).toBe(
      true,
    );
  });

  it("refuses a plaintext metadata endpoint pointing off the instance", () => {
    const skips = fcmSkips({
      ...METADATA,
      FCM_METADATA_ENDPOINT: "http://metadata.evil.example/token",
    });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("link-local or loopback host");
  });

  it("accepts an https metadata endpoint, for a proxying sidecar", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...METADATA,
      FCM_METADATA_ENDPOINT: "https://metadata-proxy.internal.example/token",
    });
    expect(registry.for("push_mobile")).not.toBeNull();
    expect(report.skipped).toEqual([]);
  });

  it("costs the channel and never the boot when the metadata endpoint is unusable", () => {
    const env = { ...METADATA, FCM_METADATA_ENDPOINT: "not-a-url" };
    expect(() => buildSenderRegistryFromEnv(env)).not.toThrow();
    expect(buildSenderRegistryFromEnv(env).registry.for("in_app")).not.toBeNull();
    expect(buildSenderRegistryFromEnv(env).registry.for("push_mobile")).toBeNull();
  });

  /*
   * The whole chain, on the wire: the link-local URL in plain http (correct, because the address is
   * unroutable and no CA can certify it) and the mandatory `Metadata-Flavor: Google`, which Google
   * requires so that a request unable to set a custom header can never reach the token endpoint.
   */
  it("reads the token from the link-local address with the mandatory header", async () => {
    const seen = await withRecordedFetch(
      (url) =>
        url.includes("computeMetadata")
          ? new Response(JSON.stringify({ access_token: "ya29.md", expires_in: 3599 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response("{}", { status: 500 }),
      async () => {
        const { registry } = buildSenderRegistryFromEnv({
          ...METADATA,
          FCM_BASE_URL: "https://fcm.internal.example",
        });
        await registry.for("push_mobile")?.send({
          ...DISPATCH,
          channel: "push_mobile",
          recipientAddress: `cE1:APA91b${"x".repeat(48)}`,
        });
      },
    );
    expect(seen.map((s) => s.url)).toEqual([
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      "https://fcm.internal.example/v1/projects/crossengin-prod/messages:send",
    ]);
    expect(seen[0]?.metadataFlavor).toBe("Google");
    expect(seen[0]?.authorization).toBe("");
    expect(seen[1]?.authorization).toBe("Bearer ya29.md");
  });

  it("reads a named service account when one is configured", async () => {
    const seen = await withRecordedFetch(
      (url) =>
        url.includes("computeMetadata")
          ? new Response(JSON.stringify({ access_token: "ya29.md", expires_in: 3599 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response("{}", { status: 500 }),
      async () => {
        const { registry } = buildSenderRegistryFromEnv({
          ...METADATA,
          FCM_METADATA_SERVICE_ACCOUNT: "push@crossengin-prod.iam.gserviceaccount.com",
        });
        await registry.for("push_mobile")?.send({
          ...DISPATCH,
          channel: "push_mobile",
          recipientAddress: `cE1:APA91b${"x".repeat(48)}`,
        });
      },
    );
    expect(seen[0]?.url).toContain("/service-accounts/push%40crossengin-prod");
  });

  it("leaves every other channel registered when the metadata configuration is broken", () => {
    const { registry, report } = buildSenderRegistryFromEnv({
      ...SES,
      ...VOICE,
      ...METADATA,
      FCM_METADATA_ENDPOINT: "http://off.instance.example/token",
    });
    expect(registry.for("push_mobile")).toBeNull();
    expect([...report.channels].sort()).toEqual([
      "email",
      "in_app",
      "sms",
      "voice_call",
    ]);
  });
});
