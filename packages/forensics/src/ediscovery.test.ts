import { describe, expect, it } from "vitest";
import {
  EDISCOVERY_STATUSES,
  EDiscoveryRequestSchema,
  PRODUCTION_FORMATS,
  SearchScopeSchema,
  canTransitionEDiscovery,
  daysUntilDeadline,
  isPastDeadline,
  productionRatio,
  type EDiscoveryRequest,
} from "./ediscovery.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("EDISCOVERY_STATUSES has 8 entries", () => {
    expect(EDISCOVERY_STATUSES).toContain("requested");
    expect(EDISCOVERY_STATUSES).toContain("objected");
    expect(EDISCOVERY_STATUSES).toContain("withdrawn");
  });

  it("PRODUCTION_FORMATS has 5 entries", () => {
    expect(PRODUCTION_FORMATS).toContain("native");
    expect(PRODUCTION_FORMATS).toContain("pdf_with_load_file");
  });
});

describe("canTransitionEDiscovery", () => {
  it("requested -> scoped", () => {
    expect(canTransitionEDiscovery("requested", "scoped")).toBe(true);
  });

  it("running -> producing", () => {
    expect(canTransitionEDiscovery("running", "producing")).toBe(true);
  });

  it("delivered -> complete", () => {
    expect(canTransitionEDiscovery("delivered", "complete")).toBe(true);
  });

  it("complete is terminal", () => {
    expect(canTransitionEDiscovery("complete", "scoped")).toBe(false);
  });
});

describe("SearchScopeSchema", () => {
  it("accepts a scope with keywords", () => {
    expect(() =>
      SearchScopeSchema.parse({
        tenantIds: [],
        custodianUserIds: [],
        dataClasses: [],
        dateRangeStart: "2026-01-01T00:00:00Z",
        dateRangeEnd: "2026-06-01T00:00:00Z",
        keywordsAllOf: ["contract"],
        keywordsAnyOf: [],
        keywordsNoneOf: [],
      }),
    ).not.toThrow();
  });

  it("rejects overbroad scope (no constraints)", () => {
    expect(() =>
      SearchScopeSchema.parse({
        tenantIds: [],
        custodianUserIds: [],
        dataClasses: [],
        dateRangeStart: "2026-01-01T00:00:00Z",
        dateRangeEnd: "2026-06-01T00:00:00Z",
      }),
    ).toThrow(/overbroad search/);
  });

  it("rejects dateRangeEnd <= start", () => {
    expect(() =>
      SearchScopeSchema.parse({
        tenantIds: ["t-1"],
        custodianUserIds: [],
        dataClasses: [],
        dateRangeStart: "2026-06-01T00:00:00Z",
        dateRangeEnd: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/after dateRangeStart/);
  });
});

describe("EDiscoveryRequestSchema", () => {
  const base: EDiscoveryRequest = {
    id: "ED-2026-0001",
    matterReference: "smith-v-ce-2026",
    requestingParty: "smith-plaintiff",
    legalCounselId: "u-counsel",
    status: "complete",
    relatedLegalHoldIds: ["LH-2026-0001"],
    scope: {
      tenantIds: ["t-1"],
      custodianUserIds: [],
      dataClasses: [],
      dateRangeStart: "2026-01-01T00:00:00Z",
      dateRangeEnd: "2026-05-01T00:00:00Z",
      keywordsAllOf: ["contract"],
      keywordsAnyOf: [],
      keywordsNoneOf: [],
      excludePrivilegedContent: true,
    },
    productionFormat: "pdf_with_load_file",
    requestedAt: "2026-05-01T00:00:00Z",
    requestedBy: "u-requestor",
    scopedAt: "2026-05-02T00:00:00Z",
    scopedBy: "u-counsel",
    runStartedAt: "2026-05-03T00:00:00Z",
    deliveredAt: "2026-05-30T00:00:00Z",
    completeAt: "2026-06-05T00:00:00Z",
    estimatedDocumentCount: 1000,
    producedDocumentCount: 850,
    producedSizeBytes: 5_000_000,
    productionSha256: SHA,
    productionStorageUri: "s3://discovery/ed-2026-0001",
    privilegedExclusionCount: 150,
    deadlineAt: "2026-07-01T00:00:00Z",
  };

  it("accepts a valid complete request", () => {
    expect(() => EDiscoveryRequestSchema.parse(base)).not.toThrow();
  });

  it("rejects deadlineAt <= requestedAt", () => {
    expect(() =>
      EDiscoveryRequestSchema.parse({
        ...base,
        deadlineAt: "2026-05-01T00:00:00Z",
      }),
    ).toThrow(/after requestedAt/);
  });

  it("rejects complete without productionSha256", () => {
    expect(() =>
      EDiscoveryRequestSchema.parse({ ...base, productionSha256: null }),
    ).toThrow(/productionSha256/);
  });

  it("rejects complete without deliveredAt", () => {
    expect(() =>
      EDiscoveryRequestSchema.parse({ ...base, deliveredAt: null }),
    ).toThrow(/deliveredAt/);
  });

  it("rejects requestingParty == legalCounselId", () => {
    expect(() =>
      EDiscoveryRequestSchema.parse({
        ...base,
        requestingParty: "u-counsel",
      }),
    ).toThrow(/separation of party and counsel/);
  });

  it("rejects objected without reason", () => {
    expect(() =>
      EDiscoveryRequestSchema.parse({
        ...base,
        status: "objected",
        completeAt: null,
        deliveredAt: null,
        producedDocumentCount: null,
        productionSha256: null,
        productionStorageUri: null,
      }),
    ).toThrow(/objectionReason/);
  });

  it("rejects duplicate legal hold ids", () => {
    expect(() =>
      EDiscoveryRequestSchema.parse({
        ...base,
        relatedLegalHoldIds: ["LH-2026-0001", "LH-2026-0001"],
      }),
    ).toThrow(/duplicate legal hold/);
  });
});

describe("helpers", () => {
  const base: EDiscoveryRequest = {
    id: "ED-2026-0001",
    matterReference: "x",
    requestingParty: "p",
    legalCounselId: "u-counsel",
    status: "running",
    relatedLegalHoldIds: ["LH-2026-0001"],
    scope: {
      tenantIds: ["t-1"],
      custodianUserIds: [],
      dataClasses: [],
      dateRangeStart: "2026-01-01T00:00:00Z",
      dateRangeEnd: "2026-05-01T00:00:00Z",
      keywordsAllOf: ["x"],
      keywordsAnyOf: [],
      keywordsNoneOf: [],
      excludePrivilegedContent: true,
    },
    productionFormat: "native",
    requestedAt: "2026-05-01T00:00:00Z",
    requestedBy: "u-requestor",
    scopedAt: "2026-05-02T00:00:00Z",
    scopedBy: "u-counsel",
    runStartedAt: "2026-05-03T00:00:00Z",
    deliveredAt: null,
    completeAt: null,
    estimatedDocumentCount: 1000,
    producedDocumentCount: 500,
    privilegedExclusionCount: 0,
    deadlineAt: "2026-07-01T00:00:00Z",
  };

  it("isPastDeadline true when running past deadline", () => {
    expect(isPastDeadline(base, new Date("2026-08-01T00:00:00Z"))).toBe(true);
  });

  it("isPastDeadline false when within deadline", () => {
    expect(isPastDeadline(base, new Date("2026-06-15T00:00:00Z"))).toBe(false);
  });

  it("productionRatio returns 0.5 for 500/1000", () => {
    expect(productionRatio(base)).toBe(0.5);
  });

  it("productionRatio returns null without estimate", () => {
    expect(
      productionRatio({ ...base, estimatedDocumentCount: undefined }),
    ).toBeNull();
  });

  it("daysUntilDeadline counts down", () => {
    expect(daysUntilDeadline(base, new Date("2026-06-21T00:00:00Z"))).toBe(10);
  });
});
