import { describe, expect, it } from "vitest";
import {
  classifyError,
  isPermanent,
  isRetryable,
  JobError,
  PermanentError,
  RetryableError,
} from "./errors.js";

describe("RetryableError", () => {
  it("is a JobError and an Error", () => {
    const e = new RetryableError("transient");
    expect(e).toBeInstanceOf(JobError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RetryableError");
    expect(e.kind).toBe("retryable");
  });

  it("optionally carries retryAfter", () => {
    const e = new RetryableError("rate limited", { retryAfter: "PT30S" });
    expect(e.retryAfter).toBe("PT30S");
  });

  it("can wrap a cause", () => {
    const cause = new Error("network unreachable");
    const e = new RetryableError("upstream timeout", { cause });
    expect(e.cause).toBe(cause);
  });
});

describe("PermanentError", () => {
  it("is a JobError and an Error", () => {
    const e = new PermanentError("forbidden");
    expect(e).toBeInstanceOf(JobError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PermanentError");
    expect(e.kind).toBe("permanent");
  });

  it("optionally carries reason", () => {
    const e = new PermanentError("denied", { reason: "patient_consent_withdrawn" });
    expect(e.reason).toBe("patient_consent_withdrawn");
  });
});

describe("type-guards", () => {
  it("isRetryable + isPermanent narrow correctly", () => {
    expect(isRetryable(new RetryableError("x"))).toBe(true);
    expect(isRetryable(new PermanentError("y"))).toBe(false);
    expect(isPermanent(new PermanentError("y"))).toBe(true);
    expect(isPermanent(new RetryableError("x"))).toBe(false);
  });

  it("non-Error values are neither retryable nor permanent", () => {
    expect(isRetryable("oops")).toBe(false);
    expect(isPermanent(42)).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

describe("classifyError", () => {
  it("classifies known errors", () => {
    expect(classifyError(new RetryableError("a"))).toBe("retryable");
    expect(classifyError(new PermanentError("b"))).toBe("permanent");
  });

  it("returns 'unknown' for plain Error", () => {
    expect(classifyError(new Error("boom"))).toBe("unknown");
  });

  it("returns 'unknown' for non-Errors", () => {
    expect(classifyError("string")).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
  });
});
