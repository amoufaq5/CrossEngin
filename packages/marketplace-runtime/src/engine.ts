import { shouldAutoUpdate, type PackInstallation, type PermissionResolution } from "@crossengin/marketplace";
import type { ScopeKey } from "@crossengin/sdk";

import { RandomIdGenerator, SystemClock, type Clock, type IdGenerator } from "./clock.js";
import type { InstallDecision, InstallRequest } from "./decisions.js";
import {
  admitInstallation,
  applyPermissionGrants,
  beginUninstall,
  beginUpdate,
  completeInstallation,
  completeUninstall,
  completeUpdate,
  failInstallation,
} from "./install.js";

export interface MarketplaceInstallEngineOptions {
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}

/**
 * A thin stateful wrapper over the pure install transitions: it injects the
 * clock's timestamps and the id generator's installation ids so callers drive
 * the whole lifecycle without threading `now`/`id` by hand. Holds no
 * installation state itself — the caller owns the `PackInstallationSet` (so it
 * can be a Postgres table, an in-memory array, whatever).
 */
export class MarketplaceInstallEngine {
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;

  constructor(options: MarketplaceInstallEngineOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new RandomIdGenerator();
  }

  /** Runs the admission pipeline, minting a fresh installation id + timestamp. */
  admit(request: InstallRequest): InstallDecision {
    return admitInstallation(request, { now: this.clock.now(), installationId: this.idGenerator.next() });
  }

  /** Grants scopes on a permission-pending installation (advancing to installing when satisfied). */
  grant(
    installation: PackInstallation,
    scopes: readonly ScopeKey[],
    grantedBy: string,
  ): { readonly installation: PackInstallation; readonly resolution: PermissionResolution } {
    return applyPermissionGrants(installation, { scopes, grantedBy, at: this.clock.now() });
  }

  /** Completes an install: installing → installed. */
  complete(installation: PackInstallation, version: string, installedBy: string): PackInstallation {
    return completeInstallation(installation, { version, installedBy, at: this.clock.now() });
  }

  /** Marks an in-flight install failed. */
  fail(installation: PackInstallation, reason: string): PackInstallation {
    return failInstallation(installation, reason);
  }

  /** Begins an uninstall: installed → uninstalling. */
  beginUninstall(installation: PackInstallation): PackInstallation {
    return beginUninstall(installation);
  }

  /** Completes an uninstall: uninstalling → uninstalled. */
  completeUninstall(installation: PackInstallation, uninstalledBy: string): PackInstallation {
    return completeUninstall(installation, { uninstalledBy, at: this.clock.now() });
  }

  /** Whether the installation's update policy would auto-apply `newVersion`. */
  planUpdate(installation: PackInstallation, newVersion: string): boolean {
    return shouldAutoUpdate(installation, newVersion);
  }

  /** Begins an update: installed → updating. */
  beginUpdate(installation: PackInstallation): PackInstallation {
    return beginUpdate(installation);
  }

  /** Completes an update: updating → installed, pinning the new version. */
  completeUpdate(installation: PackInstallation, version: string): PackInstallation {
    return completeUpdate(installation, { version, at: this.clock.now() });
  }
}
