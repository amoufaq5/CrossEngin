import { describe, expect, it } from "vitest";
import {
  APP_KINDS,
  APP_RUNTIME_PROFILE,
  AppDeployConfigSchema,
  HEALTH_CHECK_KINDS,
  HealthCheckSchema,
  RUNTIME_PROFILES,
  ResourceLimitsSchema,
  appsByRuntimeProfile,
  gpuApps,
  type AppDeployConfig,
} from "./apps.js";

describe("APP_KINDS / RUNTIME_PROFILES", () => {
  it("enumerates the nine apps", () => {
    expect(APP_KINDS).toHaveLength(9);
    expect(APP_KINDS).toContain("web");
    expect(APP_KINDS).toContain("gpu-inference");
    expect(APP_KINDS).toContain("mobile-shell");
  });

  it("enumerates the five runtime profiles", () => {
    expect(RUNTIME_PROFILES).toHaveLength(5);
    expect(RUNTIME_PROFILES).toContain("serverless_edge");
    expect(RUNTIME_PROFILES).toContain("long_running_service");
  });

  it("APP_RUNTIME_PROFILE covers every AppKind", () => {
    for (const kind of APP_KINDS) {
      expect(APP_RUNTIME_PROFILE[kind]).toBeDefined();
    }
  });
});

describe("HealthCheckSchema", () => {
  it("validates an HTTP health check with defaults", () => {
    const r = HealthCheckSchema.parse({ kind: "http", path: "/health" });
    expect(r.kind).toBe("http");
    if (r.kind === "http") {
      expect(r.expectStatus).toBe(200);
      expect(r.intervalSeconds).toBe(15);
    }
  });

  it("rejects an HTTP path that doesn't start with /", () => {
    expect(() => HealthCheckSchema.parse({ kind: "http", path: "health" })).toThrow();
  });

  it("validates a TCP health check on port 8080", () => {
    const r = HealthCheckSchema.parse({ kind: "tcp", port: 8080 });
    expect(r.kind).toBe("tcp");
  });

  it("rejects a TCP port out of range", () => {
    expect(() => HealthCheckSchema.parse({ kind: "tcp", port: 999_999 })).toThrow();
  });

  it("validates a command health check", () => {
    const r = HealthCheckSchema.parse({ kind: "command", command: "/usr/local/bin/healthz" });
    expect(r.kind).toBe("command");
  });

  it("enumerates three kinds", () => {
    expect(HEALTH_CHECK_KINDS).toEqual(["http", "tcp", "command"]);
  });
});

describe("ResourceLimitsSchema", () => {
  it("accepts minimal config with defaults", () => {
    const r = ResourceLimitsSchema.parse({});
    expect(r.minInstances).toBe(1);
    expect(r.maxInstances).toBe(10);
  });

  it("rejects cpuMillicores below 100", () => {
    expect(() => ResourceLimitsSchema.parse({ cpuMillicores: 50 })).toThrow();
  });

  it("rejects gpuCount above 16", () => {
    expect(() => ResourceLimitsSchema.parse({ gpuCount: 32 })).toThrow();
  });
});

describe("AppDeployConfigSchema", () => {
  const baseWeb: AppDeployConfig = {
    appId: "crossengin-web",
    kind: "web",
    runtimeProfile: "serverless_edge",
    dependsOnApps: [],
    publicEntrypoint: true,
    requiresGpu: false,
    rolloutStrategy: "atomic",
  };

  it("accepts a valid web app", () => {
    expect(() => AppDeployConfigSchema.parse(baseWeb)).not.toThrow();
  });

  it("rejects mismatched kind/runtimeProfile", () => {
    expect(() =>
      AppDeployConfigSchema.parse({ ...baseWeb, runtimeProfile: "long_running_service" }),
    ).toThrow(/runtime profile/);
  });

  it("rejects non-atomic rollout for serverless_edge", () => {
    expect(() =>
      AppDeployConfigSchema.parse({ ...baseWeb, rolloutStrategy: "rolling" }),
    ).toThrow(/atomic/);
  });

  it("requires healthCheck on long_running_service", () => {
    expect(() =>
      AppDeployConfigSchema.parse({
        appId: "cdc-shipper",
        kind: "cdc-shipper",
        runtimeProfile: "long_running_service",
        rolloutStrategy: "rolling",
      }),
    ).toThrow(/healthCheck/);
  });

  it("accepts a long_running_service with healthCheck", () => {
    expect(() =>
      AppDeployConfigSchema.parse({
        appId: "cdc-shipper",
        kind: "cdc-shipper",
        runtimeProfile: "long_running_service",
        healthCheck: { kind: "http", path: "/healthz" },
        rolloutStrategy: "rolling",
      }),
    ).not.toThrow();
  });

  it("requires requiresGpu=true on gpu-inference", () => {
    expect(() =>
      AppDeployConfigSchema.parse({
        appId: "gpu-runner",
        kind: "gpu-inference",
        runtimeProfile: "long_running_service",
        healthCheck: { kind: "tcp", port: 8080 },
        requiresGpu: false,
        rolloutStrategy: "rolling",
      }),
    ).toThrow(/requiresGpu/);
  });

  it("rejects self-dependency", () => {
    expect(() =>
      AppDeployConfigSchema.parse({ ...baseWeb, dependsOnApps: ["crossengin-web"] }),
    ).toThrow(/cannot depend on itself/);
  });

  it("rejects minInstances > maxInstances", () => {
    expect(() =>
      AppDeployConfigSchema.parse({
        ...baseWeb,
        resources: { minInstances: 20, maxInstances: 5 },
      }),
    ).toThrow(/minInstances/);
  });

  it("rejects an invalid appId pattern", () => {
    expect(() => AppDeployConfigSchema.parse({ ...baseWeb, appId: "Crossengin_Web" })).toThrow();
  });
});

describe("helpers", () => {
  const apps: AppDeployConfig[] = [
    {
      appId: "web",
      kind: "web",
      runtimeProfile: "serverless_edge",
      dependsOnApps: [],
      publicEntrypoint: true,
      requiresGpu: false,
      rolloutStrategy: "atomic",
    },
    {
      appId: "gpu",
      kind: "gpu-inference",
      runtimeProfile: "long_running_service",
      healthCheck: { kind: "tcp", port: 8080, intervalSeconds: 15, timeoutSeconds: 5, failureThreshold: 3 },
      dependsOnApps: [],
      publicEntrypoint: false,
      requiresGpu: true,
      rolloutStrategy: "rolling",
    },
  ];

  it("appsByRuntimeProfile filters by profile", () => {
    expect(appsByRuntimeProfile(apps, "serverless_edge")).toHaveLength(1);
    expect(appsByRuntimeProfile(apps, "long_running_service")).toHaveLength(1);
    expect(appsByRuntimeProfile(apps, "managed_service")).toHaveLength(0);
  });

  it("gpuApps returns only GPU-requiring apps", () => {
    expect(gpuApps(apps)).toHaveLength(1);
    expect(gpuApps(apps)[0]?.appId).toBe("gpu");
  });
});
