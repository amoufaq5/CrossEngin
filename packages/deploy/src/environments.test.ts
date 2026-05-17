import { describe, expect, it } from "vitest";
import {
  DEPLOY_STRATEGIES,
  DEPLOY_TARGETS,
  ENVIRONMENTS,
  ENVIRONMENT_STRATEGY,
  EnvironmentConfigSchema,
  EnvironmentSetSchema,
  RUNTIME_TARGET,
  findEnvironment,
  primaryProductionRegion,
  targetFor,
  type EnvironmentConfig,
} from "./environments.js";

describe("ENVIRONMENTS / DEPLOY_TARGETS / DEPLOY_STRATEGIES", () => {
  it("enumerates four environments", () => {
    expect(ENVIRONMENTS).toEqual(["local", "preview", "staging", "production"]);
  });

  it("enumerates ten deploy targets", () => {
    expect(DEPLOY_TARGETS).toHaveLength(10);
    expect(DEPLOY_TARGETS).toContain("vercel");
    expect(DEPLOY_TARGETS).toContain("fly_machines");
    expect(DEPLOY_TARGETS).toContain("supabase");
  });

  it("enumerates four strategies", () => {
    expect(DEPLOY_STRATEGIES).toEqual(["atomic", "rolling", "blue_green", "canary"]);
  });

  it("ENVIRONMENT_STRATEGY constrains by environment", () => {
    expect(ENVIRONMENT_STRATEGY.local).toEqual(["atomic"]);
    expect(ENVIRONMENT_STRATEGY.production).toContain("canary");
  });

  it("RUNTIME_TARGET maps each runtime profile to a target", () => {
    expect(RUNTIME_TARGET.serverless_edge).toBe("vercel");
    expect(RUNTIME_TARGET.long_running_service).toBe("fly_machines");
    expect(RUNTIME_TARGET.native_wrapper).toBe("app_store");
  });
});

describe("EnvironmentConfigSchema", () => {
  const baseProduction: EnvironmentConfig = {
    environment: "production",
    region: "eu-central",
    isPrimary: true,
    targets: ["vercel", "fly_machines", "supabase"],
    credentials: [],
    allowedStrategies: ["rolling", "blue_green", "canary"],
    branchProtection: true,
    requiresManualPromotion: true,
    syntheticChecks: true,
  };

  it("accepts a valid production config", () => {
    expect(() => EnvironmentConfigSchema.parse(baseProduction)).not.toThrow();
  });

  it("rejects production without branchProtection", () => {
    expect(() =>
      EnvironmentConfigSchema.parse({ ...baseProduction, branchProtection: false }),
    ).toThrow(/branchProtection/);
  });

  it("rejects production without syntheticChecks", () => {
    expect(() =>
      EnvironmentConfigSchema.parse({ ...baseProduction, syntheticChecks: false }),
    ).toThrow(/syntheticChecks/);
  });

  it("rejects a strategy not allowed for the environment", () => {
    expect(() =>
      EnvironmentConfigSchema.parse({
        environment: "local",
        region: "eu-central",
        targets: ["vercel"],
        allowedStrategies: ["canary"],
      }),
    ).toThrow(/not allowed in environment 'local'/);
  });

  it("rejects duplicate credentials for the same target", () => {
    expect(() =>
      EnvironmentConfigSchema.parse({
        ...baseProduction,
        credentials: [
          { target: "vercel", vault: "v1" },
          { target: "vercel", vault: "v2" },
        ],
      }),
    ).toThrow(/duplicate credentials/);
  });

  it("rejects credentials for a target not in this environment", () => {
    expect(() =>
      EnvironmentConfigSchema.parse({
        ...baseProduction,
        credentials: [{ target: "ghcr", vault: "v1" }],
      }),
    ).toThrow(/not in this environment/);
  });
});

describe("EnvironmentSetSchema", () => {
  it("accepts a set with one primary per environment", () => {
    const set = [
      {
        environment: "production",
        region: "eu-central",
        isPrimary: true,
        targets: ["vercel"],
        credentials: [],
        allowedStrategies: ["canary"],
        branchProtection: true,
        requiresManualPromotion: true,
        syntheticChecks: true,
      },
      {
        environment: "production",
        region: "us-east",
        isPrimary: false,
        targets: ["vercel"],
        credentials: [],
        allowedStrategies: ["canary"],
        branchProtection: true,
        requiresManualPromotion: true,
        syntheticChecks: true,
      },
    ];
    expect(() => EnvironmentSetSchema.parse(set)).not.toThrow();
  });

  it("rejects more than one primary in the same environment", () => {
    const set = [
      {
        environment: "production",
        region: "eu-central",
        isPrimary: true,
        targets: ["vercel"],
        credentials: [],
        allowedStrategies: ["canary"],
        branchProtection: true,
        requiresManualPromotion: true,
        syntheticChecks: true,
      },
      {
        environment: "production",
        region: "us-east",
        isPrimary: true,
        targets: ["vercel"],
        credentials: [],
        allowedStrategies: ["canary"],
        branchProtection: true,
        requiresManualPromotion: true,
        syntheticChecks: true,
      },
    ];
    expect(() => EnvironmentSetSchema.parse(set)).toThrow(/has 2 primaries/);
  });

  it("rejects duplicate environment+region pairs", () => {
    const set = [
      {
        environment: "production",
        region: "eu-central",
        isPrimary: true,
        targets: ["vercel"],
        credentials: [],
        allowedStrategies: ["canary"],
        branchProtection: true,
        requiresManualPromotion: true,
        syntheticChecks: true,
      },
      {
        environment: "production",
        region: "eu-central",
        isPrimary: false,
        targets: ["vercel"],
        credentials: [],
        allowedStrategies: ["canary"],
        branchProtection: true,
        requiresManualPromotion: true,
        syntheticChecks: true,
      },
    ];
    expect(() => EnvironmentSetSchema.parse(set)).toThrow(/duplicate environment\+region/);
  });
});

describe("helpers", () => {
  const set: EnvironmentConfig[] = [
    {
      environment: "production",
      region: "eu-central",
      isPrimary: true,
      targets: ["vercel"],
      credentials: [],
      allowedStrategies: ["canary"],
      branchProtection: true,
      requiresManualPromotion: true,
      syntheticChecks: true,
    },
    {
      environment: "production",
      region: "us-east",
      isPrimary: false,
      targets: ["vercel"],
      credentials: [],
      allowedStrategies: ["canary"],
      branchProtection: true,
      requiresManualPromotion: true,
      syntheticChecks: true,
    },
  ];

  it("targetFor returns the expected target", () => {
    expect(targetFor("serverless_edge")).toBe("vercel");
    expect(targetFor("long_running_service")).toBe("fly_machines");
  });

  it("findEnvironment matches by env+region", () => {
    expect(findEnvironment(set, "production", "eu-central")?.isPrimary).toBe(true);
    expect(findEnvironment(set, "production", "us-east")?.isPrimary).toBe(false);
    expect(findEnvironment(set, "staging", "eu-central")).toBeNull();
  });

  it("primaryProductionRegion finds the one marked primary", () => {
    expect(primaryProductionRegion(set)).toBe("eu-central");
  });

  it("primaryProductionRegion returns null when none is primary", () => {
    expect(primaryProductionRegion([])).toBeNull();
  });
});
