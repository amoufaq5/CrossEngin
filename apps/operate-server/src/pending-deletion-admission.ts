import type { AdmissionFinding } from "@crossengin/kernel-pg";

/**
 * What a database that refuses `meta.tenants.status = 'pending_deletion'` costs this deployment.
 *
 * ADR-0334 added that value because a tenant whose Article 17 deletion was verified and queued sat
 * `active` and went on accepting writes into data about to be destroyed. ADR-0330 then meant the
 * widened CHECK was not *planned* on a populated table, so on every already-applied deployment the
 * verify route's `UPDATE` was refused `23514`, `moveTenant` caught it, and the 202 carried
 * `tenantReadOnly: false`. ADR-0363 plans the widening; this says what to do about a database that
 * has not had it applied yet.
 *
 * The decision is a **pair** and not a boolean, because the cost depends on whether anything reads
 * the column on the request path:
 *
 * - `--tenant-status-gate` is the only reader there. With it on, a refused `pending_deletion` costs
 *   the one thing the state exists for: the gate goes on admitting writes for a tenant whose data is
 *   queued for destruction, and nothing in the request path says so.
 * - With it off, the value is enforced by nothing either way. What is lost is a status column an
 *   operator and the platform console read, a `console.error`, and an honest `tenantReadOnly: false`
 *   on the 202. The lifecycle trail records **nothing** rather than lying, because
 *   `recordLifecycle` answers `false` when no row moved — so there is no second record to disagree
 *   with the first.
 *
 * Refusing breaks nothing that worked in either case, since the read-only window has never held on
 * an un-upgraded deployment (ADR-0338's rule). What stops it being a refusal in both is the other
 * half of that rule: a refusal for a column nothing reads would refuse a deployment whose behaviour
 * is not changed by the fact being reported, and ADR-0334 is explicit that a remedy an operator
 * cannot act on for the surface in front of them is worse than none.
 */
export const PENDING_DELETION_ADMISSION_EFFECTS = ["refuse_boot", "warn", "silent"] as const;
export type PendingDeletionAdmissionEffect = (typeof PENDING_DELETION_ADMISSION_EFFECTS)[number];

/**
 * True for the effects that let the server come up. A map rather than `!== "refuse_boot"` so a
 * fourth effect is a compile error at the one place that decides, which is this file's own class of
 * defect avoided — `PHI_VERDICT_MAY_SERVE`'s shape.
 */
export const PENDING_DELETION_ADMISSION_MAY_SERVE: Readonly<
  Record<PendingDeletionAdmissionEffect, boolean>
> = {
  refuse_boot: false,
  warn: true,
  silent: true,
};

export interface PendingDeletionAdmissionInput {
  /** Whether `--deletion-request-routes` is mounted: the one surface that writes the value. */
  readonly deletionRequestRoutes: boolean;
  /** Whether `--tenant-status-gate` is on: the one surface that reads it on the request path. */
  readonly tenantStatusGate: boolean;
  /**
   * The value-granular findings, from `admissionBlocksValues`. Empty means the database admits the
   * value — or that no survey could be taken, which this deliberately treats the same way: a failed
   * read establishes nothing, and at boot the database may simply not be up (ADR-0334's
   * `missing`-versus-`unreachable` asymmetry).
   */
  readonly blocking: readonly AdmissionFinding[];
}

export function decidePendingDeletionAdmission(
  input: PendingDeletionAdmissionInput,
): PendingDeletionAdmissionEffect {
  if (!input.deletionRequestRoutes) return "silent";
  if (input.blocking.length === 0) return "silent";
  return input.tenantStatusGate ? "refuse_boot" : "warn";
}

/**
 * The sentence, built once for both effects so they cannot drift apart.
 *
 * The shared half names the write and its consequence; each effect adds only what differs, which is
 * what the operator's next action turns on. The remedy is appended by the caller from
 * `admissionRemedy`, so the `ALTER` an operator pastes has one producer.
 */
export function pendingDeletionAdmissionMessage(
  effect: PendingDeletionAdmissionEffect,
  finding: AdmissionFinding,
): string {
  const because =
    `${finding.detail} — the deletion-request verify route writes that value to make the tenant` +
    ` read-only between verification and the runner's commit, and this database refuses it, so the` +
    ` window stays open`;
  if (effect === "refuse_boot") return `${because}, and --tenant-status-gate reads it`;
  return (
    `${because}; --tenant-status-gate is off, so nothing enforces the state either way and this` +
    ` costs a stale status column rather than a write`
  );
}
