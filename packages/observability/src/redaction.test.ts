import { describe, expect, it } from "vitest";
import {
  DATA_CLASS_ORDER,
  DEFAULT_REDACTION_POLICY,
  RedactionPolicySchema,
  redact,
  shouldRedact,
} from "./redaction.js";

describe("RedactionPolicySchema", () => {
  it("applies default placeholder + dropEntirely=false", () => {
    const p = RedactionPolicySchema.parse({ redactAt: "phi" });
    expect(p.placeholder).toBe("[REDACTED]");
    expect(p.dropEntirely).toBe(false);
  });
});

describe("DATA_CLASS_ORDER", () => {
  it("orders public lowest and regulated highest", () => {
    expect(DATA_CLASS_ORDER.public).toBeLessThan(DATA_CLASS_ORDER.internal);
    expect(DATA_CLASS_ORDER.internal).toBeLessThan(DATA_CLASS_ORDER.commercial_sensitive);
    expect(DATA_CLASS_ORDER.commercial_sensitive).toBeLessThan(DATA_CLASS_ORDER.pii);
    expect(DATA_CLASS_ORDER.pii).toBeLessThan(DATA_CLASS_ORDER.phi);
    expect(DATA_CLASS_ORDER.phi).toBeLessThan(DATA_CLASS_ORDER.regulated);
  });
});

describe("shouldRedact", () => {
  it("redacts everything at or above the policy threshold", () => {
    const p = { ...DEFAULT_REDACTION_POLICY, redactAt: "pii" as const };
    expect(shouldRedact("public", p)).toBe(false);
    expect(shouldRedact("internal", p)).toBe(false);
    expect(shouldRedact("pii", p)).toBe(true);
    expect(shouldRedact("phi", p)).toBe(true);
    expect(shouldRedact("regulated", p)).toBe(true);
  });
});

describe("redact", () => {
  it("returns the payload unchanged when no fields are sensitive enough", () => {
    const r = redact({
      payload: { id: "1", note: "hello" },
      fieldClasses: { id: "public", note: "internal" },
    });
    expect(r.value).toEqual({ id: "1", note: "hello" });
    expect(r.redactedPaths).toEqual([]);
  });

  it("redacts pii fields with the placeholder by default", () => {
    const r = redact({
      payload: { email: "a@b.com", id: "1" },
      fieldClasses: { email: "pii", id: "public" },
    });
    expect(r.value).toEqual({ email: "[REDACTED]", id: "1" });
    expect(r.redactedPaths).toEqual(["email"]);
  });

  it("drops fields entirely when dropEntirely is true", () => {
    const r = redact({
      payload: { ssn: "123-45-6789", id: "1" },
      fieldClasses: { ssn: "phi" },
      policy: { redactAt: "pii", placeholder: "[X]", dropEntirely: true },
    });
    expect(r.value).toEqual({ id: "1" });
    expect(r.redactedPaths).toEqual(["ssn"]);
  });

  it("walks nested objects and uses dotted paths", () => {
    const r = redact({
      payload: { user: { name: "Hassan", email: "a@b.com" }, count: 5 },
      fieldClasses: { "user.email": "pii" },
    });
    expect(r.value).toEqual({
      user: { name: "Hassan", email: "[REDACTED]" },
      count: 5,
    });
    expect(r.redactedPaths).toEqual(["user.email"]);
  });

  it("falls back to leaf-name classification when no full-path match", () => {
    const r = redact({
      payload: { primary: { ssn: "1" }, secondary: { ssn: "2" } },
      fieldClasses: { ssn: "phi" },
    });
    expect(r.value).toEqual({
      primary: { ssn: "[REDACTED]" },
      secondary: { ssn: "[REDACTED]" },
    });
    expect([...r.redactedPaths].sort()).toEqual(["primary.ssn", "secondary.ssn"]);
  });

  it("redacts array elements when their fields are sensitive", () => {
    const r = redact({
      payload: { patients: [{ name: "A", email: "a@x" }, { name: "B", email: "b@x" }] },
      fieldClasses: { email: "pii" },
    });
    expect(r.value).toEqual({
      patients: [
        { name: "A", email: "[REDACTED]" },
        { name: "B", email: "[REDACTED]" },
      ],
    });
  });

  it("leaves primitives and nulls untouched", () => {
    expect(redact({ payload: "hello", fieldClasses: {} }).value).toBe("hello");
    expect(redact({ payload: 42, fieldClasses: {} }).value).toBe(42);
    expect(redact({ payload: null, fieldClasses: {} }).value).toBeNull();
  });

  it("respects policy.redactAt=phi (lower classes pass through)", () => {
    const r = redact({
      payload: { email: "a@b.com", ssn: "1" },
      fieldClasses: { email: "pii", ssn: "phi" },
      policy: { redactAt: "phi", placeholder: "[REDACTED]", dropEntirely: false },
    });
    expect(r.value).toEqual({ email: "a@b.com", ssn: "[REDACTED]" });
  });
});
