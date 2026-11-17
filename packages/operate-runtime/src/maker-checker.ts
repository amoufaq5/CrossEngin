import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";

import { drainList } from "./list-drain.js";
import type { EntityRecord, EntityStore } from "./store.js";
import { CREATED_BY_FIELD, UPDATED_BY_FIELD } from "./write-surface.js";

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

/** A record whose rows are part of what its parent's approval approves: a bill's lines, an entry's. */
export interface ApprovalContentChild {
  readonly entity: string;
  readonly parentField: string;
}

/**
 * What else an approver must not have written, beyond the record's creation.
 *
 * `editorAttributable` maps `Entity.transition` to the from-states **no transition enters**. In
 * such a state `updated_by` can only have been set by the record's creation or a field edit, so it
 * names the last person to change what is being approved — and an approver who is that person
 * approved their own figures (ADR-0421's open bypass: Bob creates a bill for 1, Alice PATCHes it to
 * 100 000, Alice approves). In a state a transition enters, `updated_by` is whoever fired that
 * transition, and refusing them would make an ordinary two-person flow impossible (the creator
 * submits an expense, the approver approves it, and then neither could reimburse it), so those
 * states are not read — which is the residual this rule leaves, stated rather than closed.
 *
 * `children` maps an approving entity to the records it owns by composition — a relation that
 * cascades a delete from the parent — whose authorship is authorship of the approved content: a
 * person who wrote a line of an entry wrote part of the entry.
 */
export interface ApprovalContent {
  readonly editorAttributable: ReadonlyMap<string, ReadonlySet<string>>;
  /** The approve-class transitions with a from-state a transition enters, sorted: the residual. */
  readonly editorUnread: readonly string[];
  readonly children: ReadonlyMap<string, readonly ApprovalContentChild[]>;
}

export function approvalContentFromManifest(manifest: Manifest): ApprovalContent {
  const editorAttributable = new Map<string, ReadonlySet<string>>();
  const editorUnread = new Set<string>();
  const approving = new Set<string>();
  for (const wf of Object.values(manifest.workflows ?? {})) {
    if (wf.kind !== "entityLifecycle") continue;
    const entered = new Set(wf.transitions.map((t) => t.to));
    for (const t of wf.transitions) {
      if (!isApproveClassTransition(wf.entity, t.name)) continue;
      approving.add(wf.entity);
      const froms = Array.isArray(t.from) ? t.from : [t.from];
      editorAttributable.set(`${wf.entity}.${t.name}`, new Set(froms.filter((f) => !entered.has(f))));
      if (froms.some((f) => entered.has(f))) editorUnread.add(`${wf.entity}.${t.name}`);
    }
  }
  const entities = new Map((manifest.entities ?? []).map((e) => [e.name, e]));
  const traits = manifest.traits ?? [];
  const referenceTo = (child: string, parent: string): string | null => {
    const entity = entities.get(child);
    if (entity === undefined) return null;
    const refs = resolvedFields(entity, traits).filter(
      (f) => f.type.kind === "reference" && f.type.target === parent,
    );
    return refs.length === 1 ? refs[0]!.name : null;
  };
  const children = new Map<string, ApprovalContentChild[]>();
  const add = (parent: string, child: ApprovalContentChild): void => {
    if (!approving.has(parent)) return;
    const list = children.get(parent) ?? [];
    if (!list.some((c) => c.entity === child.entity && c.parentField === child.parentField)) list.push(child);
    children.set(parent, list);
  };
  for (const r of manifest.relations ?? []) {
    if (r.kind === "many_to_many" || r.onDelete !== "cascade") continue;
    if (r.kind === "many_to_one") add(r.to, { entity: r.from, parentField: r.field });
    else {
      const field = referenceTo(r.to, r.from);
      if (field !== null) add(r.from, { entity: r.to, parentField: field });
    }
  }
  return { editorAttributable, editorUnread: [...editorUnread].sort(), children };
}

/** The largest number of child rows read for one approval before it refuses as unverifiable. */
export const APPROVAL_CONTENT_CEILING = 50_000;

export interface ApprovalContentInput {
  readonly content: ApprovalContent;
  readonly store: Pick<EntityStore, "listPage">;
  readonly tenantId: string;
  readonly entity: string;
  readonly transition: string;
  readonly id: string;
  readonly record: Readonly<EntityRecord>;
  /** The state the record is approved from, as the handler read it. */
  readonly fromState: string;
  /** A non-null actor: a null one is refused by {@link makerCheckerRefusal} before this is asked. */
  readonly actorId: string;
  readonly stampsActor: (entity: string) => boolean;
}

/**
 * The second half of the maker-checker rule: refused when the approver last edited the record in
 * a state only edits reach, or wrote any of the records it owns. Asked after
 * {@link makerCheckerRefusal}, and only of an approve-class transition with the switch on.
 *
 * A child set that cannot be read in full, or a child entity whose authorship is not server-stamped,
 * is unverifiable rather than passed — the creator rule's own direction.
 */
export async function approvalContentRefusal(input: ApprovalContentInput): Promise<MakerCheckerRefusal | null> {
  const { content, entity, transition, actorId } = input;
  const same = (v: unknown): boolean => typeof v === "string" && v.toLowerCase() === actorId.toLowerCase();
  if (content.editorAttributable.get(`${entity}.${transition}`)?.has(input.fromState) === true) {
    const editor = input.record[UPDATED_BY_FIELD];
    if (typeof editor !== "string" || editor.length === 0) {
      return {
        error: MAKER_CHECKER_ERRORS.unverifiable,
        detail: `'${transition}' on ${entity} requires a different person from the one who last edited it, and this record has no recorded editor`,
      };
    }
    if (same(editor)) {
      return {
        error: MAKER_CHECKER_ERRORS.same_person,
        detail: `'${transition}' on ${entity} must be fired by someone other than the person who last edited it`,
      };
    }
  }
  for (const child of content.children.get(entity) ?? []) {
    const stamped = input.stampsActor(child.entity);
    const seen: { found: "none" | "authored" | "unstamped" } = { found: "none" };
    const read = await drainList(
      input.store,
      input.tenantId,
      child.entity,
      { sort: [], filters: [{ field: child.parentField, op: "eq", value: input.id }] },
      { ceiling: APPROVAL_CONTENT_CEILING },
      (rows) => {
        for (const row of rows) {
          if (row[child.parentField] !== input.id || seen.found !== "none") continue;
          const author = row[CREATED_BY_FIELD];
          if (!stamped || typeof author !== "string" || author.length === 0) seen.found = "unstamped";
          else if (same(author) || same(row[UPDATED_BY_FIELD])) seen.found = "authored";
        }
      },
    );
    const found = seen.found;
    if (found === "authored") {
      return {
        error: MAKER_CHECKER_ERRORS.same_person,
        detail: `'${transition}' on ${entity} must be fired by someone other than anyone who wrote one of its ${child.entity} records`,
      };
    }
    if (found === "unstamped" || !read.complete) {
      return {
        error: MAKER_CHECKER_ERRORS.unverifiable,
        detail:
          found === "unstamped"
            ? `'${transition}' on ${entity} requires a different person from those who wrote its ${child.entity} records, and one of them has no recorded author`
            : `'${transition}' on ${entity} requires a different person from those who wrote its ${child.entity} records, and there are more than ${APPROVAL_CONTENT_CEILING.toString()} of them`,
      };
    }
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
  const residual = approvalContentFromManifest(manifest).editorUnread;
  return (
    `[sod] segregation of duties: on — ${gated.length} approve-class transition(s) refuse the` +
    ` record's own creator, its last editor where only edits reach the state it is approved from, and` +
    ` the author of any record it owns (${MAKER_CHECKER_ERRORS.same_person}): ${list}. A record with` +
    ` no recorded creator, or a request whose credential names no person, is refused` +
    ` (${MAKER_CHECKER_ERRORS.unverifiable}). From a state a transition enters, the last editor is not` +
    ` refused, because updated_by there names whoever fired that transition` +
    (residual.length === 0 ? "" : ` (${residual.join(", ")})`)
  );
}
