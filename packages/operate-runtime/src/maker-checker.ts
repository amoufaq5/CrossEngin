import type { Manifest } from "@crossengin/kernel/manifest";

import { CREATED_BY_FIELD } from "./write-surface.js";

/**
 * The transitions that commit the business to something another person should have checked: an
 * approval, a posting to the ledger, a payment. Named, because the manifest carries no field that
 * says a transition is an approval — a name set is the only reading available, and it is the reason
 * a tenant's own manifest is covered without a declaration it would have to know to write.
 *
 * Measured over the seven resolved packs: `approve` (Bill, Expense, LeaveRequest, PurchaseOrder,
 * Timesheet, and government's Case), `post` (JournalEntry), `mark_paid` (Invoice, Bill, TaxReturn)
 * and `reimburse` (Expense). `Payment.complete` is the one qualified entry: a payment is the act the
 * rule exists for most, and the bare name `complete` is shared with five transitions that commit
 * nothing (Encounter, Enrollment, MaintenanceOrder, Project, WorkOrder) — so it is named with its
 * entity rather than by its name. ProjectTask's `complete` is a sixth.
 *
 * Not every ledger posting is gated, and that is a choice rather than a measurement: `Invoice.send`
 * posts revenue (the recognition effect fires on `sent`), `JournalEntry.reverse` posts a reversal
 * entry and `Payment.refund` returns money (posting nothing), and none is in the set — issuing an invoice is ordinarily
 * one person's act. A tenant transition named anything else is not gated either.
 */
export const APPROVE_CLASS_TRANSITION_NAMES: ReadonlySet<string> = new Set([
  "approve",
  "post",
  "mark_paid",
  "reimburse",
]);
export const APPROVE_CLASS_QUALIFIED_TRANSITIONS: ReadonlySet<string> = new Set(["Payment.complete"]);

export function isApproveClassTransition(entity: string, transition: string): boolean {
  return (
    APPROVE_CLASS_TRANSITION_NAMES.has(transition) ||
    APPROVE_CLASS_QUALIFIED_TRANSITIONS.has(`${entity}.${transition}`)
  );
}

/** Every approve-class transition the manifest declares, as `Entity.transition`, sorted. */
export function approveClassTransitions(manifest: Manifest): readonly string[] {
  const out = new Set<string>();
  for (const wf of Object.values(manifest.workflows ?? {})) {
    if (wf.kind !== "entityLifecycle") continue;
    for (const t of wf.transitions) {
      if (isApproveClassTransition(wf.entity, t.name)) out.add(`${wf.entity}.${t.name}`);
    }
  }
  return [...out].sort();
}

export const MAKER_CHECKER_ERRORS = {
  same_person: "maker_cannot_approve",
  unverifiable: "maker_checker_unverifiable",
} as const;

export type MakerCheckerRefusal =
  | { readonly error: typeof MAKER_CHECKER_ERRORS.same_person; readonly detail: string }
  | { readonly error: typeof MAKER_CHECKER_ERRORS.unverifiable; readonly detail: string };

/**
 * Whether `actorId` may fire an approve-class transition on `record`: refused when the actor is the
 * person recorded as having created it, and refused when either side has no recorded identity.
 *
 * The second refusal is the decision rather than a gap. The rule is "a different person checked
 * this", and with no maker on the record — one created before `created_by` was stamped, or by a
 * credential that names no person — or no person behind the request, nothing shows that. Admitting
 * those would make the control true exactly where it cannot be evaluated (ADR-0337's direction),
 * and the switch is opt-in for that reason: a deployment turning it on is asking for this answer.
 *
 * `creatorIsServerStamped` is whether the entity carries the `auditable` trait, so that the server
 * wrote `created_by` and a client could not. An entity declaring its own `created_by` field is
 * client-writable there, so a maker could name somebody else as creator and approve their own
 * record; its value is therefore no evidence, and the record reads as having no recorded creator.
 */
export function makerCheckerRefusal(
  entity: string,
  transition: string,
  record: Readonly<Record<string, unknown>>,
  actorId: string | null,
  creatorIsServerStamped: boolean,
): MakerCheckerRefusal | null {
  const maker = creatorIsServerStamped ? record[CREATED_BY_FIELD] : undefined;
  const makerId = typeof maker === "string" && maker.length > 0 ? maker : null;
  if (makerId === null) {
    return {
      error: MAKER_CHECKER_ERRORS.unverifiable,
      detail:
        `'${transition}' on ${entity} requires a different person from the one who created the record,` +
        ` and this record has no recorded creator — it predates creator stamping, was created by a` +
        ` credential that names no person, or its entity does not carry the auditable trait`,
    };
  }
  if (actorId === null) {
    return {
      error: MAKER_CHECKER_ERRORS.unverifiable,
      detail:
        `'${transition}' on ${entity} requires a different person from the one who created the record,` +
        ` and this request's credential names no person`,
    };
  }
  if (makerId.toLowerCase() === actorId.toLowerCase()) {
    return {
      error: MAKER_CHECKER_ERRORS.same_person,
      detail: `'${transition}' on ${entity} must be fired by someone other than the record's creator`,
    };
  }
  return null;
}

/**
 * The boot line, said either way. On, it names every transition the rule now gates and the one
 * consequence an operator meets first: a record created before actor stamping carries no creator,
 * so its approval is refused until somebody re-creates it. Off, it names the flag and what it would
 * gate, because a control that is absent should be as legible as one that is present.
 */
export function formatSegregationOfDuties(manifest: Manifest, enabled: boolean): string {
  const gated = approveClassTransitions(manifest);
  const list = gated.length === 0 ? "none declared" : gated.join(", ");
  if (!enabled) {
    return (
      `[sod] segregation of duties: off — the creator of a record may also approve, post or pay it` +
      ` (${gated.length} approve-class transition(s): ${list}); --segregation-of-duties turns it on`
    );
  }
  return (
    `[sod] segregation of duties: on — ${gated.length} approve-class transition(s) refuse the` +
    ` record's own creator (${MAKER_CHECKER_ERRORS.same_person}): ${list}. A record with no recorded` +
    ` creator, or a request whose credential names no person, is refused` +
    ` (${MAKER_CHECKER_ERRORS.unverifiable})`
  );
}
