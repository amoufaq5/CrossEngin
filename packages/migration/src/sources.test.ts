import { describe, expect, it } from "vitest";
import {
  AUTH_KINDS,
  AuthCredentialRefSchema,
  ImportSourceSpecSchema,
  SOURCE_KINDS,
  SOURCE_SCHEDULES,
  defaultSampleSizeFor,
  isStructuredSource,
  requiresAuth,
  type ImportSourceSpec,
} from "./sources.js";

describe("constants", () => {
  it("SOURCE_KINDS has 12 entries", () => {
    expect(SOURCE_KINDS).toContain("csv");
    expect(SOURCE_KINDS).toContain("salesforce");
    expect(SOURCE_KINDS).toContain("fhir_r4");
    expect(SOURCE_KINDS).toContain("hl7_v2");
  });

  it("AUTH_KINDS has 7 entries", () => {
    expect(AUTH_KINDS).toContain("none");
    expect(AUTH_KINDS).toContain("oauth2_client_credentials");
    expect(AUTH_KINDS).toContain("aws_iam");
  });

  it("SOURCE_SCHEDULES has 4 entries", () => {
    expect(SOURCE_SCHEDULES).toEqual([
      "one_shot",
      "interval",
      "cron",
      "webhook_driven",
    ]);
  });
});

describe("AuthCredentialRefSchema", () => {
  it("accepts a valid bearer token ref", () => {
    expect(() =>
      AuthCredentialRefSchema.parse({
        kind: "bearer_token",
        vault: "vault://tenant-1/keys",
        secretName: "SALESFORCE_TOKEN",
      }),
    ).not.toThrow();
  });

  it("rejects malformed secretName", () => {
    expect(() =>
      AuthCredentialRefSchema.parse({
        kind: "api_key",
        vault: "v",
        secretName: "lowercase-bad",
      }),
    ).toThrow();
  });

  it("rejects 'none' with non-sentinel vault", () => {
    expect(() =>
      AuthCredentialRefSchema.parse({
        kind: "none",
        vault: "vault://x",
        secretName: "X",
      }),
    ).toThrow(/sentinel value/);
  });
});

describe("ImportSourceSpecSchema", () => {
  const base: ImportSourceSpec = {
    id: "salesforce-prod",
    tenantId: "t-1",
    label: "Salesforce Production",
    kind: "salesforce",
    location: "https://acme.my.salesforce.com",
    auth: {
      kind: "oauth2_client_credentials",
      vault: "vault://t-1/sf",
      secretName: "SF_CLIENT",
    },
    schedule: "interval",
    intervalSeconds: 3600,
    sampleSize: 500,
    primaryEntity: "Account",
    createdAt: "2026-05-14T10:00:00Z",
    createdBy: "u-1",
    lastFetchedAt: null,
    lastFetchStatus: null,
    enabled: true,
  };

  it("accepts a valid Salesforce source", () => {
    expect(() => ImportSourceSpecSchema.parse(base)).not.toThrow();
  });

  it("rejects salesforce with auth='none'", () => {
    expect(() =>
      ImportSourceSpecSchema.parse({
        ...base,
        auth: { kind: "none", vault: "none", secretName: "X" },
      }),
    ).toThrow(/requires authenticated access/);
  });

  it("rejects schedule='interval' without intervalSeconds", () => {
    const { intervalSeconds, ...rest } = base;
    void intervalSeconds;
    expect(() => ImportSourceSpecSchema.parse(rest)).toThrow(/intervalSeconds/);
  });

  it("rejects schedule='cron' without cron expression", () => {
    expect(() =>
      ImportSourceSpecSchema.parse({
        ...base,
        schedule: "cron",
        intervalSeconds: undefined,
      }),
    ).toThrow(/cron expression/);
  });

  it("rejects schedule='one_shot' with intervalSeconds", () => {
    expect(() =>
      ImportSourceSpecSchema.parse({
        ...base,
        schedule: "one_shot",
        intervalSeconds: 3600,
      }),
    ).toThrow(/must not declare intervalSeconds/);
  });

  it("rejects structured source without primaryEntity", () => {
    expect(() =>
      ImportSourceSpecSchema.parse({
        ...base,
        primaryEntity: undefined,
      }),
    ).toThrow(/requires primaryEntity/);
  });

  it("accepts CSV without primaryEntity", () => {
    expect(() =>
      ImportSourceSpecSchema.parse({
        ...base,
        id: "csv-1",
        kind: "csv",
        location: "s3://acme/data.csv",
        auth: { kind: "none", vault: "none", secretName: "X" },
        schedule: "one_shot",
        intervalSeconds: undefined,
        primaryEntity: undefined,
      }),
    ).not.toThrow();
  });

  it("rejects lastFetchStatus='error' without lastFetchError", () => {
    expect(() =>
      ImportSourceSpecSchema.parse({
        ...base,
        lastFetchedAt: "2026-05-14T11:00:00Z",
        lastFetchStatus: "error",
      }),
    ).toThrow(/lastFetchError/);
  });
});

describe("helpers", () => {
  it("isStructuredSource for salesforce + servicenow", () => {
    expect(isStructuredSource("salesforce")).toBe(true);
    expect(isStructuredSource("servicenow")).toBe(true);
    expect(isStructuredSource("csv")).toBe(false);
  });

  it("requiresAuth for salesforce + http_api + fhir_r4", () => {
    expect(requiresAuth("salesforce")).toBe(true);
    expect(requiresAuth("http_api")).toBe(true);
    expect(requiresAuth("csv")).toBe(false);
  });

  it("defaultSampleSizeFor scales with source kind", () => {
    expect(defaultSampleSizeFor("csv")).toBeGreaterThan(defaultSampleSizeFor("salesforce"));
    expect(defaultSampleSizeFor("excel_xlsx")).toBe(500);
  });
});
