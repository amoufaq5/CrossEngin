import { PackInstallationSchema } from "@crossengin/marketplace";
import { describe, expect, it } from "vitest";

import {
  IllegalInstallationTransitionError,
  beginInstall,
  completeInstall,
  completeUninstall,
  failInstallation,
  newInstallationRequest,
  requestUninstall,
  transitionInstallation,
} from "./engine.js";

const REQ = {
  id: "inst-1",
  tenantId: "00000000-0000-4000-8000-000000000001",
  packId: "acme.crm.sales",
  requestedBy: "00000000-0000-4000-8000-0000000000aa",
  requestedAt: "2026-06-11T00:00:00.000Z",
};

describe("newInstallationRequest", () => {
  it("starts in 'requested' (or 'permission_pending' when grants are needed)", () => {
    expect(newInstallationRequest(REQ).status).toBe("requested");
    expect(newInstallationRequest({ ...REQ, requiresPermissions: true }).status).toBe("permission_pending");
  });

  it("produces a schema-valid installation with null installedVersion", () => {
    const inst = newInstallationRequest(REQ);
    expect(() => PackInstallationSchema.parse(inst)).not.toThrow();
    expect(inst.installedVersion).toBeNull();
    expect(inst.updatePolicy).toBe("manual");
  });
});

describe("transitionInstallation", () => {
  it("drives the happy path requested → installing → installed", () => {
    const installing = beginInstall(newInstallationRequest(REQ));
    expect(installing.status).toBe("installing");
    const installed = completeInstall(installing, {
      version: "1.2.0",
      installedBy: "00000000-0000-4000-8000-0000000000bb",
      at: "2026-06-11T00:05:00.000Z",
    });
    expect(installed.status).toBe("installed");
    expect(installed.installedVersion).toBe("1.2.0");
    expect(installed.installedAt).toBe("2026-06-11T00:05:00.000Z");
    expect(installed.installedBy).toBe("00000000-0000-4000-8000-0000000000bb");
  });

  it("drives installed → uninstalling → uninstalled", () => {
    const installed = completeInstall(beginInstall(newInstallationRequest(REQ)), {
      version: "1.0.0",
      installedBy: REQ.requestedBy,
      at: "2026-06-11T00:05:00.000Z",
    });
    const uninstalling = requestUninstall(installed);
    expect(uninstalling.status).toBe("uninstalling");
    const uninstalled = completeUninstall(uninstalling, { uninstalledBy: REQ.requestedBy, at: "2026-06-12T00:00:00.000Z" });
    expect(uninstalled.status).toBe("uninstalled");
    expect(uninstalled.uninstalledBy).toBe(REQ.requestedBy);
  });

  it("fails an in-flight install with a reason", () => {
    const failed = failInstallation(beginInstall(newInstallationRequest(REQ)), "manifest resolve error");
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("manifest resolve error");
  });

  it("rejects an illegal transition (requested → installed directly)", () => {
    expect(() => transitionInstallation(newInstallationRequest(REQ), "installed")).toThrow(
      IllegalInstallationTransitionError,
    );
  });

  it("rejects completing an install without the required fields (schema guard)", () => {
    // installing → installed without installedVersion/At/By fails the schema refinement
    expect(() => transitionInstallation(beginInstall(newInstallationRequest(REQ)), "installed")).toThrow();
  });
});
