import { generateEd25519Keypair } from "@crossengin/crypto";
import {
  PackManifestSchema,
  signPackManifest,
  type PackCompatibility,
  type PackManifest,
  type TenantContext,
} from "@crossengin/marketplace";
import { FixedClock } from "@crossengin/marketplace-runtime";
import { describe, expect, it } from "vitest";

import { fakePg } from "./test-fakes.js";
import { PostgresInstallationStore } from "./installation-store.js";
import { UnreadableInstallationRowsError, type InstallationRow } from "./records.js";
import { PersistentMarketplaceInstallEngine, type PersistentInstallRequest } from "./persistent-engine.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";

function persistentRequest(overrides: Partial<PackManifest> = {}): PersistentInstallRequest {
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
    requestedBy: USER,
    pack,
    version: "1.0.0",
    compatibility,
    signature,
    publisherPublicKeyBase64: kp.publicKeyBase64,
    securityReviewStatus: "passed",
    tenantContext,
  };
}

function makeEngine(): {
  engine: PersistentMarketplaceInstallEngine;
  store: PostgresInstallationStore;
  rows: Map<string, InstallationRow>;
} {
  const { conn, rows } = fakePg();
  const store = new PostgresInstallationStore(conn);
  const eng = new PersistentMarketplaceInstallEngine(store, { clock: new FixedClock("2026-05-16T12:00:00.000Z") });
  return { engine: eng, store, rows };
}

describe("PersistentMarketplaceInstallEngine", () => {
  it("persists an admitted installation the store then reflects", async () => {
    const { engine, store } = makeEngine();
    const decision = await engine.install(persistentRequest());
    expect(decision.outcome).toBe("admitted");
    if (decision.outcome !== "admitted") return;
    const got = await store.get(TENANT, decision.installation.id);
    expect(got?.status).toBe("installing");
    expect(got?.id).toMatch(/^[0-9a-f-]{36}$/); // bare UUID, valid for the UUID PK
  });

  it("rejects a second install of the same pack using persisted state", async () => {
    const { engine, store } = makeEngine();
    const first = await engine.install(persistentRequest());
    if (first.outcome !== "admitted") throw new Error("expected admitted");
    await engine.complete(first.installation, "1.0.0", USER);
    // Second install loads `existing` from the store → already-installed.
    const second = await engine.install(persistentRequest());
    expect(second.outcome).toBe("rejected");
    if (second.outcome !== "rejected") return;
    expect(second.reason).toBe("already_installed");
    expect((await store.listForTenant(TENANT)).records).toHaveLength(1);
  });

  it("persists the full grant → install → uninstall lifecycle", async () => {
    const { engine, store } = makeEngine();
    const decision = await engine.install(persistentRequest({ requiredScopes: ["records:read"] }));
    expect(decision.outcome).toBe("permission_pending");
    if (decision.outcome !== "permission_pending") return;

    const granted = await engine.grant(decision.installation, ["records:read"], USER);
    expect(granted.installation.status).toBe("installing");
    expect((await store.get(TENANT, decision.installation.id))?.status).toBe("installing");

    const installed = await engine.complete(granted.installation, "1.0.0", USER);
    expect((await store.get(TENANT, installed.id))?.status).toBe("installed");

    const gone = await engine.completeUninstall(await engine.beginUninstall(installed), USER);
    expect((await store.get(TENANT, gone.id))?.status).toBe("uninstalled");
  });

  it("refuses the admission when the tenant's existing set holds a row the contract refuses", async () => {
    // The sharpest hazard the migration could have created. `engine.admit`'s first gate reads
    // `existing` for an active installation of this pack, so a dropped row does not shorten a list,
    // it admits a **second** installation of a pack the tenant already has. `.map(rowToInstallation)`
    // threw here before, and the refusal preserves that rather than relaxing it into a wrong answer.
    const { engine, rows } = makeEngine();
    const first = await engine.install(persistentRequest());
    if (first.outcome !== "admitted") throw new Error("expected admitted");
    await engine.complete(first.installation, "1.0.0", USER);
    const stored = rows.get(first.installation.id);
    if (stored === undefined) throw new Error("expected the row to be persisted");
    // `InstallationRow.status` is a bare `string`, so this is a drift the column's own CHECK admits
    // and the contract refuses — ADR-0289's shape, with no cast needed to express it.
    rows.set(stored.id, { ...stored, status: "not_a_status" });

    await expect(engine.install(persistentRequest())).rejects.toThrow(
      UnreadableInstallationRowsError,
    );
    await expect(engine.install(persistentRequest())).rejects.toThrow(
      /1 installation row\(s\) could not be represented/,
    );
    // The refusal names the row's id and its cause, and never the value that caused it.
    await expect(engine.install(persistentRequest())).rejects.toThrow(
      /status: invalid_enum_value/,
    );
    await expect(engine.install(persistentRequest())).rejects.not.toThrow(/not_a_status/);
  });

  it("writes nothing when admission is rejected", async () => {
    const { engine, store } = makeEngine();
    const other = generateEd25519Keypair();
    const decision = await engine.install({ ...persistentRequest(), publisherPublicKeyBase64: other.publicKeyBase64 });
    expect(decision.outcome).toBe("rejected");
    expect((await store.listForTenant(TENANT)).records).toEqual([]);
  });
});
