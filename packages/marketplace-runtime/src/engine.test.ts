import { generateEd25519Keypair } from "@crossengin/crypto";
import {
  PackManifestSchema,
  signPackManifest,
  type PackCompatibility,
  type PackManifest,
  type TenantContext,
} from "@crossengin/marketplace";
import { describe, expect, it } from "vitest";

import { CountingIdGenerator, FixedClock } from "./clock.js";
import type { InstallRequest } from "./decisions.js";
import { MarketplaceInstallEngine } from "./engine.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function buildRequest(overrides: Partial<PackManifest> = {}): InstallRequest {
  const pack = PackManifestSchema.parse({
    id: "com.crossengin.example",
    name: "Example Pack",
    description: "A test pack",
    kind: "vertical_template",
    author: {
      kind: "crossengin_official",
      name: "CrossEngin Test",
      contactEmail: "test@example.com",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    },
    license: "MIT",
    minPlatformVersion: "1.0.0",
    ...overrides,
  });
  const kp = generateEd25519Keypair();
  const signature = signPackManifest({
    manifest: pack,
    privateKeyBase64: kp.privateKeyBase64,
    publicKeyBase64: kp.publicKeyBase64,
    signedAt: "2026-05-16T12:00:00.000Z",
  });
  const compatibility: PackCompatibility = {
    minPlatformVersion: "1.0.0",
    allowedRegions: [],
    blockedRegions: [],
    requiredCompliancePacks: [],
    requiresDedicatedTenant: false,
  };
  const tenantContext: TenantContext = {
    platformVersion: "1.2.0",
    region: "us-east",
    planTier: "professional",
    compliancePacks: [],
    isDedicatedTenant: false,
  };
  return {
    tenantId: TENANT,
    requestedBy: "user-admin",
    pack,
    version: "1.0.0",
    compatibility,
    signature,
    publisherPublicKeyBase64: kp.publicKeyBase64,
    securityReviewStatus: "passed",
    tenantContext,
    existing: [],
  };
}

function engine(): MarketplaceInstallEngine {
  return new MarketplaceInstallEngine({
    clock: new FixedClock("2026-05-16T12:00:00.000Z"),
    idGenerator: new CountingIdGenerator(),
  });
}

describe("MarketplaceInstallEngine — end to end", () => {
  it("drives a scope-free pack from admit to installed", () => {
    const eng = engine();
    const decision = eng.admit(buildRequest());
    expect(decision.outcome).toBe("admitted");
    if (decision.outcome !== "admitted") return;
    expect(decision.installation.id).toBe("inst_00000001");

    const installed = eng.complete(decision.installation, "1.0.0", "user-admin");
    expect(installed.status).toBe("installed");
    expect(installed.installedAt).toBe("2026-05-16T12:00:00.000Z");
    expect(installed.installedVersion).toBe("1.0.0");
  });

  it("drives a permissioned pack through grant → install → uninstall", () => {
    const eng = engine();
    const decision = eng.admit(buildRequest({ requiredScopes: ["records:read"] }));
    expect(decision.outcome).toBe("permission_pending");
    if (decision.outcome !== "permission_pending") return;

    const granted = eng.grant(decision.installation, ["records:read"], "admin");
    expect(granted.installation.status).toBe("installing");

    const installed = eng.complete(granted.installation, "1.0.0", "admin");
    expect(installed.status).toBe("installed");

    const gone = eng.completeUninstall(eng.beginUninstall(installed), "admin");
    expect(gone.status).toBe("uninstalled");
  });

  it("plans an auto-update only when the update policy allows it", () => {
    const eng = engine();
    const decision = eng.admit(buildRequest());
    if (decision.outcome !== "admitted") throw new Error("expected admitted");
    const installed = eng.complete(decision.installation, "1.0.0", "admin");
    // Default updatePolicy is 'manual' → never auto-updates.
    expect(eng.planUpdate(installed, "1.0.1")).toBe(false);
    // A track_latest installation auto-updates.
    const tracking = { ...installed, updatePolicy: "track_latest" as const };
    expect(eng.planUpdate(tracking, "2.0.0")).toBe(true);
    const updated = eng.completeUpdate(eng.beginUpdate(tracking), "2.0.0");
    expect(updated.installedVersion).toBe("2.0.0");
  });

  it("mints a real uuid installation id with the default generator", () => {
    const decision = new MarketplaceInstallEngine().admit(buildRequest());
    if (decision.outcome !== "admitted") throw new Error("expected admitted");
    expect(decision.installation.id).toMatch(/^inst_[0-9a-f-]{36}$/);
  });
});
