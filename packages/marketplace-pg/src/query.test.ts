import type { PackInstallation } from "@crossengin/marketplace";
import { describe, expect, it } from "vitest";

import {
  CliUsageError,
  parseMarketplaceArgs,
  runMarketplace,
  verifyInstallations,
  type MarketplaceCliOptions,
  type MarketplaceSource,
} from "./query.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";

function install(over: Partial<PackInstallation> = {}): PackInstallation {
  return {
    id: "inst-1",
    tenantId: TENANT,
    packId: "acme.crm.sales",
    installedVersion: "1.0.0",
    pinnedVersion: null,
    status: "installed",
    updatePolicy: "manual",
    config: {},
    permissionGrants: [],
    requestedAt: "2026-06-11T00:00:00.000Z",
    requestedBy: USER,
    installedAt: "2026-06-11T00:05:00.000Z",
    installedBy: USER,
    lastUpdatedAt: "2026-06-11T00:05:00.000Z",
    uninstalledAt: null,
    uninstalledBy: null,
    ...over,
  } as unknown as PackInstallation;
}

function source(initial: readonly PackInstallation[] = []): MarketplaceSource & { recorded: PackInstallation[] } {
  const recorded: PackInstallation[] = [];
  return {
    recorded,
    listForTenant: async () => [...initial, ...recorded],
    activeForPack: async (_t, packId) => [...recorded, ...initial].find((i) => i.packId === packId && i.status !== "uninstalled" && i.status !== "failed") ?? null,
    record: async (i) => void recorded.push(i),
  };
}

const DEPS = { now: () => new Date("2026-06-11T12:00:00.000Z"), newId: () => "11111111-1111-4111-8111-111111111111" };

function opts(over: Partial<MarketplaceCliOptions>): MarketplaceCliOptions {
  return { command: "list", tenant: TENANT, pack: null, version: null, by: null, updatePolicy: null, status: null, limit: null, format: "human", help: false, ...over };
}

describe("verifyInstallations", () => {
  it("is clean for a single active install per pack", () => {
    expect(verifyInstallations([install()])).toEqual([]);
  });

  it("flags two active installs of the same pack", () => {
    const issues = verifyInstallations([install({ id: "a" }), install({ id: "b", status: "installing", installedVersion: null } as Partial<PackInstallation>)]);
    expect(issues.map((i) => i.kind)).toContain("duplicate_active_install");
  });

  it("ignores terminal installs (uninstalled/failed)", () => {
    expect(verifyInstallations([install({ id: "a" }), install({ id: "b", status: "uninstalled", uninstalledAt: "2026-06-12T00:00:00.000Z", uninstalledBy: USER } as Partial<PackInstallation>)])).toEqual([]);
  });
});

describe("runMarketplace", () => {
  it("list returns exit 0 + formatted output", async () => {
    const lines: string[] = [];
    const res = await runMarketplace(opts({ command: "list" }), source([install()]), (l) => lines.push(l), DEPS);
    expect(res.exitCode).toBe(0);
    expect(lines[0]).toContain("acme.crm.sales [installed]");
  });

  it("verify exits 0 clean / 1 on drift", async () => {
    expect((await runMarketplace(opts({ command: "verify" }), source([install()]), () => {}, DEPS)).exitCode).toBe(0);
    const dup = source([install({ id: "a" }), install({ id: "b", status: "installing", installedVersion: null } as Partial<PackInstallation>)]);
    expect((await runMarketplace(opts({ command: "verify" }), dup, () => {}, DEPS)).exitCode).toBe(1);
  });

  it("install drives the engine + records an 'installed' record", async () => {
    const src = source();
    const res = await runMarketplace(opts({ command: "install", pack: "acme.crm.sales", version: "2.0.0", by: USER }), src, () => {}, DEPS);
    expect(res.exitCode).toBe(0);
    expect(src.recorded).toHaveLength(1);
    expect(src.recorded[0]!.status).toBe("installed");
    expect(src.recorded[0]!.installedVersion).toBe("2.0.0");
    expect(src.recorded[0]!.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("install refuses when an active install already exists", async () => {
    const res = await runMarketplace(opts({ command: "install", pack: "acme.crm.sales", version: "2.0.0", by: USER }), source([install()]), () => {}, DEPS);
    expect(res.exitCode).toBe(1);
  });

  it("uninstall records an 'uninstalled' record for an installed pack", async () => {
    const src = source([install()]);
    const res = await runMarketplace(opts({ command: "uninstall", pack: "acme.crm.sales", by: USER }), src, () => {}, DEPS);
    expect(res.exitCode).toBe(0);
    expect(src.recorded[0]!.status).toBe("uninstalled");
  });

  it("uninstall refuses when the pack is not installed", async () => {
    const res = await runMarketplace(opts({ command: "uninstall", pack: "nope.pack.x", by: USER }), source(), () => {}, DEPS);
    expect(res.exitCode).toBe(1);
  });
});

describe("parseMarketplaceArgs", () => {
  it("parses list/verify with --tenant", () => {
    expect(parseMarketplaceArgs(["list", "--tenant", TENANT]).command).toBe("list");
    expect(parseMarketplaceArgs(["verify", "--tenant", TENANT, "--format", "json"]).format).toBe("json");
  });

  it("parses install with the required flags", () => {
    const o = parseMarketplaceArgs(["install", "--tenant", TENANT, "--pack", "acme.crm.sales", "--version", "1.0.0", "--by", USER, "--update-policy", "minor_auto"]);
    expect(o).toMatchObject({ command: "install", pack: "acme.crm.sales", version: "1.0.0", by: USER, updatePolicy: "minor_auto" });
  });

  it("requires --tenant + the per-command flags", () => {
    expect(() => parseMarketplaceArgs(["list"])).toThrow(CliUsageError);
    expect(() => parseMarketplaceArgs(["install", "--tenant", TENANT, "--pack", "x.y.z"])).toThrow(CliUsageError);
    expect(() => parseMarketplaceArgs(["uninstall", "--tenant", TENANT])).toThrow(CliUsageError);
  });

  it("rejects an unknown command + invalid enums", () => {
    expect(() => parseMarketplaceArgs(["nope"])).toThrow(CliUsageError);
    expect(() => parseMarketplaceArgs(["list", "--tenant", TENANT, "--status", "bogus"])).toThrow(CliUsageError);
  });

  it("treats no args / --help as help", () => {
    expect(parseMarketplaceArgs([]).help).toBe(true);
    expect(parseMarketplaceArgs(["install", "--help"]).help).toBe(true);
  });
});
