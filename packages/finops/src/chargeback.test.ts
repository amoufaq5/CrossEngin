import { describe, expect, it } from "vitest";
import {
  COST_CENTER_KINDS,
  ChargebackStatementSchema,
  CostCenterSchema,
  isCostCenterActive,
  isStatementPosted,
  linesByCostCenter,
  type ChargebackStatement,
  type CostCenter,
} from "./chargeback.js";

describe("constants", () => {
  it("COST_CENTER_KINDS has 7 entries", () => {
    expect(COST_CENTER_KINDS).toContain("engineering");
    expect(COST_CENTER_KINDS).toContain("shared_infrastructure");
    expect(COST_CENTER_KINDS).toContain("compliance");
  });
});

describe("CostCenterSchema", () => {
  const base: CostCenter = {
    id: "cc-0001",
    label: "Platform Engineering",
    kind: "engineering",
    parentCostCenterId: null,
    businessUnit: "platform",
    owner: "eng-lead",
    createdAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
  };

  it("accepts a valid cost center", () => {
    expect(() => CostCenterSchema.parse(base)).not.toThrow();
  });

  it("rejects malformed cost center id", () => {
    expect(() => CostCenterSchema.parse({ ...base, id: "cc-1" })).toThrow();
  });

  it("rejects self-parenting", () => {
    expect(() => CostCenterSchema.parse({ ...base, parentCostCenterId: "cc-0001" })).toThrow(
      /cannot parent itself/,
    );
  });

  it("rejects archivedAt without reason", () => {
    expect(() => CostCenterSchema.parse({ ...base, archivedAt: "2026-06-01T00:00:00Z" })).toThrow(
      /archivedReason/,
    );
  });
});

describe("ChargebackStatementSchema", () => {
  const base: ChargebackStatement = {
    id: "cb-1",
    periodStart: "2026-05-01T00:00:00Z",
    periodEnd: "2026-06-01T00:00:00Z",
    currency: "USD",
    totalAmountCents: 100_000,
    lines: [
      {
        costCenterId: "cc-0001",
        amountCents: 60_000,
        percentOfTotal: 60,
        description: "Engineering compute",
      },
      {
        costCenterId: "cc-0002",
        amountCents: 40_000,
        percentOfTotal: 40,
        description: "Product analytics",
      },
    ],
    generatedAt: "2026-06-02T00:00:00Z",
    generatedBy: "u-finops",
    approvedAt: null,
    approvedBy: null,
    status: "draft",
  };

  it("accepts a valid draft statement", () => {
    expect(() => ChargebackStatementSchema.parse(base)).not.toThrow();
  });

  it("rejects lines sum mismatch with total", () => {
    expect(() =>
      ChargebackStatementSchema.parse({
        ...base,
        totalAmountCents: 200_000,
      }),
    ).toThrow(/lines sum/);
  });

  it("rejects percent sum != 100", () => {
    expect(() =>
      ChargebackStatementSchema.parse({
        ...base,
        lines: [
          {
            costCenterId: "cc-0001",
            amountCents: 60_000,
            percentOfTotal: 50,
            description: "x",
          },
          {
            costCenterId: "cc-0002",
            amountCents: 40_000,
            percentOfTotal: 40,
            description: "y",
          },
        ],
      }),
    ).toThrow(/~100/);
  });

  it("rejects duplicate cost center in lines", () => {
    expect(() =>
      ChargebackStatementSchema.parse({
        ...base,
        lines: [
          {
            costCenterId: "cc-0001",
            amountCents: 50_000,
            percentOfTotal: 50,
            description: "x",
          },
          {
            costCenterId: "cc-0001",
            amountCents: 50_000,
            percentOfTotal: 50,
            description: "y",
          },
        ],
      }),
    ).toThrow(/duplicate cost center/);
  });

  it("rejects approved/posted without approvedAt + approvedBy", () => {
    expect(() => ChargebackStatementSchema.parse({ ...base, status: "approved" })).toThrow(
      /approvedBy/,
    );
  });

  it("rejects voided without voidedReason", () => {
    expect(() => ChargebackStatementSchema.parse({ ...base, status: "voided" })).toThrow(
      /voidedReason/,
    );
  });
});

describe("helpers", () => {
  const statement: ChargebackStatement = {
    id: "cb-1",
    periodStart: "2026-05-01T00:00:00Z",
    periodEnd: "2026-06-01T00:00:00Z",
    currency: "USD",
    totalAmountCents: 100_000,
    lines: [
      {
        costCenterId: "cc-0001",
        amountCents: 100_000,
        percentOfTotal: 100,
        description: "all",
      },
    ],
    generatedAt: "2026-06-02T00:00:00Z",
    generatedBy: "u-finops",
    approvedAt: "2026-06-03T00:00:00Z",
    approvedBy: "u-cfo",
    status: "posted",
  };

  it("linesByCostCenter maps id->line", () => {
    const map = linesByCostCenter(statement);
    expect(map["cc-0001"]?.amountCents).toBe(100_000);
  });

  it("isStatementPosted true for posted", () => {
    expect(isStatementPosted(statement)).toBe(true);
    expect(isStatementPosted({ ...statement, status: "draft" })).toBe(false);
  });

  it("isCostCenterActive false after archive", () => {
    const cc: CostCenter = {
      id: "cc-0001",
      label: "x",
      kind: "engineering",
      parentCostCenterId: null,
      businessUnit: "platform",
      owner: "u",
      createdAt: "2026-01-01T00:00:00Z",
      archivedAt: "2026-06-01T00:00:00Z",
      archivedReason: "reorg",
    };
    expect(isCostCenterActive(cc)).toBe(false);
  });
});
