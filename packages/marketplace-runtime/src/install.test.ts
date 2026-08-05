import { generateEd25519Keypair } from "@crossengin/crypto";
import {
  PackManifestSchema,
  signPackManifest,
  type PackCompatibility,
  type PackInstallation,
  type PackManifest,
  type PackSignature,
  type TenantContext,
} from "@crossengin/marketplace";
import { describe, expect, it } from "vitest";

import type { InstallRequest } from "./decisions.js";
import {
  admitInstallation,
  applyPermissionGrants,
  beginUninstall,
  beginUpdate,
  completeInstallation,
  completeUninstall,
  completeUpdate,
  failInstallation,
  requestFromGrants,
} from "./install.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-05-16T12:00:00.000Z";

function manifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return PackManifestSchema.parse({
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
}

function compatibility(overrides: Partial<PackCompatibility> = {}): PackCompatibility {
  return { minPlatformVersion: "1.0.0", allowedRegions: [], blockedRegions: [], requiredCompliancePacks: [], requiresDedicatedTenant: false, ...overrides };
}

function tenantContext(overrides: Partial<TenantContext> = {}): TenantContext {
  return { platformVersion: "1.2.0", region: "us-east", planTier: "professional", compliancePacks: [], isDedicatedTenant: false, ...overrides };
}

/** Builds a signed pack + the publisher key the signature verifies against. */
function signed(overrides: Partial<PackManifest> = {}): {
  pack: PackManifest;
  signature: PackSignature;
  publicKeyBase64: string;
} {
  const pack = manifest(overrides);
  const kp = generateEd25519Keypair();
  const signature = signPackManifest({
    manifest: pack,
    privateKeyBase64: kp.privateKeyBase64,
    publicKeyBase64: kp.publicKeyBase64,
    signedAt: NOW,
  });
  return { pack, signature, publicKeyBase64: kp.publicKeyBase64 };
}

function request(overrides: Partial<InstallRequest> = {}): InstallRequest {
  const s = signed();
  return {
    tenantId: TENANT,
    requestedBy: "user-admin",
    pack: s.pack,
    version: "1.0.0",
    compatibility: compatibility(),
    signature: s.signature,
    publisherPublicKeyBase64: s.publicKeyBase64,
    securityReviewStatus: "passed",
    tenantContext: tenantContext(),
    existing: [],
    ...overrides,
  };
}

const ctx = { now: NOW, installationId: "inst_00000001" };

describe("admitInstallation — gates", () => {
  it("admits a signed, compatible, scope-free pack straight to installing", () => {
    const decision = admitInstallation(request(), ctx);
    expect(decision.outcome).toBe("admitted");
    if (decision.outcome !== "admitted") return;
    expect(decision.installation.status).toBe("installing");
    expect(decision.installation.id).toBe("inst_00000001");
    expect(decision.installation.packId).toBe("com.crossengin.example");
    expect(decision.resolution.satisfied).toBe(true);
  });

  it("routes a pack with required scopes to permission_pending", () => {
    const s = signed({ requiredScopes: ["records:read"] });
    const decision = admitInstallation(
      request({ pack: s.pack, signature: s.signature, publisherPublicKeyBase64: s.publicKeyBase64 }),
      ctx,
    );
    expect(decision.outcome).toBe("permission_pending");
    if (decision.outcome !== "permission_pending") return;
    expect(decision.installation.status).toBe("permission_pending");
    expect(decision.resolution.missingRequired).toEqual(["records:read"]);
    expect(decision.installation.permissionGrants.every((g) => g.status === "pending")).toBe(true);
  });

  it("rejects a bad signature", () => {
    const other = generateEd25519Keypair();
    const decision = admitInstallation(request({ publisherPublicKeyBase64: other.publicKeyBase64 }), ctx);
    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.reason).toBe("signature_invalid");
  });

  it("rejects an incompatible tenant (platform too old) with reasons", () => {
    const decision = admitInstallation(
      request({ compatibility: compatibility({ minPlatformVersion: "2.0.0" }) }),
      ctx,
    );
    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.reason).toBe("incompatible");
    expect(decision.reasons[0]).toMatch(/below minPlatformVersion/);
  });

  it("rejects a pack needing elevated review that hasn't cleared it", () => {
    const s = signed({ requiresPhiAccess: true, handlesUserData: true });
    const decision = admitInstallation(
      request({
        pack: s.pack,
        signature: s.signature,
        publisherPublicKeyBase64: s.publicKeyBase64,
        securityReviewStatus: "pending",
      }),
      ctx,
    );
    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.reason).toBe("review_required");
  });

  it("admits a review-needing pack once review passed", () => {
    const s = signed({ requiresPhiAccess: true, handlesUserData: true });
    const decision = admitInstallation(
      request({
        pack: s.pack,
        signature: s.signature,
        publisherPublicKeyBase64: s.publicKeyBase64,
        securityReviewStatus: "passed",
      }),
      ctx,
    );
    expect(decision.outcome).toBe("admitted");
  });

  it("rejects a second active installation of the same pack", () => {
    const first = admitInstallation(request(), ctx);
    if (first.outcome !== "admitted") throw new Error("expected admitted");
    const installed = completeInstallation(first.installation, { version: "1.0.0", installedBy: "u", at: NOW });
    const decision = admitInstallation(request({ existing: [installed] }), {
      now: NOW,
      installationId: "inst_00000002",
    });
    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.reason).toBe("already_installed");
  });

  it("allows reinstalling after a prior uninstall", () => {
    const first = admitInstallation(request(), ctx);
    if (first.outcome !== "admitted") throw new Error("expected admitted");
    const installed = completeInstallation(first.installation, { version: "1.0.0", installedBy: "u", at: NOW });
    const gone = completeUninstall(beginUninstall(installed), { uninstalledBy: "u", at: NOW });
    const decision = admitInstallation(request({ existing: [gone] }), { now: NOW, installationId: "inst_00000002" });
    expect(decision.outcome).toBe("admitted");
  });
});

describe("permission grants", () => {
  it("advances to installing once every required scope is granted", () => {
    const s = signed({ requiredScopes: ["records:read", "records:write"] });
    const decision = admitInstallation(
      request({ pack: s.pack, signature: s.signature, publisherPublicKeyBase64: s.publicKeyBase64 }),
      ctx,
    );
    if (decision.outcome !== "permission_pending") throw new Error("expected permission_pending");

    const partial = applyPermissionGrants(decision.installation, {
      scopes: ["records:read"],
      grantedBy: "admin",
      at: NOW,
    });
    expect(partial.installation.status).toBe("permission_pending");
    expect(partial.resolution.satisfied).toBe(false);

    const full = applyPermissionGrants(partial.installation, {
      scopes: ["records:write"],
      grantedBy: "admin",
      at: NOW,
    });
    expect(full.installation.status).toBe("installing");
    expect(full.resolution.satisfied).toBe(true);
    expect(full.installation.permissionGrants.every((g) => g.status === "granted")).toBe(true);
  });

  it("reconstructs the request from grants (required vs optional)", () => {
    const s = signed({ requiredScopes: ["records:read"], optionalScopes: ["files:read"] });
    const decision = admitInstallation(
      request({ pack: s.pack, signature: s.signature, publisherPublicKeyBase64: s.publicKeyBase64 }),
      ctx,
    );
    if (decision.outcome !== "permission_pending") throw new Error("expected permission_pending");
    const req = requestFromGrants(decision.installation.permissionGrants);
    expect(req.requiredScopes).toEqual(["records:read"]);
    expect(req.optionalScopes).toEqual(["files:read"]);
  });
});

describe("lifecycle transitions", () => {
  function installing(): PackInstallation {
    const d = admitInstallation(request(), ctx);
    if (d.outcome !== "admitted") throw new Error("expected admitted");
    return d.installation;
  }

  it("installing → installed records version/who/when", () => {
    const done = completeInstallation(installing(), { version: "1.0.0", installedBy: "u", at: NOW });
    expect(done.status).toBe("installed");
    expect(done.installedVersion).toBe("1.0.0");
    expect(done.installedAt).toBe(NOW);
    expect(done.installedBy).toBe("u");
  });

  it("failInstallation records a reason", () => {
    const failed = failInstallation(installing(), "bundle download failed");
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("bundle download failed");
  });

  it("installed → uninstalling → uninstalled", () => {
    const done = completeInstallation(installing(), { version: "1.0.0", installedBy: "u", at: NOW });
    const gone = completeUninstall(beginUninstall(done), { uninstalledBy: "u", at: NOW });
    expect(gone.status).toBe("uninstalled");
    expect(gone.uninstalledBy).toBe("u");
  });

  it("installed → updating → installed pins the new version", () => {
    const done = completeInstallation(installing(), { version: "1.0.0", installedBy: "u", at: NOW });
    const updated = completeUpdate(beginUpdate(done), { version: "1.1.0", at: NOW });
    expect(updated.status).toBe("installed");
    expect(updated.installedVersion).toBe("1.1.0");
  });

  it("throws on an illegal transition", () => {
    expect(() => completeInstallation(installing(), { version: "1.0.0", installedBy: "u", at: NOW })).not.toThrow();
    const done = completeInstallation(installing(), { version: "1.0.0", installedBy: "u", at: NOW });
    // installed → installed is not a legal transition
    expect(() => beginUpdate(beginUpdate(done))).toThrow(/illegal installation transition/);
  });
});
