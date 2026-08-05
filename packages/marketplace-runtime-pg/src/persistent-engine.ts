import type { PackInstallation, PermissionResolution } from "@crossengin/marketplace";
import {
  MarketplaceInstallEngine,
  type Clock,
  type IdGenerator,
  type InstallDecision,
  type InstallRequest,
} from "@crossengin/marketplace-runtime";

import type { PostgresInstallationStore } from "./installation-store.js";

/**
 * Installation ids as bare UUIDs — `meta.pack_installations.id` is a `UUID`
 * column, so the pg-backed engine mints UUIDs rather than the in-memory
 * `inst_…` prefix form.
 */
export class UuidInstallationIdGenerator implements IdGenerator {
  next(): string {
    return globalThis.crypto.randomUUID();
  }
}

/** An install request whose `existing` set is loaded from the store, not supplied. */
export type PersistentInstallRequest = Omit<InstallRequest, "existing">;

export interface PersistentMarketplaceInstallEngineOptions {
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}

/**
 * Wraps a `MarketplaceInstallEngine` so every admitted decision and every
 * lifecycle transition is persisted to `meta.pack_installations`. `install`
 * loads the tenant's current installations from the store as the engine's
 * `existing` set (so the already-installed guard sees real state), admits, and
 * upserts the result; a rejected decision writes nothing. The other methods
 * apply an in-memory transition then upsert, so the DB always mirrors the latest
 * record.
 */
export class PersistentMarketplaceInstallEngine {
  private readonly engine: MarketplaceInstallEngine;

  constructor(
    private readonly store: PostgresInstallationStore,
    options: PersistentMarketplaceInstallEngineOptions = {},
  ) {
    this.engine = new MarketplaceInstallEngine({
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      idGenerator: options.idGenerator ?? new UuidInstallationIdGenerator(),
    });
  }

  /** Admits a request against the tenant's persisted installs, persisting the outcome (if not rejected). */
  async install(request: PersistentInstallRequest): Promise<InstallDecision> {
    const existing = await this.store.listForTenant(request.tenantId);
    const decision = this.engine.admit({ ...request, existing });
    if (decision.outcome !== "rejected") {
      await this.store.upsert(decision.installation);
    }
    return decision;
  }

  /** Grants scopes, persisting the (possibly advanced) installation. */
  async grant(
    installation: PackInstallation,
    scopes: readonly string[],
    grantedBy: string,
  ): Promise<{ readonly installation: PackInstallation; readonly resolution: PermissionResolution }> {
    const result = this.engine.grant(installation, scopes, grantedBy);
    await this.store.upsert(result.installation);
    return result;
  }

  /** Completes an install and persists it. */
  async complete(installation: PackInstallation, version: string, installedBy: string): Promise<PackInstallation> {
    return this.persist(this.engine.complete(installation, version, installedBy));
  }

  /** Marks an install failed and persists it. */
  async fail(installation: PackInstallation, reason: string): Promise<PackInstallation> {
    return this.persist(this.engine.fail(installation, reason));
  }

  /** Begins an uninstall and persists it. */
  async beginUninstall(installation: PackInstallation): Promise<PackInstallation> {
    return this.persist(this.engine.beginUninstall(installation));
  }

  /** Completes an uninstall and persists it. */
  async completeUninstall(installation: PackInstallation, uninstalledBy: string): Promise<PackInstallation> {
    return this.persist(this.engine.completeUninstall(installation, uninstalledBy));
  }

  /** Begins an update and persists it. */
  async beginUpdate(installation: PackInstallation): Promise<PackInstallation> {
    return this.persist(this.engine.beginUpdate(installation));
  }

  /** Completes an update and persists it. */
  async completeUpdate(installation: PackInstallation, version: string): Promise<PackInstallation> {
    return this.persist(this.engine.completeUpdate(installation, version));
  }

  /** Whether the installation's update policy would auto-apply `newVersion` (no persistence). */
  planUpdate(installation: PackInstallation, newVersion: string): boolean {
    return this.engine.planUpdate(installation, newVersion);
  }

  private async persist(installation: PackInstallation): Promise<PackInstallation> {
    await this.store.upsert(installation);
    return installation;
  }
}
