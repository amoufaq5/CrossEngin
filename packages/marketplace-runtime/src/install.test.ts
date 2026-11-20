import { generateEd25519Keypair } from "@crossengin/crypto";
import {
  INSTALLATION_STATUSES,
  canTransitionInstallation,
  PackManifestSchema,
  PackPublisherRegistry,
  parsePackPublisherSpec,
  signPackRelease,
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
  INSTALL_WITHDRAWN_REASON,
  requestFromGrants,
  UNINSTALL_PATH,
} from "./install.js";

const BUNDLE_SHA = "a".repeat(64);
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
  publishers: PackPublisherRegistry;
} {
  const pack = manifest(overrides);
  const kp = generateEd25519Keypair();
  const signature = signPackRelease({
    manifest: pack,
    version: "1.0.0",
    bundleSha256: BUNDLE_SHA,
    privateKeyBase64: kp.privateKeyBase64,
    publicKeyBase64: kp.publicKeyBase64,
    signedAt: NOW,
  });
  const publishers = new PackPublisherRegistry([
    parsePackPublisherSpec(`com.crossengin:${pack.author.kind}:${kp.publicKeyBase64}`),
  ]);
  return { pack, signature, publishers };
}

function request(overrides: Partial<InstallRequest> = {}): InstallRequest {
  const s = signed();
  return {
    tenantId: TENANT,
    requestedBy: "user-admin",
    pack: s.pack,
    version: "1.0.0",
    bundleSha256: BUNDLE_SHA,
    compatibility: compatibility(),
    signature: s.signature,
    publishers: s.publishers,
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
      request({ pack: s.pack, signature: s.signature, publishers: s.publishers }),
      ctx,
    );
    expect(decision.outcome).toBe("permission_pending");
    if (decision.outcome !== "permission_pending") return;
    expect(decision.installation.status).toBe("permission_pending");
    expect(decision.resolution.missingRequired).toEqual(["records:read"]);
    expect(decision.installation.permissionGrants.every((g) => g.status === "pending")).toBe(true);
  });

  it("rejects a pack whose signer the platform has not registered, however valid the signature", () => {
    const other = generateEd25519Keypair();
    const unregistered = new PackPublisherRegistry([
      parsePackPublisherSpec(`com.crossengin:crossengin_official:${other.publicKeyBase64}`),
    ]);
    const decision = admitInstallation(request({ publishers: unregistered }), ctx);
    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.reason).toBe("publisher_unregistered");
  });

  it("rejects a manifest altered after its registered publisher signed it", () => {
    const s = signed();
    const decision = admitInstallation(
      request({ pack: { ...s.pack, name: "Altered" }, signature: s.signature, publishers: s.publishers }),
      ctx,
    );
    expect(decision.outcome).toBe("rejected");
    if (decision.outcome !== "rejected") return;
    expect(decision.reason).toBe("release_manifest_mismatch");
  });

  it("rejects a catalog entry naming a version the publisher did not sign", () => {
    const s = signed();
    const decision = admitInstallation(
      request({ pack: s.pack, signature: s.signature, publishers: s.publishers, version: "1.0.1" }),
      ctx,
    );
    expect(decision).toMatchObject({ outcome: "rejected", reason: "release_version_mismatch" });
  });

  it("rejects a catalog entry naming a bundle the publisher did not sign", () => {
    const s = signed();
    const decision = admitInstallation(
      request({ pack: s.pack, signature: s.signature, publishers: s.publishers, bundleSha256: "b".repeat(64) }),
      ctx,
    );
    expect(decision).toMatchObject({ outcome: "rejected", reason: "release_bundle_mismatch" });
  });

  it("re-verifies its own input at every admission: the two-column rewrite is refused, not installed", () => {
    // ADR-0459: the shape ADR-0454 measured on a stored row — the version *and* the signed claim both
    // rewritten to 9.9.9 — applied to the install's input. Admission asks the registry, so the
    // rewritten claim fails the Ed25519 check rather than agreeing with itself.
    const s = signed();
    const rewritten = { ...s.signature, release: { ...s.signature.release!, version: "9.9.9" } };
    const decision = admitInstallation(
      request({ pack: s.pack, signature: rewritten, publishers: s.publishers, version: "9.9.9" }),
      ctx,
    );
    expect(decision).toMatchObject({ outcome: "rejected", reason: "signature_invalid" });
  });

  it("rejects a manifest-only signature by name", () => {
    const s = signed();
    const { release: _release, ...legacy } = s.signature;
    const decision = admitInstallation(request({ pack: s.pack, signature: legacy, publishers: s.publishers }), ctx);
    expect(decision).toMatchObject({ outcome: "rejected", reason: "legacy_signature_form" });
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
        publishers: s.publishers,
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
        publishers: s.publishers,
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
      request({ pack: s.pack, signature: s.signature, publishers: s.publishers }),
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
      request({ pack: s.pack, signature: s.signature, publishers: s.publishers }),
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


describe("UNINSTALL_PATH", () => {
  const STEPS = {
    begin_then_complete: ["uninstalling", "uninstalled"],
    fail_then_complete: ["failed", "uninstalled"],
    complete: ["uninstalled"],
  } as const;

  it("names only paths the installation transition map permits", () => {
    for (const status of INSTALLATION_STATUSES) {
      const path = UNINSTALL_PATH[status];
      if (path === null) continue;
      let at = status;
      for (const next of STEPS[path]) {
        expect(canTransitionInstallation(at, next), `${status}: ${at} → ${next}`).toBe(true);
        at = next;
      }
    }
  });

  it("can withdraw every status an admission leaves an install in, since nothing completes one", () => {
    const admitted = admitInstallation(request(), ctx);
    const s = signed({ requiredScopes: ["records:read"] });
    const pending = admitInstallation(request({ pack: s.pack, signature: s.signature, publishers: s.publishers }), ctx);
    if (admitted.outcome !== "admitted") throw new Error("expected admitted");
    if (pending.outcome !== "permission_pending") throw new Error("expected permission_pending");
    for (const d of [admitted, pending]) {
      expect(UNINSTALL_PATH[d.installation.status], d.installation.status).not.toBeNull();
    }
    const withdrawn = failInstallation(admitted.installation, INSTALL_WITHDRAWN_REASON);
    expect(completeUninstall(withdrawn, { uninstalledBy: "u", at: NOW }).status).toBe("uninstalled");
  });
});
