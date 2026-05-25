import { describe, expect, it } from "vitest";
import {
  INSTALLATION_STATUSES,
  PackInstallationSchema,
  PackInstallationSetSchema,
  UPDATE_POLICIES,
  activeInstallations,
  canTransitionInstallation,
  installationFor,
  shouldAutoUpdate,
  type PackInstallation,
} from "./installations.js";

describe("constants", () => {
  it("INSTALLATION_STATUSES has 8 entries", () => {
    expect(INSTALLATION_STATUSES).toHaveLength(8);
    expect(INSTALLATION_STATUSES).toContain("permission_pending");
    expect(INSTALLATION_STATUSES).toContain("uninstalled");
  });

  it("UPDATE_POLICIES has 4 entries", () => {
    expect(UPDATE_POLICIES).toEqual(["manual", "patch_auto", "minor_auto", "track_latest"]);
  });
});

describe("canTransitionInstallation", () => {
  it("installing -> installed", () => {
    expect(canTransitionInstallation("installing", "installed")).toBe(true);
  });

  it("installed -> updating", () => {
    expect(canTransitionInstallation("installed", "updating")).toBe(true);
  });

  it("installed -> uninstalling", () => {
    expect(canTransitionInstallation("installed", "uninstalling")).toBe(true);
  });

  it("uninstalled -> installing (reinstall)", () => {
    expect(canTransitionInstallation("uninstalled", "installing")).toBe(true);
  });

  it("installing -> uninstalled is not a valid direct transition", () => {
    expect(canTransitionInstallation("installing", "uninstalled")).toBe(false);
  });
});

describe("PackInstallationSchema", () => {
  const base: PackInstallation = {
    id: "inst-1",
    tenantId: "t-1",
    packId: "com.crossengin.pharmacy",
    installedVersion: "1.0.0",
    pinnedVersion: null,
    status: "installed",
    updatePolicy: "manual",
    config: {},
    permissionGrants: [],
    requestedAt: "2026-05-14T10:00:00Z",
    requestedBy: "u-1",
    installedAt: "2026-05-14T10:05:00Z",
    installedBy: "u-1",
    lastUpdatedAt: null,
    uninstalledAt: null,
    uninstalledBy: null,
  };

  it("accepts a valid installed record", () => {
    expect(() => PackInstallationSchema.parse(base)).not.toThrow();
  });

  it("rejects installed without installedVersion", () => {
    expect(() => PackInstallationSchema.parse({ ...base, installedVersion: null })).toThrow(
      /installedVersion/,
    );
  });

  it("rejects installed without installedAt", () => {
    expect(() => PackInstallationSchema.parse({ ...base, installedAt: null })).toThrow(
      /installedAt/,
    );
  });

  it("rejects uninstalled without uninstalledAt + uninstalledBy", () => {
    expect(() =>
      PackInstallationSchema.parse({
        ...base,
        status: "uninstalled",
        installedVersion: null,
        installedAt: null,
        installedBy: null,
      }),
    ).toThrow(/uninstalledAt/);
  });

  it("rejects failed without failureReason", () => {
    expect(() =>
      PackInstallationSchema.parse({
        ...base,
        status: "failed",
        installedVersion: null,
        installedAt: null,
        installedBy: null,
      }),
    ).toThrow(/failureReason/);
  });

  it("rejects pinnedVersion with non-manual update policy", () => {
    expect(() =>
      PackInstallationSchema.parse({
        ...base,
        pinnedVersion: "1.0.0",
        updatePolicy: "patch_auto",
      }),
    ).toThrow(/manual/);
  });
});

describe("PackInstallationSetSchema", () => {
  const inst = (
    id: string,
    packId: string,
    status: PackInstallation["status"] = "installed",
  ): PackInstallation => ({
    id,
    tenantId: "t-1",
    packId,
    installedVersion: status === "installed" ? "1.0.0" : null,
    pinnedVersion: null,
    status,
    updatePolicy: "manual",
    config: {},
    permissionGrants: [],
    requestedAt: "2026-05-14T10:00:00Z",
    requestedBy: "u-1",
    installedAt: status === "installed" ? "2026-05-14T10:05:00Z" : null,
    installedBy: status === "installed" ? "u-1" : null,
    lastUpdatedAt: null,
    uninstalledAt: status === "uninstalled" ? "2026-05-14T11:00:00Z" : null,
    uninstalledBy: status === "uninstalled" ? "u-1" : null,
  });

  it("accepts distinct installations", () => {
    expect(() =>
      PackInstallationSetSchema.parse([
        inst("a", "com.crossengin.x"),
        inst("b", "com.crossengin.y"),
      ]),
    ).not.toThrow();
  });

  it("rejects duplicate installation ids", () => {
    expect(() =>
      PackInstallationSetSchema.parse([
        inst("a", "com.crossengin.x"),
        inst("a", "com.crossengin.y"),
      ]),
    ).toThrow(/duplicate installation id/);
  });

  it("rejects two active installations of the same pack for one tenant", () => {
    expect(() =>
      PackInstallationSetSchema.parse([
        inst("a", "com.crossengin.x"),
        inst("b", "com.crossengin.x"),
      ]),
    ).toThrow(/already has an active installation/);
  });

  it("allows reinstall after uninstall", () => {
    expect(() =>
      PackInstallationSetSchema.parse([
        inst("a", "com.crossengin.x", "uninstalled"),
        inst("b", "com.crossengin.x"),
      ]),
    ).not.toThrow();
  });
});

describe("activeInstallations / installationFor", () => {
  const set = [
    {
      id: "a",
      tenantId: "t-1",
      packId: "com.crossengin.x",
      installedVersion: "1.0.0",
      pinnedVersion: null,
      status: "installed" as const,
      updatePolicy: "manual" as const,
      config: {},
      permissionGrants: [],
      requestedAt: "2026-05-14T10:00:00Z",
      requestedBy: "u-1",
      installedAt: "2026-05-14T10:05:00Z",
      installedBy: "u-1",
      lastUpdatedAt: null,
      uninstalledAt: null,
      uninstalledBy: null,
    },
    {
      id: "b",
      tenantId: "t-1",
      packId: "com.crossengin.y",
      installedVersion: null,
      pinnedVersion: null,
      status: "uninstalled" as const,
      updatePolicy: "manual" as const,
      config: {},
      permissionGrants: [],
      requestedAt: "2026-05-14T10:00:00Z",
      requestedBy: "u-1",
      installedAt: null,
      installedBy: null,
      lastUpdatedAt: null,
      uninstalledAt: "2026-05-14T12:00:00Z",
      uninstalledBy: "u-1",
    },
  ];

  it("activeInstallations excludes uninstalled", () => {
    expect(activeInstallations(set, "t-1").map((i) => i.id)).toEqual(["a"]);
  });

  it("installationFor finds active install", () => {
    expect(installationFor(set, "t-1", "com.crossengin.x")?.id).toBe("a");
  });

  it("installationFor returns null for uninstalled-only", () => {
    expect(installationFor(set, "t-1", "com.crossengin.y")).toBeNull();
  });
});

describe("shouldAutoUpdate", () => {
  const base = {
    id: "a",
    tenantId: "t-1",
    packId: "com.crossengin.x",
    installedVersion: "1.2.3",
    pinnedVersion: null,
    status: "installed" as const,
    updatePolicy: "patch_auto" as const,
    config: {},
    permissionGrants: [],
    requestedAt: "2026-05-14T10:00:00Z",
    requestedBy: "u-1",
    installedAt: "2026-05-14T10:05:00Z",
    installedBy: "u-1",
    lastUpdatedAt: null,
    uninstalledAt: null,
    uninstalledBy: null,
  };

  it("manual policy never auto-updates", () => {
    expect(shouldAutoUpdate({ ...base, updatePolicy: "manual" }, "1.2.4")).toBe(false);
  });

  it("patch_auto updates within same minor", () => {
    expect(shouldAutoUpdate(base, "1.2.4")).toBe(true);
  });

  it("patch_auto does not cross minor boundary", () => {
    expect(shouldAutoUpdate(base, "1.3.0")).toBe(false);
  });

  it("minor_auto updates within same major", () => {
    expect(shouldAutoUpdate({ ...base, updatePolicy: "minor_auto" }, "1.5.0")).toBe(true);
  });

  it("minor_auto does not cross major boundary", () => {
    expect(shouldAutoUpdate({ ...base, updatePolicy: "minor_auto" }, "2.0.0")).toBe(false);
  });

  it("track_latest accepts any newer version", () => {
    expect(shouldAutoUpdate({ ...base, updatePolicy: "track_latest" }, "9.9.9")).toBe(true);
  });
});
