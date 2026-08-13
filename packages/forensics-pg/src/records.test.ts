import { describe, expect, it } from "vitest";
import { ChainAppendInputSchema, rowToChainEntry } from "./records.js";

const H = "a".repeat(64);
const G = "0".repeat(64);

describe("ChainAppendInputSchema", () => {
  it("accepts a string or bytes payload", () => {
    expect(() =>
      ChainAppendInputSchema.parse({
        tenantId: null,
        kind: "audit_event",
        actorReference: "svc",
        recordedAt: "2026-06-01T00:00:00.000Z",
        payload: "hello",
      }),
    ).not.toThrow();
    expect(() =>
      ChainAppendInputSchema.parse({
        tenantId: "11111111-1111-1111-1111-111111111111",
        kind: "security_event",
        actorReference: "svc",
        recordedAt: "2026-06-01T00:00:00.000Z",
        payload: new Uint8Array([1, 2, 3]),
      }),
    ).not.toThrow();
  });

  it("rejects an unknown kind and a non-uuid tenant", () => {
    const base = {
      kind: "audit_event",
      actorReference: "svc",
      recordedAt: "2026-06-01T00:00:00.000Z",
      payload: "p",
    };
    expect(() => ChainAppendInputSchema.parse({ ...base, tenantId: null, kind: "nope" })).toThrow();
    expect(() => ChainAppendInputSchema.parse({ ...base, tenantId: "x" })).toThrow();
  });
});

describe("rowToChainEntry", () => {
  it("parses a row and trims CHAR(64) padding", () => {
    const entry = rowToChainEntry({
      sequence_number: "0",
      kind: "audit_event",
      recorded_at: new Date("2026-06-01T00:00:00.000Z"),
      actor_reference: "svc",
      payload_sha256: `${H} `,
      payload_size_bytes: "12",
      prior_entry_hash: G,
      entry_hash: H,
      signing_key_fingerprint: H,
      signature: "sig",
    });
    expect(entry.sequenceNumber).toBe(0);
    expect(entry.payloadSha256).toBe(H);
    expect(entry.recordedAt).toBe("2026-06-01T00:00:00.000Z");
  });
});
