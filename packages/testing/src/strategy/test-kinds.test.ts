import { describe, expect, it } from "vitest";
import {
  activeSuite,
  evaluatePyramid,
  PYRAMID_TARGET,
  quarantinedSuite,
  TestSpecSchema,
  TestSuiteSchema,
  TEST_KINDS,
} from "./test-kinds.js";

const baseSpec = {
  id: "kernel-emit-create-table",
  kind: "unit" as const,
  description: "emitCreateTable produces deterministic SQL",
  package: "@crossengin/kernel",
  filePath: "packages/kernel/src/ddl/emit.test.ts",
  estimatedRuntimeMs: 50,
};

describe("TEST_KINDS + PYRAMID_TARGET", () => {
  it("declares the ten test kinds", () => {
    expect(TEST_KINDS).toHaveLength(10);
    expect(TEST_KINDS).toContain("unit");
    expect(TEST_KINDS).toContain("eval");
    expect(TEST_KINDS).toContain("visual_regression");
  });

  it("PYRAMID_TARGET declares targets for every kind", () => {
    for (const kind of TEST_KINDS) {
      expect(PYRAMID_TARGET[kind]).toBeGreaterThan(0);
    }
  });

  it("unit-test target dwarfs E2E target (pyramid shape)", () => {
    expect(PYRAMID_TARGET.unit).toBeGreaterThan(PYRAMID_TARGET.e2e * 100);
  });
});

describe("TestSpecSchema", () => {
  it("parses a valid unit test spec", () => {
    expect(() => TestSpecSchema.parse(baseSpec)).not.toThrow();
  });

  it("rejects non-@crossengin packages", () => {
    expect(() =>
      TestSpecSchema.parse({ ...baseSpec, package: "@third-party/x" }),
    ).toThrow();
  });

  it("rejects quarantined tests without reason", () => {
    expect(() =>
      TestSpecSchema.parse({ ...baseSpec, quarantined: true }),
    ).toThrow(/must declare quarantineReason/);
  });

  it("rejects quarantineReason on an active test", () => {
    expect(() =>
      TestSpecSchema.parse({
        ...baseSpec,
        quarantined: false,
        quarantineReason: "x",
      }),
    ).toThrow();
  });
});

describe("TestSuiteSchema + helpers", () => {
  it("rejects duplicate test ids", () => {
    expect(() =>
      TestSuiteSchema.parse([baseSpec, { ...baseSpec, kind: "property" as const }]),
    ).toThrow(/duplicate test id/);
  });

  it("activeSuite excludes quarantined tests", () => {
    const suite = TestSuiteSchema.parse([
      baseSpec,
      {
        ...baseSpec,
        id: "kernel-rls-flaky",
        quarantined: true,
        quarantineReason: "intermittent connection drops",
      },
    ]);
    expect(activeSuite(suite)).toHaveLength(1);
    expect(quarantinedSuite(suite)).toHaveLength(1);
  });
});

describe("evaluatePyramid", () => {
  it("flags under-targeted kinds and ok kinds", () => {
    const suite = TestSuiteSchema.parse([baseSpec]);
    const result = evaluatePyramid(suite);
    const unitShape = result.find((s) => s.kind === "unit");
    expect(unitShape?.count).toBe(1);
    expect(unitShape?.status).toBe("under");
  });

  it("excludes quarantined tests from counts", () => {
    const suite = TestSuiteSchema.parse([
      baseSpec,
      {
        ...baseSpec,
        id: "kernel-rls-flaky",
        quarantined: true,
        quarantineReason: "intermittent",
      },
    ]);
    const unitShape = evaluatePyramid(suite).find((s) => s.kind === "unit");
    expect(unitShape?.count).toBe(1);
  });
});
