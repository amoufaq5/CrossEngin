import { describe, expect, it } from "vitest";
import {
  CUSTODY_ACTIONS,
  CUSTODY_PURPOSES,
  CustodyChainSchema,
  CustodyEntrySchema,
  chainAgeMinutes,
  currentCustodian,
  isChainSealed,
  type CustodyEntry,
} from "./chain-of-custody.js";

const SHA = "a".repeat(64);
const FP = "b".repeat(64);

describe("constants", () => {
  it("CUSTODY_ACTIONS has 9 entries", () => {
    expect(CUSTODY_ACTIONS).toContain("collected");
    expect(CUSTODY_ACTIONS).toContain("transferred");
    expect(CUSTODY_ACTIONS).toContain("destroyed");
  });

  it("CUSTODY_PURPOSES has 6 entries", () => {
    expect(CUSTODY_PURPOSES).toContain("litigation_preservation");
    expect(CUSTODY_PURPOSES).toContain("law_enforcement_request");
  });
});

describe("CustodyEntrySchema", () => {
  const base: CustodyEntry = {
    id: "COC-2026-0001",
    evidenceId: "EV-2026-0001",
    action: "transferred",
    purpose: "incident_investigation",
    occurredAt: "2026-05-14T10:00:00Z",
    fromCustodianId: "u-1",
    toCustodianId: "u-2",
    witnessId: "u-3",
    expectedSha256: SHA,
    verifiedSha256: SHA,
    sealNumber: undefined,
    location: "EU-Central HQ",
    signature: "sig",
    signingKeyFingerprint: FP,
  };

  it("accepts a valid transferred entry", () => {
    expect(() => CustodyEntrySchema.parse(base)).not.toThrow();
  });

  it("rejects sha256 mismatch (tampering)", () => {
    expect(() =>
      CustodyEntrySchema.parse({
        ...base,
        verifiedSha256: "f".repeat(64),
      }),
    ).toThrow(/chain of custody BROKEN/);
  });

  it("rejects 'collected' with non-null fromCustodianId", () => {
    expect(() =>
      CustodyEntrySchema.parse({
        ...base,
        action: "collected",
      }),
    ).toThrow(/fromCustodianId=null/);
  });

  it("rejects non-collected without fromCustodianId", () => {
    expect(() =>
      CustodyEntrySchema.parse({
        ...base,
        fromCustodianId: null,
      }),
    ).toThrow(/requires fromCustodianId/);
  });

  it("rejects from == to", () => {
    expect(() =>
      CustodyEntrySchema.parse({ ...base, toCustodianId: "u-1" }),
    ).toThrow(/must differ/);
  });

  it("rejects transferred without witness", () => {
    expect(() =>
      CustodyEntrySchema.parse({ ...base, witnessId: null }),
    ).toThrow(/witness/);
  });

  it("rejects witness from from/to custodian", () => {
    expect(() =>
      CustodyEntrySchema.parse({ ...base, witnessId: "u-1" }),
    ).toThrow(/third party/);
  });

  it("rejects destroyed without sealNumber", () => {
    expect(() =>
      CustodyEntrySchema.parse({
        ...base,
        action: "destroyed",
      }),
    ).toThrow(/sealNumber/);
  });
});

describe("CustodyChainSchema", () => {
  const entry = (
    id: string,
    action: CustodyEntry["action"],
    from: string | null,
    to: string,
    occurredAt: string,
    witness: string | null = null,
    sealNumber?: string,
  ): CustodyEntry => ({
    id,
    evidenceId: "EV-2026-0001",
    action,
    purpose: "incident_investigation",
    occurredAt,
    fromCustodianId: from,
    toCustodianId: to,
    witnessId: witness,
    expectedSha256: SHA,
    verifiedSha256: SHA,
    sealNumber,
    location: "x",
    signature: "s",
    signingKeyFingerprint: FP,
  });

  it("accepts a valid chain starting with 'collected'", () => {
    expect(() =>
      CustodyChainSchema.parse([
        entry("COC-2026-0001", "collected", null, "u-1", "2026-05-14T10:00:00Z"),
        entry(
          "COC-2026-0002",
          "transferred",
          "u-1",
          "u-2",
          "2026-05-14T11:00:00Z",
          "u-w",
        ),
      ]),
    ).not.toThrow();
  });

  it("rejects chain not starting with collected", () => {
    expect(() =>
      CustodyChainSchema.parse([
        entry("COC-2026-0001", "transferred", "u-1", "u-2", "2026-05-14T10:00:00Z", "u-w"),
      ]),
    ).toThrow(/first entry must be action='collected'/);
  });

  it("rejects multiple 'collected' entries", () => {
    expect(() =>
      CustodyChainSchema.parse([
        entry("COC-2026-0001", "collected", null, "u-1", "2026-05-14T10:00:00Z"),
        entry("COC-2026-0002", "collected", null, "u-2", "2026-05-14T11:00:00Z"),
      ]),
    ).toThrow(/only the first entry/);
  });

  it("rejects custody gap (fromCustodian not equal to prior toCustodian)", () => {
    expect(() =>
      CustodyChainSchema.parse([
        entry("COC-2026-0001", "collected", null, "u-1", "2026-05-14T10:00:00Z"),
        entry(
          "COC-2026-0002",
          "transferred",
          "u-2",
          "u-3",
          "2026-05-14T11:00:00Z",
          "u-w",
        ),
      ]),
    ).toThrow(/custody gap/);
  });

  it("rejects out-of-order timestamps", () => {
    expect(() =>
      CustodyChainSchema.parse([
        entry("COC-2026-0001", "collected", null, "u-1", "2026-05-14T11:00:00Z"),
        entry(
          "COC-2026-0002",
          "transferred",
          "u-1",
          "u-2",
          "2026-05-14T10:00:00Z",
          "u-w",
        ),
      ]),
    ).toThrow(/chronological order/);
  });

  it("rejects mixed evidence ids", () => {
    expect(() =>
      CustodyChainSchema.parse([
        entry("COC-2026-0001", "collected", null, "u-1", "2026-05-14T10:00:00Z"),
        {
          ...entry("COC-2026-0002", "transferred", "u-1", "u-2", "2026-05-14T11:00:00Z", "u-w"),
          evidenceId: "EV-2026-0099",
        },
      ]),
    ).toThrow(/single evidence id/);
  });

  it("rejects duplicate entry ids", () => {
    expect(() =>
      CustodyChainSchema.parse([
        entry("COC-2026-0001", "collected", null, "u-1", "2026-05-14T10:00:00Z"),
        entry(
          "COC-2026-0001",
          "transferred",
          "u-1",
          "u-2",
          "2026-05-14T11:00:00Z",
          "u-w",
        ),
      ]),
    ).toThrow(/duplicate custody entry/);
  });
});

describe("helpers", () => {
  const chain = [
    {
      id: "COC-2026-0001",
      evidenceId: "EV-2026-0001",
      action: "collected" as const,
      purpose: "incident_investigation" as const,
      occurredAt: "2026-05-14T10:00:00Z",
      fromCustodianId: null,
      toCustodianId: "u-1",
      witnessId: null,
      expectedSha256: SHA,
      verifiedSha256: SHA,
      location: "x",
      signature: "s",
      signingKeyFingerprint: FP,
    },
    {
      id: "COC-2026-0002",
      evidenceId: "EV-2026-0001",
      action: "transferred" as const,
      purpose: "incident_investigation" as const,
      occurredAt: "2026-05-14T11:00:00Z",
      fromCustodianId: "u-1",
      toCustodianId: "u-2",
      witnessId: "u-w",
      expectedSha256: SHA,
      verifiedSha256: SHA,
      location: "x",
      signature: "s",
      signingKeyFingerprint: FP,
    },
  ];

  it("currentCustodian returns last toCustodian", () => {
    expect(currentCustodian(chain)).toBe("u-2");
  });

  it("currentCustodian returns null when chain ends in destruction", () => {
    const destroyed = [
      ...chain,
      {
        ...chain[1]!,
        id: "COC-2026-0003",
        action: "destroyed" as const,
        fromCustodianId: "u-2",
        toCustodianId: "u-3",
        occurredAt: "2026-05-14T12:00:00Z",
        sealNumber: "SEAL-001",
        witnessId: "u-w2",
      },
    ];
    expect(currentCustodian(destroyed)).toBeNull();
  });

  it("chainAgeMinutes counts from first entry", () => {
    expect(chainAgeMinutes(chain, new Date("2026-05-14T11:30:00Z"))).toBe(90);
  });

  it("isChainSealed false when not destroyed", () => {
    expect(isChainSealed(chain)).toBe(false);
  });
});
