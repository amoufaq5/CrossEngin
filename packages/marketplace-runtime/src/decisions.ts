import type {
  PackCompatibility,
  PackInstallation,
  PackInstallationSet,
  PackManifest,
  PackSignature,
  PermissionResolution,
  SecurityReviewStatus,
  TenantContext,
} from "@crossengin/marketplace";

/**
 * Why an install request was refused at admission. Ordered by the pipeline that
 * emits them: an already-installed pack short-circuits before signature, a bad
 * signature before compatibility, and so on — the first failing gate wins.
 */
export const INSTALL_REJECTION_REASONS = [
  "already_installed",
  "signature_invalid",
  "incompatible",
  "review_required",
] as const;
export type InstallRejectionReason = (typeof INSTALL_REJECTION_REASONS)[number];

/** Everything the admission pipeline needs to decide an install request. */
export interface InstallRequest {
  readonly tenantId: string;
  readonly requestedBy: string;
  /** The pack manifest being installed (carries required/optional scopes + review triggers). */
  readonly pack: PackManifest;
  /** The specific version being installed. */
  readonly version: string;
  /** The version's platform/region/plan/compliance compatibility envelope. */
  readonly compatibility: PackCompatibility;
  /** The publisher's detached signature over the manifest. */
  readonly signature: PackSignature;
  /** The publisher's Ed25519 public key (base64) the signature is verified against. */
  readonly publisherPublicKeyBase64: string;
  /** The version's security-review status (from its PackVersionRecord). */
  readonly securityReviewStatus: SecurityReviewStatus;
  /** The installing tenant's platform/region/plan/compliance context. */
  readonly tenantContext: TenantContext;
  /** The tenant's existing installations, for the already-installed guard. */
  readonly existing: PackInstallationSet;
}

/**
 * The outcome of `admitInstallation`:
 * - `admitted` — no required scopes pending, installation is in `installing`.
 * - `permission_pending` — required scopes await a grant; installation is in
 *   `permission_pending` with its `permissionGrants` seeded pending.
 * - `rejected` — a gate failed; `reason` + human-readable `reasons`.
 */
export type InstallDecision =
  | {
      readonly outcome: "admitted";
      readonly installation: PackInstallation;
      readonly resolution: PermissionResolution;
    }
  | {
      readonly outcome: "permission_pending";
      readonly installation: PackInstallation;
      readonly resolution: PermissionResolution;
    }
  | {
      readonly outcome: "rejected";
      readonly reason: InstallRejectionReason;
      readonly reasons: readonly string[];
    };

/** Security-review states that clear the elevated-review gate. */
export const REVIEW_CLEARED_STATUSES: readonly SecurityReviewStatus[] = ["passed", "exempt"];
