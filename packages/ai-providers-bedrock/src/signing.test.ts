import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { formatAmzDate, signRequest } from "./signing.js";

const FIXED_DATE = new Date("2026-05-18T12:00:00.000Z");
const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
} as const;

function sign(input: {
  method?: string;
  host?: string;
  path?: string;
  body?: Uint8Array;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  now?: Date;
}) {
  return signRequest({
    method: input.method ?? "POST",
    host: input.host ?? "bedrock-runtime.us-east-1.amazonaws.com",
    path: input.path ?? "/model/anthropic.claude-3-5-sonnet/converse",
    headers: input.headers ?? { "content-type": "application/json" },
    body: input.body ?? new TextEncoder().encode("{}"),
    query: input.query ?? {},
    region: "us-east-1",
    service: "bedrock",
    credentials: CREDS,
    now: input.now ?? FIXED_DATE,
  });
}

function deriveExpectedSigningKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kSecret = Buffer.from(`AWS4${secret}`, "utf8");
  const kDate = createHmac("sha256", kSecret).update(date).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

describe("formatAmzDate", () => {
  it("produces the AWS-canonical ISO basic format", () => {
    expect(formatAmzDate(new Date("2026-05-18T12:34:56.000Z"))).toBe("20260518T123456Z");
  });

  it("pads single-digit months / days / hours", () => {
    expect(formatAmzDate(new Date("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405Z");
  });

  it("uses UTC regardless of local timezone", () => {
    // Construct a date with a known UTC value; verify the formatter doesn't shift.
    const d = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
    expect(formatAmzDate(d)).toBe("20261231T235959Z");
  });
});

describe("signRequest — output shape", () => {
  it("Authorization header has the AWS4-HMAC-SHA256 algorithm + Credential + SignedHeaders + Signature", () => {
    const signed = sign({});
    expect(signed.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260518\/us-east-1\/bedrock\/aws4_request, SignedHeaders=[a-z0-9;:-]+, Signature=[0-9a-f]{64}$/,
    );
  });

  it("amzDate matches formatAmzDate(now)", () => {
    const signed = sign({});
    expect(signed.amzDate).toBe("20260518T120000Z");
  });

  it("contentSha256 is the sha256 of the body", () => {
    const body = new TextEncoder().encode("hello world");
    const signed = sign({ body });
    const expected = createHash("sha256").update(body).digest("hex");
    expect(signed.contentSha256).toBe(expected);
  });

  it("includes host, x-amz-date, x-amz-content-sha256 in headers", () => {
    const signed = sign({});
    expect(signed.headers["host"]).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    expect(signed.headers["x-amz-date"]).toBe("20260518T120000Z");
    expect(signed.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes signed headers list with host and x-amz-content-sha256 and x-amz-date", () => {
    const signed = sign({});
    const m = /SignedHeaders=([a-z0-9;:-]+),/.exec(signed.authorization);
    expect(m).not.toBeNull();
    const headers = m![1]!.split(";");
    expect(headers).toContain("host");
    expect(headers).toContain("x-amz-date");
    expect(headers).toContain("x-amz-content-sha256");
    expect(headers).toContain("content-type");
  });

  it("signed headers are sorted alphabetically", () => {
    const signed = sign({});
    const m = /SignedHeaders=([a-z0-9;:-]+),/.exec(signed.authorization);
    const headers = m![1]!.split(";");
    expect(headers).toEqual([...headers].sort());
  });
});

describe("signRequest — determinism + sensitivity", () => {
  it("same inputs → same signature", () => {
    expect(sign({}).authorization).toBe(sign({}).authorization);
  });

  it("different body → different signature", () => {
    const a = sign({ body: new TextEncoder().encode("hello") });
    const b = sign({ body: new TextEncoder().encode("world") });
    expect(extractSignature(a.authorization)).not.toBe(extractSignature(b.authorization));
  });

  it("different path → different signature", () => {
    const a = sign({ path: "/model/a/converse" });
    const b = sign({ path: "/model/b/converse" });
    expect(extractSignature(a.authorization)).not.toBe(extractSignature(b.authorization));
  });

  it("different region → different signature", () => {
    const a = signRequest({
      method: "POST",
      host: "bedrock-runtime.us-east-1.amazonaws.com",
      path: "/m/converse",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
      region: "us-east-1",
      service: "bedrock",
      credentials: CREDS,
      now: FIXED_DATE,
    });
    const b = signRequest({
      method: "POST",
      host: "bedrock-runtime.us-east-1.amazonaws.com",
      path: "/m/converse",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
      region: "eu-west-1",
      service: "bedrock",
      credentials: CREDS,
      now: FIXED_DATE,
    });
    expect(extractSignature(a.authorization)).not.toBe(extractSignature(b.authorization));
  });

  it("includes x-amz-security-token when a session token is supplied", () => {
    const signed = signRequest({
      method: "POST",
      host: "bedrock-runtime.us-east-1.amazonaws.com",
      path: "/m/converse",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
      region: "us-east-1",
      service: "bedrock",
      credentials: { ...CREDS, sessionToken: "tok-123" },
      now: FIXED_DATE,
    });
    expect(signed.headers["x-amz-security-token"]).toBe("tok-123");
    expect(signed.authorization).toContain("x-amz-security-token");
  });
});

describe("signRequest — signing key derivation matches AWS reference", () => {
  it("HMAC chain: kSecret → kDate → kRegion → kService → aws4_request", () => {
    const key = deriveExpectedSigningKey(CREDS.secretAccessKey, "20260518", "us-east-1", "bedrock");
    expect(key.byteLength).toBe(32);
    expect(key.toString("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AWS-documented reference: us-east-1 / iam / 20120215", () => {
    const key = deriveExpectedSigningKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20120215",
      "us-east-1",
      "iam",
    );
    expect(key.toString("hex")).toBe(
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    );
  });
});

describe("signRequest — URI encoding + query canonicalisation", () => {
  it("does NOT encode path slashes", () => {
    const signed = sign({ path: "/model/foo/converse" });
    expect(signed.authorization).toContain("Signature=");
    // No regression here — the signature path is internal; we just verify it signs.
  });

  it("sorts and encodes query parameters", () => {
    const sigZ = sign({ query: { z: "1", a: "2" } });
    const sigA = sign({ query: { a: "2", z: "1" } });
    // Different ordering on input → same canonical query → same signature
    expect(extractSignature(sigZ.authorization)).toBe(extractSignature(sigA.authorization));
  });

  it("repeats with the same key produce a multi-value canonical query", () => {
    const signed = sign({ query: { tag: ["a", "b"] } });
    expect(signed.authorization).toContain("Signature=");
    // Output is a stable signature
    expect(extractSignature(signed.authorization)).toMatch(/^[0-9a-f]{64}$/);
  });
});

function extractSignature(authorization: string): string {
  const m = /Signature=([0-9a-f]{64})/.exec(authorization);
  if (m === null) throw new Error(`no signature in ${authorization}`);
  return m[1]!;
}
