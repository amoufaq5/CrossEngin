import { describe, expect, it } from "vitest";
import {
  IdempotencyKeySchema,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  computeIdempotencyKey,
  isIdempotencyKey,
} from "./idempotency.js";

describe("IdempotencyKeySchema", () => {
  it("accepts ASCII alphanumerics and . _ : / = + -", () => {
    expect(IdempotencyKeySchema.parse("job=x:event=e123")).toBe("job=x:event=e123");
    expect(IdempotencyKeySchema.parse("a.b/c+d=e_f-g")).toBe("a.b/c+d=e_f-g");
  });

  it("rejects spaces", () => {
    expect(() => IdempotencyKeySchema.parse("with space")).toThrow();
  });

  it("rejects non-ASCII", () => {
    expect(() => IdempotencyKeySchema.parse("café")).toThrow();
  });

  it("enforces the documented max length", () => {
    expect(() => IdempotencyKeySchema.parse("a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1))).toThrow();
  });
});

describe("computeIdempotencyKey", () => {
  it("produces job=<id> as the first segment", () => {
    const k = computeIdempotencyKey({ jobId: "notify-patient" });
    expect(k.startsWith("job=notify-patient")).toBe(true);
  });

  it("appends tenant + event when supplied", () => {
    const k = computeIdempotencyKey({
      jobId: "scan-virus",
      tenantId: "t_1",
      eventId: "e_42",
    });
    expect(k).toBe("job=scan-virus:tenant=t_1:event=e_42");
  });

  it("orders extras deterministically (alphabetical)", () => {
    const k1 = computeIdempotencyKey({
      jobId: "x",
      extras: [
        ["z", "1"],
        ["a", "2"],
        ["m", "3"],
      ],
    });
    const k2 = computeIdempotencyKey({
      jobId: "x",
      extras: [
        ["m", "3"],
        ["a", "2"],
        ["z", "1"],
      ],
    });
    expect(k1).toBe(k2);
    expect(k1).toBe("job=x:a=2:m=3:z=1");
  });

  it("is deterministic across calls", () => {
    const input = { jobId: "j", tenantId: "t", eventId: "e" };
    expect(computeIdempotencyKey(input)).toBe(computeIdempotencyKey(input));
  });

  it("rejects an invalid jobId", () => {
    expect(() => computeIdempotencyKey({ jobId: "Invalid_ID" })).toThrow();
  });
});

describe("isIdempotencyKey", () => {
  it("returns true for valid keys", () => {
    expect(isIdempotencyKey("job=x:event=e1")).toBe(true);
  });

  it("returns false for invalid keys", () => {
    expect(isIdempotencyKey("")).toBe(false);
    expect(isIdempotencyKey("with space")).toBe(false);
    expect(isIdempotencyKey(42)).toBe(false);
  });
});
