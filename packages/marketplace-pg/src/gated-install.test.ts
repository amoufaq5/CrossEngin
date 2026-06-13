import type { PackInstallation } from "@crossengin/marketplace";
import { describe, expect, it } from "vitest";

import { installPackGated, type InstallGateVerdict } from "./gated-install.js";
import type { PostgresPackInstallationStore } from "./installation-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";

function fakeStore(active: PackInstallation | null = null): { store: Pick<PostgresPackInstallationStore, "record" | "activeForPack">; recorded: PackInstallation[] } {
  const recorded: PackInstallation[] = [];
  return {
    recorded,
    store: {
      activeForPack: async () => active,
      record: async (i: PackInstallation) => void recorded.push(i),
    } as unknown as Pick<PostgresPackInstallationStore, "record" | "activeForPack">,
  };
}

const DEPS = { now: () => new Date("2026-06-13T00:00:00.000Z"), newId: () => "11111111-1111-4111-8111-111111111111" };

function input(verdict: InstallGateVerdict, over: Partial<Parameters<typeof installPackGated>[1]> = {}) {
  return { verdict, tenantId: TENANT, packId: "acme.crm.sales", version: "2.0.0", installedBy: USER, ...DEPS, ...over };
}

describe("installPackGated", () => {
  it("does NOT install on a refuse verdict", async () => {
    const fs = fakeStore();
    const result = await installPackGated(fs.store, input({ decision: "refuse" }));
    expect(result).toEqual({ installed: false, reason: "refused" });
    expect(fs.recorded).toHaveLength(0);
  });

  it("requires confirmation on a confirm verdict that wasn't confirmed", async () => {
    const fs = fakeStore();
    const result = await installPackGated(fs.store, input({ decision: "confirm" }));
    expect(result).toEqual({ installed: false, reason: "confirmation_required" });
    expect(fs.recorded).toHaveLength(0);
  });

  it("installs a confirmed confirm verdict", async () => {
    const fs = fakeStore();
    const result = await installPackGated(fs.store, input({ decision: "confirm" }, { confirmed: true }));
    expect(result.installed).toBe(true);
    expect(fs.recorded[0]?.status).toBe("installed");
  });

  it("installs on an allow verdict + persists an 'installed' record", async () => {
    const fs = fakeStore();
    const result = await installPackGated(fs.store, input({ decision: "allow" }));
    expect(result.installed).toBe(true);
    if (result.installed) {
      expect(result.installation).toMatchObject({ status: "installed", installedVersion: "2.0.0", installedBy: USER, packId: "acme.crm.sales" });
    }
    expect(fs.recorded).toHaveLength(1);
  });

  it("short-circuits as already_installed when an active install exists", async () => {
    const active = { id: "x", tenantId: TENANT, packId: "acme.crm.sales", status: "installed" } as unknown as PackInstallation;
    const fs = fakeStore(active);
    const result = await installPackGated(fs.store, input({ decision: "allow" }));
    expect(result).toEqual({ installed: false, reason: "already_installed" });
    expect(fs.recorded).toHaveLength(0);
  });
});
