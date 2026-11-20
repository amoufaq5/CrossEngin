import { describe, expect, it } from "vitest";

import {
  MalformedTenantPseudonym,
  TENANT_PSEUDONYM_PATTERN,
  TenantPseudonymSchema,
  isTenantPseudonym,
  tenantPseudonymForWire,
} from "./tenant-pseudonym.js";
import { CompletionRequestSchema, EmbeddingRequestSchema } from "./types.js";

const GOOD = "ctp_f045990d8518bdda4f768266de4316b6";
const TENANT = "0196f2a8-7c3b-7d4e-9a1b-2c3d4e5f6a7b";

describe("TenantPseudonymSchema", () => {
  it("accepts the derived shape", () => {
    expect(TenantPseudonymSchema.safeParse(GOOD).success).toBe(true);
    expect(isTenantPseudonym(GOOD)).toBe(true);
    expect(TENANT_PSEUDONYM_PATTERN.test(GOOD)).toBe(true);
  });

  it.each([
    ["a raw tenant id", TENANT],
    ["a hyphen-stripped tenant id", TENANT.replaceAll("-", "")],
    ["a prefixed raw tenant id", `ctp_${TENANT}`],
    ["uppercase hex", GOOD.toUpperCase().replace("CTP_", "ctp_")],
    ["a short value", "ctp_abc"],
    ["a long value", `${GOOD}0`],
    ["no prefix", GOOD.slice(4)],
    ["an empty string", ""],
  ])("refuses %s", (_label, value) => {
    expect(TenantPseudonymSchema.safeParse(value).success).toBe(false);
    expect(isTenantPseudonym(value)).toBe(false);
  });

  it("is optional on both request schemas, and validated when present", () => {
    const base = {
      task: "planner",
      messages: [{ role: "user", content: "hi" }],
      tenantId: TENANT,
      sessionId: "s1",
    };
    expect(CompletionRequestSchema.safeParse(base).success).toBe(true);
    expect(CompletionRequestSchema.safeParse({ ...base, tenantPseudonym: GOOD }).success).toBe(true);
    expect(CompletionRequestSchema.safeParse({ ...base, tenantPseudonym: TENANT }).success).toBe(false);
    const embed = { texts: ["a"], tenantId: TENANT };
    expect(EmbeddingRequestSchema.safeParse({ ...embed, tenantPseudonym: GOOD }).success).toBe(true);
    expect(EmbeddingRequestSchema.safeParse({ ...embed, tenantPseudonym: TENANT }).success).toBe(false);
  });
});

describe("tenantPseudonymForWire", () => {
  it("answers undefined when no pseudonym is configured, never a fallback", () => {
    expect(tenantPseudonymForWire({ tenantId: TENANT })).toBeUndefined();
    expect(tenantPseudonymForWire({ tenantId: TENANT, tenantPseudonym: undefined })).toBeUndefined();
  });

  it("passes a well-formed pseudonym through", () => {
    expect(tenantPseudonymForWire({ tenantId: TENANT, tenantPseudonym: GOOD })).toBe(GOOD);
  });

  it("throws on a malformed one without quoting it", () => {
    let caught: unknown;
    try {
      tenantPseudonymForWire({ tenantId: TENANT, tenantPseudonym: TENANT });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedTenantPseudonym);
    expect((caught as Error).message).not.toContain(TENANT);
  });

  it.each([
    ["lowercase", TENANT],
    ["uppercase", TENANT.toUpperCase()],
  ])(
    "refuses the request's own tenant id with its hyphens removed (%s), which the pattern admits",
    (_label, tenantId) => {
      const smuggled = `ctp_${TENANT.replaceAll("-", "")}`;
      // The pattern alone cannot see it — that is the gap this check exists for.
      expect(isTenantPseudonym(smuggled)).toBe(true);
      let caught: unknown;
      try {
        tenantPseudonymForWire({ tenantId, tenantPseudonym: smuggled });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MalformedTenantPseudonym);
      expect((caught as Error).message).not.toContain(TENANT.replaceAll("-", ""));
    },
  );

  it("does not refuse another tenant's stripped id, since only the request's own id is checkable", () => {
    const other = "0196f2a8-7c3b-7d4e-9a1b-2c3d4e5f6a7c";
    const value = `ctp_${other.replaceAll("-", "")}`;
    expect(tenantPseudonymForWire({ tenantId: TENANT, tenantPseudonym: value })).toBe(value);
  });
});
