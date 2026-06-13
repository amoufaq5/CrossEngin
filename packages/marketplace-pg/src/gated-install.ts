import type { PackInstallation, UpdatePolicy } from "@crossengin/marketplace";

import { beginInstall, completeInstall, newInstallationRequest } from "./engine.js";
import type { PostgresPackInstallationStore } from "./installation-store.js";

/**
 * A minimal safety-gate verdict — satisfied structurally by
 * `@crossengin/ai-architect-runtime`'s `ProposalGateDecision`, so this package stays
 * decoupled from the AI Architect runtime.
 */
export interface InstallGateVerdict {
  readonly decision: "allow" | "confirm" | "refuse";
}

/** The minimal store surface the gated install needs. */
type InstallStore = Pick<PostgresPackInstallationStore, "record" | "activeForPack">;

export interface GatedInstallInput {
  /** The safety-gate verdict for the proposal that produced this pack upgrade. */
  readonly verdict: InstallGateVerdict;
  readonly tenantId: string;
  readonly packId: string;
  readonly version: string;
  readonly installedBy: string;
  /** For a `confirm` verdict, whether the human has confirmed (an `allow` ignores this). */
  readonly confirmed?: boolean;
  readonly updatePolicy?: UpdatePolicy;
  readonly now: () => Date;
  readonly newId: () => string;
}

export type GatedInstallResult =
  | { readonly installed: true; readonly installation: PackInstallation }
  | { readonly installed: false; readonly reason: "refused" | "confirmation_required" | "already_installed" };

/**
 * Installs a proposed pack upgrade into a tenant **only if the safety gate allows it** —
 * the install half of the P7 exit criterion ("publishes + installs the upgrade into a
 * sandbox tenant — refusing if the eval gate or cost ceiling trips"). A `refuse` verdict
 * never installs; a `confirm` verdict installs only when `confirmed`; an `allow` (or
 * confirmed) verdict drives the marketplace install engine (`newInstallationRequest →
 * beginInstall → completeInstall`) and persists via the RLS-scoped store. An existing
 * active install for the pack short-circuits as `already_installed` (no duplicate).
 */
export async function installPackGated(store: InstallStore, input: GatedInstallInput): Promise<GatedInstallResult> {
  if (input.verdict.decision === "refuse") return { installed: false, reason: "refused" };
  if (input.verdict.decision === "confirm" && input.confirmed !== true) {
    return { installed: false, reason: "confirmation_required" };
  }

  const existing = await store.activeForPack(input.tenantId, input.packId);
  if (existing !== null) return { installed: false, reason: "already_installed" };

  const now = input.now().toISOString();
  const requested = newInstallationRequest({
    id: input.newId(),
    tenantId: input.tenantId,
    packId: input.packId,
    requestedBy: input.installedBy,
    requestedAt: now,
    ...(input.updatePolicy !== undefined ? { updatePolicy: input.updatePolicy } : {}),
  });
  const installation = completeInstall(beginInstall(requested), {
    version: input.version,
    installedBy: input.installedBy,
    at: now,
  });
  await store.record(installation);
  return { installed: true, installation };
}
