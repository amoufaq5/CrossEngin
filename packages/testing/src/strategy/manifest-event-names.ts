import { z } from "zod";

import { stripComments } from "./pg-column-coverage.js";
import { readWorkspaceSources } from "./workspace-sql-scan.js";

/**
 * The rule: **no event-triggered job declares a name nothing in its own resolved pack can emit,
 * without a declaration saying what is missing.**
 *
 * `matchEventJobs` compares a declaration's `eventName` against the emitted event's name with
 * `===`, and the only producer of an entity event is `entityEventEffect`, whose grammar is
 * `<prefix?>.<entity>.<verb>`. So the two halves of an event job are addressed by one string, and
 * nothing compared the two sides: measured against the real `resolveManifest` over all seven packs,
 * **55 of 55 (pack, declaration) instances named an event no deployment could emit**, over 12
 * distinct names, every one of them two-part (`erp.invoice_issued`) against a three-part grammar.
 * `JOB_KIND_PRODUCERS` answers `event_emitter` for the kind, which is true and is one coarsening
 * away from the question — the same narrow predicate ADR-0361 found in `entityClassifiedFields`,
 * read on a producer rather than on a field list.
 *
 * **Why the fence has to be per pack and not over the union.** The producible set is a property of
 * the *resolved* manifest, and `mergeRecord` lets an overlay win by workflow key — so a pack that
 * replaces an inherited lifecycle takes its transition targets away. `erp-construction` does
 * exactly that: it declares `work_order_lifecycle` over `draft → scheduled → in_progress → done`,
 * replacing core's `… → completed`, so core's `erp-core-work-order-completion` job is addressable
 * on **six** resolved packs and on construction names nothing. A union over the seven packs would
 * read that as served, which is the direction that matters: an over-wide producible set
 * *under*-reports findings.
 *
 * **Why no prefix.** `--emit-entity-events` takes an optional `--event-prefix`, and the fence is
 * computed with none, which is both the deployment default and the only answer a pack can be held
 * to — a pack cannot know a deployment's prefix. It is also not a lost opportunity: a prefix makes
 * every emitted name three-part, so a two-part declaration matches nothing *and* a declaration
 * written for a prefixed deployment matches nothing on an unprefixed one. The names this fence
 * admits are the ones that work when no prefix is set.
 *
 * **Why the facts are scanned from disk and the grammar is spelled twice.** `@crossengin/kernel`
 * devDepends on `@crossengin/testing`, and so does every pack, so importing either would make
 * `turbo run build`'s graph cyclic; reading their `dist` would make the rule green only after a
 * build. That is the constraint every rule beside it lives under. It costs one thing this rule
 * cannot wish away: `eventNameSegment`'s transform and `ENTITY_EVENT_VERBS` are spelled here a
 * second time, which is the defect class this increment is about. So they are **pinned by reading
 * the first spelling as text** — `assertGrammarMatchesKernel` compares the three regexes, the three
 * verbs and the separator against `packages/kernel/src/manifest/event-names.ts` — which is
 * `pg-column-coverage.ts`' relationship to `META_TABLES` and the only form of agreement available
 * across a dependency edge that cannot exist.
 *
 * **An unparsed declaration is a finding, never a skip.** A scan that quietly loses a lifecycle
 * answers a smaller producible set, and a smaller set over-reports findings — safe today and one
 * regex from the opposite. Measured during this increment: a first scan reading only the literal
 * `: EntityLifecycleWorkflow = {` form found **7** of core's 19 lifecycles and 180 of its 230
 * producible names, because `workflows-ext.ts` builds twelve through a `lifecycle(...)` factory.
 * `lifecycle_unparsed`, `entity_unreferenced` and `event_trigger_unattributed` are what make that
 * kind of loss red rather than reassuring.
 */

/* ------------------------------------------------------------------ reasons */

/**
 * Why a declared event name is unproducible on a pack, and both members cost something checkable.
 *
 * `pg-unreachable-stores.ts`' rule, which this directory has now applied five times: a declaration
 * whose only content is prose is a declaration nobody can re-adjudicate. So
 * `witness_named_differently` must name the producible name it defers to and the rule asserts that
 * name is itself producible, and `no_producible_counterpart` must name what is absent and the rule
 * asserts it really is.
 *
 * The split is `prerequisite_of_unbuilt_surface` versus `contract_cannot_carry_the_surface` one
 * domain across: a witness that exists under another name is an **ordering** problem — somebody
 * decides whether the two acts are the same business fact and repoints the declaration — while a
 * missing entity is a **shape** problem that no rename can reach. Calling both "unproducible" would
 * send the next person to rename a job onto an event that does not mean what the job is for, which
 * is ADR-0337's falsely-true direction and invisible once it runs.
 */
export const EVENT_NAME_REASONS = [
  /** A write in this pack does witness the fact, under a different name. A repointing decision. */
  "witness_named_differently",
  /** Nothing in this pack can witness it: the entity, its lifecycle or the state is absent. */
  "no_producible_counterpart",
] as const;
export type EventNameReason = (typeof EVENT_NAME_REASONS)[number];

/** Only a `witness_named_differently` declaration may name a witness, and it must name one. */
export const WITNESS_BEARING_REASONS: readonly EventNameReason[] = ["witness_named_differently"];

/** Only a `no_producible_counterpart` declaration may name what is absent, and it must. */
export const MISSING_BEARING_REASONS: readonly EventNameReason[] = ["no_producible_counterpart"];

/**
 * How a counterpart is missing, which is what decides *which* absence the rule goes and checks.
 *
 * Three members rather than one prose field, because the remedies are not interchangeable and two
 * of them are a pack change a domain owner could make this afternoon: `state` wants one entry in a
 * lifecycle's transition list, `lifecycle` wants a workflow declared over an entity that already
 * exists — while `entity` wants an entity the product does not model, which is a different size of
 * decision. Stating the kind is also what keeps the check honest: `entity` is refuted by the
 * entity existing, `lifecycle` by a workflow targeting it, and `state` by the target being there —
 * three different questions, and a single `missing: string` would have had to guess which.
 */
export const MISSING_KINDS = [
  /** No entity of this name exists in the resolved pack. */
  "entity",
  /** The entity exists and no `entityLifecycle` workflow targets it. */
  "lifecycle",
  /** The entity and its lifecycle exist, and no transition goes *to* this state. */
  "state",
] as const;
export type MissingKind = (typeof MISSING_KINDS)[number];

const ENTITY_NAME = /^[A-Z][A-Za-z0-9]*$/;
const ENTITY_STATE = /^[A-Z][A-Za-z0-9]*\.[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * The shape a `missing` claim must take per kind — a total map, so a fourth kind cannot inherit
 * whichever pattern the last branch used.
 *
 * `entity` and `lifecycle` name an entity because that is the subject of both absences; `state`
 * names the pair, because a bare state name would not say which entity's lifecycle was read and the
 * same state name lives on a dozen of them.
 */
export const MISSING_KIND_SHAPES: Readonly<Record<MissingKind, RegExp>> = Object.freeze({
  entity: ENTITY_NAME,
  lifecycle: ENTITY_NAME,
  state: ENTITY_STATE,
});

/* -------------------------------------------------------------- declarations */

const PACK_SLUG = /^operate-erp\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JOB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVENT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export const EventNameDeclarationSchema = z
  .object({
    /** The declaring job's id, exactly as `JobDeclaration.id` spells it. The declaration's key. */
    jobId: z.string().regex(JOB_ID),
    /**
     * The event name as declared today.
     *
     * Carried so a rename re-opens the adjudication rather than inheriting it: the whole content of
     * a declaration is a judgement about one string, and `pg-binding-names.ts`' rule is that a
     * declaration which can go stale without going red is not a declaration.
     */
    eventName: z.string().regex(EVENT_NAME),
    /**
     * Exactly the pack slugs on which this name is unproducible — not "the packs this is about".
     *
     * The audit compares it against the resolved facts in both directions, so a pack where the name
     * cannot be emitted and is not named here is `undeclared`, and a pack named here where it *can*
     * be is `overtaken`. That is what makes a per-pack difference legible instead of averaged away:
     * `erp-core-work-order-completion` names one pack, and the other six are served.
     */
    packs: z.array(z.string().regex(PACK_SLUG)).min(1),
    reason: z.enum(EVENT_NAME_REASONS),
    /** The producible name that witnesses the same fact. `witness_named_differently` only. */
    witness: z.string().regex(EVENT_NAME).optional(),
    /** What is absent, shaped by `missingKind`. `no_producible_counterpart` only. */
    missing: z.string().min(1).optional(),
    /** Which absence the rule checks. `no_producible_counterpart` only. */
    missingKind: z.enum(MISSING_KINDS).optional(),
    /** The evidence: which act the pack does have, why the near miss is not the same fact. */
    note: z.string().min(20),
  })
  .superRefine((value, ctx) => {
    const wants = (set: readonly EventNameReason[]): boolean => set.includes(value.reason);
    if (wants(WITNESS_BEARING_REASONS) !== (value.witness !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["witness"],
        message: `only a witness_named_differently declaration may name a witness, and it must name one (${value.reason})`,
      });
    }
    const missingWanted = wants(MISSING_BEARING_REASONS);
    if (missingWanted !== (value.missing !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["missing"],
        message: `only a no_producible_counterpart declaration may name what is absent, and it must name one (${value.reason})`,
      });
    }
    if (missingWanted !== (value.missingKind !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["missingKind"],
        message: `only a no_producible_counterpart declaration may name a missing kind, and it must name one (${value.reason})`,
      });
    }
    if (
      value.missing !== undefined &&
      value.missingKind !== undefined &&
      !MISSING_KIND_SHAPES[value.missingKind].test(value.missing)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["missing"],
        message: `a '${value.missingKind}' absence names ${MISSING_KIND_SHAPES[value.missingKind].source}, not '${value.missing}'`,
      });
    }
    if (value.witness === value.eventName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["witness"],
        message: "a witness equal to the declared name would claim the name produces itself",
      });
    }
  });
export type EventNameDeclaration = z.infer<typeof EventNameDeclarationSchema>;

/**
 * The seven pack slugs, spelled only so a declaration that applies everywhere says so once.
 *
 * It needs no comparison against the scan of its own: an eighth pack inheriting one of core's three
 * declarations reports `undeclared` naming it, and a slug no pack has reports `unknown_pack`, so the
 * live audit already pins this list in both directions.
 */
const ALL_PACKS: readonly string[] = [
  "operate-erp/construction",
  "operate-erp/core",
  "operate-erp/education",
  "operate-erp/government",
  "operate-erp/grocery",
  "operate-erp/healthcare",
  "operate-erp/retail",
];

/**
 * The event names no resolved pack can emit, after the four that a rename reached were renamed.
 *
 * The four renames are not here and that is the point of the split: `erp.quote_sent`,
 * `erp.lead_created`, `erp.sales_order_fulfilled` and `erp.work_order_completed` each landed on a
 * name the emitter already produces — `quote.sent`, `lead.created`, `salesorder.fulfilled`,
 * `workorder.completed` — so they needed a correction and not an adjudication. **27 of the 55
 * instances** were cleared that way. These nine (over 28 instances) are the residue, and the three
 * that name every pack are core's, inherited by all seven.
 */
export const MANIFEST_EVENT_NAME_DECLARATIONS: readonly EventNameDeclaration[] =
  z.array(EventNameDeclarationSchema).parse([
    {
      jobId: "erp-core-payment-received-handler",
      eventName: "billing.payment_received",
      packs: [...ALL_PACKS],
      reason: "witness_named_differently",
      witness: "payment.completed",
      note: "Payment's lifecycle is pending → completed / failed / refunded, so `payment.received` is producible nowhere and nothing producible anywhere ends in `.received` but `purchaseorder.received`. Deliberately not repointed: a payment being *received* is money arriving, and `completed` is the processing of it clearing — a received payment may still fail, so firing the invoice-to-paid signal on `completed` is the stricter and probably correct moment, but it is a domain decision and not a rename. (`perishablelot.received` looks like a second candidate and is not producible either: `received` is PerishableLot's *initial* state, reached by a create, so the emitted name is `perishablelot.created`.)",
    },
    {
      jobId: "erp-core-einvoice-submission",
      eventName: "erp.invoice_issued",
      packs: [...ALL_PACKS],
      reason: "witness_named_differently",
      witness: "invoice.sent",
      note: "Invoice's lifecycle is draft → sent → overdue / paid / void, and nothing producible in any of the seven packs ends in `.issued` at all. `sent` is the act an e-invoice submission belongs to — the clearance portal is called on issue, which this manifest spells as sending — but 'issued' and 'sent' are separate events in several tax regimes (ZATCA clearance precedes delivery), so repointing is a decision about which one the integration owns.",
    },
    {
      jobId: "erp-core-payroll-disbursement",
      eventName: "erp.payroll_approved",
      packs: [...ALL_PACKS],
      reason: "no_producible_counterpart",
      missing: "Payroll",
      missingKind: "entity",
      note: "No Payroll or PayrollRun entity exists in any of the seven packs: core's HR module is Department / Position / Employee / Timesheet / LeaveRequest, so there is no record whose approval could be emitted. The job's own description is of a payroll run pushing net-pay instructions to a provider, which is the entity that would have to be modelled first.",
    },
    {
      jobId: "erp-core-work-order-completion",
      eventName: "workorder.completed",
      packs: ["operate-erp/construction"],
      reason: "no_producible_counterpart",
      missing: "WorkOrder.completed",
      missingKind: "state",
      note: "Construction replaced core's WorkOrder *and* keyed its own workflow `work_order_lifecycle`, so `mergeRecord` hands the resolved manifest a lifecycle over draft → scheduled → in_progress → done and core's `completed` target is gone. `workorder.done` is producible here and is deliberately not declared a witness: core's job consumes BOM components and receives a finished good into a warehouse, and construction's WorkOrder is a subcontractor order with no bill of materials — so the two acts share a verb and not a fact, and a repointing would run manufacturing postings against a building site. This core job is inert on this pack, and that is the honest state until the pack declares its own.",
    },
    {
      jobId: "erp-retail-order-placed-handler",
      eventName: "retail.order_placed",
      packs: ["operate-erp/grocery", "operate-erp/retail"],
      reason: "witness_named_differently",
      witness: "salesorder.placed",
      note: "Retail's own lifecycle is cart → placed → fulfilled / cancelled / returned, so the act exists and the *entity* is SalesOrder — `order.placed` names nothing because there is no Order entity. The rename is mechanical and is held back only because the two packs that resolve this job are the two where `salesorder.placed` is producible, so it must be verified against grocery as well as retail.",
    },
    {
      jobId: "erp-healthcare-lab-result-received-handler",
      eventName: "healthcare.lab_result_received",
      packs: ["operate-erp/healthcare"],
      reason: "no_producible_counterpart",
      missing: "LabResult",
      missingKind: "entity",
      note: "There is no LabResult entity. Observation is the nearest record and is a different thing — a single measured value on an Encounter, with no lifecycle at all — so no state of it is emitted and `observation.created` is not a lab result arriving from an external analyser. A HL7/FHIR ingest entity would have to be modelled first.",
    },
    {
      jobId: "erp-construction-inspection-completed-handler",
      eventName: "construction.inspection_completed",
      packs: ["operate-erp/construction"],
      reason: "no_producible_counterpart",
      missing: "Inspection",
      missingKind: "entity",
      note: "The pack declares Project, WorkOrder and Subcontractor and no Inspection, so there is no record whose completion could be emitted. `project.completed` is producible and is a different fact at a different granularity — a whole project finishing, not one site inspection passing.",
    },
    {
      jobId: "erp-education-grade-posted-handler",
      eventName: "education.grade_posted",
      packs: ["operate-erp/education"],
      reason: "no_producible_counterpart",
      missing: "Enrollment.posted",
      missingKind: "state",
      note: "Enrollment exists and its lifecycle exists — active → completed / withdrawn / failed — and none of its transitions goes to a posted or graded state. So the remedy is the smallest of the five: one state and one transition on a lifecycle this pack already owns, which is why this and the government permit are the two a domain owner could close without modelling anything new.",
    },
    {
      jobId: "erp-government-permit-issued-handler",
      eventName: "government.permit_issued",
      packs: ["operate-erp/government"],
      reason: "no_producible_counterpart",
      missing: "Permit",
      missingKind: "lifecycle",
      note: "The Permit entity exists — `permit.created`, `permit.updated` and `permit.deleted` are all producible — and no entityLifecycle workflow targets it, so it has no states and no transition can be emitted. The pack declares `case_lifecycle` over Case and stops there; an issuance lifecycle over Permit is the remedy, and it is a pack change rather than a modelling one.",
    },
  ]);

/* -------------------------------------------------------------------- facts */

export const TRIGGER_KINDS = ["event", "delayed"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * Which field of a trigger holds the name, so a finding can say where the remedy is.
 *
 * A total map rather than a sentence in the message, because the two kinds spell the same
 * obligation in different fields and a finding that named the wrong one would send an operator to a
 * field the declaration does not have — `triggerEventName`'s reason for being a `switch` in
 * `@crossengin/jobs`, read from the other side.
 */
export const TRIGGER_NAME_FIELD: Readonly<Record<TriggerKind, string>> = Object.freeze({
  event: "eventName",
  delayed: "afterEvent",
});

export const DeclaredEventSchema = z.object({
  jobId: z.string().min(1),
  eventName: z.string().min(1),
  /** `event` or `delayed` — the two trigger kinds addressed by a name. */
  triggerKind: z.enum(TRIGGER_KINDS),
});
export type DeclaredEvent = z.infer<typeof DeclaredEventSchema>;

export const LifecycleFactsSchema = z.object({
  /** The workflow map key, which is what an overlay overrides by. */
  key: z.string().min(1),
  entity: z.string().min(1),
  /** Transition **targets**, never `states`: a state nothing transitions to is never emitted. */
  targets: z.array(z.string().min(1)),
});
export type LifecycleFacts = z.infer<typeof LifecycleFactsSchema>;

/**
 * One resolved pack, as the audit needs it.
 *
 * `producibleEventNames` is carried rather than re-derived from `entities` and `lifecycles`,
 * because the audit must not hold a third copy of the grammar. The two field groups answer
 * different questions: the name set answers *is this addressable*, and the entity and lifecycle
 * facts answer *in which way is the counterpart absent* — a declaration's claim, which needs no
 * grammar at all.
 */
export const ResolvedPackFactsSchema = z.object({
  pack: z.string().regex(PACK_SLUG),
  entities: z.array(z.string().min(1)),
  lifecycles: z.array(LifecycleFactsSchema),
  producibleEventNames: z.array(z.string().min(1)),
  declaredEvents: z.array(DeclaredEventSchema),
});
export type ResolvedPackFacts = z.infer<typeof ResolvedPackFactsSchema>;

/* ----------------------------------------------------------------- findings */

export const EVENT_NAME_FINDING_KINDS = [
  /** A declared event name no resolved pack can emit, with no declaration. **This is the fence.** */
  "undeclared",
  /** Declared unproducible on a pack that can emit it now — overtaken by a rename or a lifecycle. */
  "overtaken",
  /** A declaration naming a job no resolved pack declares. */
  "unknown_job",
  /** A declaration whose job declares a different event name now, so the judgement is about a name nobody uses. */
  "event_name_changed",
  /** A declaration naming a pack slug no scanned pack has. */
  "unknown_pack",
  /** Declared twice for one job, which would let two contradictory reasons both pass. */
  "duplicate",
  /** `witness_named_differently` naming a witness that is itself unproducible on a named pack. */
  "witness_unproducible",
  /** `no_producible_counterpart` naming something the resolved pack turns out to have. */
  "counterpart_present",
] as const;
export type EventNameFindingKind = (typeof EVENT_NAME_FINDING_KINDS)[number];

export interface EventNameFinding {
  readonly kind: EventNameFindingKind;
  /** The job the finding is about, which is the key every finding can name. */
  readonly jobId: string;
  /** The pack slug, or `""` for a finding about the declaration rather than about a pack. */
  readonly pack: string;
  readonly detail: string;
}

export interface EventNameAuditInput {
  readonly packs: readonly ResolvedPackFacts[];
  readonly declarations: readonly EventNameDeclaration[];
}

/**
 * Reports every member of the class. An empty array is the invariant holding.
 *
 * `undeclared` is phrased from the manifests' side and `overtaken` from the declarations', so the
 * two pin the list in both directions — the property that distinguishes this from the
 * hand-maintained list ADR-0288 found wrong three times. `packs` makes that comparison per pack
 * rather than per name, which is the only grain at which a per-pack lifecycle override is visible.
 */
export function auditManifestEventNames(
  input: EventNameAuditInput,
): readonly EventNameFinding[] {
  const { packs, declarations } = input;
  const findings: EventNameFinding[] = [];
  const byJob = new Map<string, EventNameDeclaration>();
  for (const declaration of declarations) {
    if (byJob.has(declaration.jobId)) {
      findings.push({
        kind: "duplicate",
        jobId: declaration.jobId,
        pack: "",
        detail: `${declaration.jobId} is declared more than once, so two reasons would both pass`,
      });
      continue;
    }
    byJob.set(declaration.jobId, declaration);
  }

  const packBySlug = new Map<string, ResolvedPackFacts>();
  for (const pack of packs) packBySlug.set(pack.pack, pack);

  /** (jobId, pack) pairs some resolved pack declares, so an unknown declaration is reportable. */
  const declaredIn = new Map<string, Set<string>>();
  for (const pack of packs) {
    const producible = new Set(pack.producibleEventNames);
    for (const event of pack.declaredEvents) {
      const seen = declaredIn.get(event.jobId) ?? new Set<string>();
      seen.add(pack.pack);
      declaredIn.set(event.jobId, seen);
      if (producible.has(event.eventName)) continue;
      const declaration = byJob.get(event.jobId);
      // The declaration has to name this pack **and this name**. Reading the job id alone was this
      // increment's own class inside its own fence: a declaration whose `eventName` had gone stale
      // would go on covering whatever the job was renamed to, which is an adjudication of a string
      // nobody uses silencing the one in use. Caught by the test written for `event_name_changed`.
      const covers =
        declaration !== undefined &&
        declaration.packs.includes(pack.pack) &&
        declaration.eventName === event.eventName;
      if (covers) continue;
      findings.push({
        kind: "undeclared",
        jobId: event.jobId,
        pack: pack.pack,
        detail:
          `'${event.jobId}' is triggered by ${TRIGGER_NAME_FIELD[event.triggerKind]} ` +
          `'${event.eventName}', which nothing in ${pack.pack} emits, and ` +
          (declaration === undefined
            ? "no declaration names it"
            : declaration.eventName !== event.eventName
              ? `its declaration adjudicates '${declaration.eventName}' instead`
              : `its declaration does not name this pack (it names ${declaration.packs.join(", ")})`),
      });
    }
  }

  for (const declaration of byJob.values()) {
    const packsDeclaring = declaredIn.get(declaration.jobId);
    if (packsDeclaring === undefined) {
      findings.push({
        kind: "unknown_job",
        jobId: declaration.jobId,
        pack: "",
        detail: `no resolved pack declares an event-triggered job '${declaration.jobId}'`,
      });
      continue;
    }
    findings.push(...adjudicate(declaration, packsDeclaring, packBySlug));
  }
  return findings;
}

function adjudicate(
  declaration: EventNameDeclaration,
  packsDeclaring: ReadonlySet<string>,
  packBySlug: ReadonlyMap<string, ResolvedPackFacts>,
): readonly EventNameFinding[] {
  const findings: EventNameFinding[] = [];
  const { jobId } = declaration;
  for (const slug of declaration.packs) {
    const pack = packBySlug.get(slug);
    if (pack === undefined) {
      findings.push({
        kind: "unknown_pack",
        jobId,
        pack: slug,
        detail: `${jobId} is declared for '${slug}', which no scanned pack has`,
      });
      continue;
    }
    if (!packsDeclaring.has(slug)) {
      findings.push({
        kind: "unknown_job",
        jobId,
        pack: slug,
        detail: `${slug} does not resolve an event-triggered job '${jobId}'`,
      });
      continue;
    }
    const declared = pack.declaredEvents.find((e) => e.jobId === jobId);
    if (declared !== undefined && declared.eventName !== declaration.eventName) {
      findings.push({
        kind: "event_name_changed",
        jobId,
        pack: slug,
        detail:
          `${jobId} now declares '${declared.eventName}' and the adjudication is written about ` +
          `'${declaration.eventName}', so it has to be re-made against the name in use`,
      });
      continue;
    }
    const producible = new Set(pack.producibleEventNames);
    if (producible.has(declaration.eventName)) {
      findings.push({
        kind: "overtaken",
        jobId,
        pack: slug,
        detail:
          `${slug} can emit '${declaration.eventName}' now, so the declaration describes a gap ` +
          "that has closed — delete the pack from its `packs`, or the declaration if that empties it",
      });
      continue;
    }
    findings.push(...checkClaim(declaration, pack, producible));
  }
  return findings;
}

/**
 * Checks the declaration's own claim against the resolved pack.
 *
 * Run only for a pack where the name really is unproducible, which is deliberate: a witness or an
 * absence asserted about a pack that no longer needs the declaration is noise beside the
 * `overtaken` finding that is the thing to act on.
 */
function checkClaim(
  declaration: EventNameDeclaration,
  pack: ResolvedPackFacts,
  producible: ReadonlySet<string>,
): readonly EventNameFinding[] {
  const { jobId, witness, missing, missingKind } = declaration;
  const slug = pack.pack;
  if (witness !== undefined) {
    return producible.has(witness)
      ? []
      : [
          {
            kind: "witness_unproducible",
            jobId,
            pack: slug,
            detail:
              `${jobId} defers to the witness '${witness}', which ${slug} cannot emit either — so ` +
              "the declaration names a remedy that does not exist",
          },
        ];
  }
  if (missing === undefined || missingKind === undefined) return [];
  const present = counterpartPresent(missingKind, missing, pack);
  return present === null
    ? []
    : [
        {
          kind: "counterpart_present",
          jobId,
          pack: slug,
          detail: `${jobId} declares '${missing}' absent from ${slug}, and ${present}`,
        },
      ];
}

/**
 * The absence the kind names, refuted or not — `null` when the claim stands.
 *
 * A `switch` over the kind rather than a map of predicates, because the three ask structurally
 * different questions of different shapes of `missing`, and the explicit return type makes a fourth
 * kind a compile error at the missing `case` exactly as a total map would.
 */
function counterpartPresent(
  kind: MissingKind,
  missing: string,
  pack: ResolvedPackFacts,
): string | null {
  switch (kind) {
    case "entity":
      return pack.entities.includes(missing) ? "the pack declares that entity" : null;
    case "lifecycle": {
      const lifecycle = pack.lifecycles.find((l) => l.entity === missing);
      if (!pack.entities.includes(missing)) {
        return (
          "the pack has no such entity either, so the absence is an 'entity' one and the " +
          "remedy named is the wrong one"
        );
      }
      return lifecycle === undefined
        ? null
        : `the workflow '${lifecycle.key}' is an entityLifecycle over it, with targets ${lifecycle.targets.join(", ")}`;
    }
    case "state": {
      const dot = missing.indexOf(".");
      const entity = missing.slice(0, dot);
      const state = missing.slice(dot + 1);
      if (!pack.entities.includes(entity)) {
        return `the pack has no '${entity}' entity, so the absence is an 'entity' one`;
      }
      const lifecycles = pack.lifecycles.filter((l) => l.entity === entity);
      if (lifecycles.length === 0) {
        return `no entityLifecycle targets '${entity}', so the absence is a 'lifecycle' one`;
      }
      const hit = lifecycles.find((l) => l.targets.includes(state));
      return hit === undefined ? null : `the workflow '${hit.key}' transitions to '${state}'`;
    }
  }
}

/* --------------------------------------------------------------------- scan */

/** The one spelling of the grammar in kernel, read as text so this module's copy can be pinned. */
export const KERNEL_EVENT_NAMES_PATH = "packages/kernel/src/manifest/event-names.ts";

/**
 * The three verbs `ENTITY_EVENT_VERBS` maps the fixed operations to.
 *
 * A second spelling, and `assertGrammarMatchesKernel` is what keeps it one: this package cannot
 * import `@crossengin/kernel` without making `turbo run build`'s graph cyclic, so the agreement has
 * to be read rather than typed.
 */
const VERBS: readonly string[] = ["created", "updated", "deleted"];

/**
 * `eventNameSegment`'s transform, pinned against kernel's source by `grammarAgreement`.
 *
 * Exported so the copy can be held to known answers directly rather than only through whichever
 * entity names the packs happen to declare: the packs are all PascalCase and snake_case, so the
 * `x_` escape and the trailing-underscore strip are unreachable from the live scan and would drift
 * unnoticed.
 */
export function scanEventNameSegment(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(s) ? s : `x_${s}`;
}

export interface GrammarAgreement {
  /** Every fragment of kernel's spelling this module reproduces, and whether its source holds it. */
  readonly checks: readonly { readonly fragment: string; readonly found: boolean }[];
}

/**
 * The fragments of kernel's `event-names.ts` that `scanEventNameSegment` and `VERBS` reproduce.
 *
 * Overridable by `grammarAgreement`'s parameter for one reason: a test asserting *all found* passes
 * equally well against a `found` that is hardcoded true, so the only way to show the comparison runs
 * is to hand it something kernel does not contain. The default is the real list.
 */
export const GRAMMAR_FRAGMENTS: readonly string[] = [
  'replace(/[^a-z0-9]+/g, "_")',
  'replace(/^_+|_+$/g, "")',
  'test(s) ? s : `x_${s}`',
  'create: "created"',
  'update: "updated"',
  'delete: "deleted"',
  '.join(".")',
];

/**
 * Compares this module's copy of the grammar against kernel's source text.
 *
 * Fragments rather than a parse, because what has to agree is small and exact: two character
 * classes, the `x_` escape, the three verbs and the `.` join. A diverged fragment is reported
 * rather than thrown so the caller asserts on it, which is `workspaceRoots`' rule for the same
 * reason — an assertion that throws inside the scan is one that gets reverted.
 */
export function grammarAgreement(
  fragments: readonly string[] = GRAMMAR_FRAGMENTS,
): GrammarAgreement {
  const source = stripComments(readKernelEventNames());
  const compact = source.replace(/\s+/g, " ");
  return {
    checks: fragments.map((fragment) => ({
      fragment,
      found: compact.includes(fragment.replace(/\s+/g, " ")),
    })),
  };
}

function readKernelEventNames(): string {
  const file = readWorkspaceSources().files.find(
    (f) => f.file === KERNEL_EVENT_NAMES_PATH,
  );
  if (file === undefined) {
    throw new Error(
      `${KERNEL_EVENT_NAMES_PATH} is not in the workspace scan; the grammar cannot be pinned`,
    );
  }
  return file.text;
}

export const SCAN_DEFECT_KINDS = [
  /** A workflow map key naming a const the scan cannot read as a lifecycle. */
  "lifecycle_unparsed",
  /** An `: Entity = {` const no entity array of its pack reaches. */
  "entity_unreferenced",
  /** An `eventName:` / `afterEvent:` / `event(` / `delayed(` occurrence inside no parsed job. */
  "event_trigger_unattributed",
  /** A pack whose slug, `extends` identifier or entity list the scan cannot resolve. */
  "pack_unresolved",
  /** Two workflow maps in one pack declaring the same key, so which lifecycle wins is a guess. */
  "workflow_key_ambiguous",
] as const;
export type ScanDefectKind = (typeof SCAN_DEFECT_KINDS)[number];

export interface ScanDefect {
  readonly kind: ScanDefectKind;
  readonly pack: string;
  readonly detail: string;
}

export interface PackEventScan {
  readonly packs: readonly ResolvedPackFacts[];
  /**
   * What the scan could not read.
   *
   * Reported and not skipped, because a lost lifecycle answers a *smaller* producible set and a
   * smaller set over-reports findings — safe today and one regex from the opposite. The first
   * version of this scan lost twelve of core's nineteen lifecycles in silence.
   */
  readonly defects: readonly ScanDefect[];
  /** Files read, so a walk that found nothing cannot pass. */
  readonly files: number;
}

const PACK_PACKAGE = /^@crossengin\/pack-erp-[a-z0-9-]+$/;

/** One pack's own declarations, before its lineage is merged in. */
export interface PackSource {
  readonly slug: string;
  readonly parents: readonly string[];
  readonly entities: readonly string[];
  readonly lifecycles: readonly LifecycleFacts[];
  readonly declaredEvents: readonly DeclaredEvent[];
}

/**
 * Reads every `pack-erp-*` member and resolves each pack's lineage the way `mergeContent` does for
 * the three things this rule needs: entities by **name**, workflows by **map key**, jobs by id.
 *
 * Deliberately not a general manifest resolver. Those three merges are two spread expressions and a
 * name index in `extends.ts`, and reproducing anything beyond them — relation pruning, search
 * entity merges, i18n bundles — would make this scan the second spelling of a module it cannot
 * import, which is the class the rule exists to close.
 */
export function scanPackEventFacts(): PackEventScan {
  const sources = readWorkspaceSources();
  const byPackage = new Map<string, PackSourceFile[]>();
  let files = 0;
  for (const file of sources.files) {
    if (!PACK_PACKAGE.test(file.package)) continue;
    files += 1;
    const list = byPackage.get(file.package) ?? [];
    list.push({ file: file.file, text: stripComments(file.text) });
    byPackage.set(file.package, list);
  }

  const defects: ScanDefect[] = [];
  // Every pack's slug constants first: `extends: [ERP_CORE_PACK_SLUG]` names an identifier the
  // declaring pack imports, so a parent cannot be resolved from one member's text alone.
  const slugConstants = new Map<string, string>();
  for (const list of byPackage.values()) {
    for (const { text } of list) {
      for (const m of text.matchAll(/\b([A-Z0-9_]*_PACK_SLUG)\s*=\s*"([^"]+)"/g)) {
        slugConstants.set(m[1] ?? "", m[2] ?? "");
      }
    }
  }

  const members: { member: string; source: PackSource }[] = [];
  for (const [name, list] of byPackage) {
    const source = parsePackSources(name, list, slugConstants, defects);
    if (source !== null) members.push({ member: name, source });
  }
  const parsed = indexPacksBySlug(members, defects);

  const packs: ResolvedPackFacts[] = [];
  for (const source of [...parsed.values()].sort((a, b) => a.slug.localeCompare(b.slug))) {
    packs.push(resolvePack(source, parsed, defects));
  }
  return { packs, defects, files };
}

/**
 * Indexes the parsed packs by slug, which is how `extends` addresses them.
 *
 * Its own function so the collision is reachable from a fixture: a slug is a constant two members
 * could both declare, and the second would otherwise replace the first in silence — leaving a
 * lineage resolved against a manifest nobody named. Exported for that reason only.
 */
export function indexPacksBySlug(
  sources: readonly { readonly member: string; readonly source: PackSource }[],
  defects: ScanDefect[],
): ReadonlyMap<string, PackSource> {
  const parsed = new Map<string, PackSource>();
  for (const { member, source } of sources) {
    if (parsed.has(source.slug)) {
      defects.push({
        kind: "pack_unresolved",
        pack: source.slug,
        detail: `${member} declares a slug another member already declares, so which manifest a lineage resolves to is a guess`,
      });
      continue;
    }
    parsed.set(source.slug, source);
  }
  return parsed;
}

export interface PackSourceFile {
  /** Workspace-relative, as `readWorkspaceSources` spells it — only the `/src/pack.ts` suffix matters. */
  readonly file: string;
  /** Comment-stripped text. */
  readonly text: string;
}

/**
 * Parses one pack member's own declarations.
 *
 * Exported with `ScanDefect[]` as an out-parameter so a fixture can drive each extractor directly.
 * That is not a convenience: the live packs happen to satisfy every guard — every `: Entity = {`
 * const is reached by its pack's entity array, every workflow key resolves to a parsed lifecycle —
 * so a test over the real workspace alone cannot distinguish this scan from one that ignores the
 * array and takes every const it finds. Measured: both mutations passed 559 of 559 tests before
 * this seam existed, which is ADR-0355's "a measurement taken once goes stale silently" in a scan
 * rather than in a derivation.
 */
export function parsePackSources(
  packageName: string,
  list: readonly PackSourceFile[],
  slugConstants: ReadonlyMap<string, string>,
  defects: ScanDefect[],
): PackSource | null {
  const packFile = list.find((f) => f.file.endsWith("/src/pack.ts"));
  if (packFile === undefined) {
    defects.push({ kind: "pack_unresolved", pack: packageName, detail: "no src/pack.ts" });
    return null;
  }
  const own = /export const ([A-Z0-9_]*_PACK_SLUG)\s*=\s*"([^"]+)"/.exec(packFile.text);
  if (own === null) {
    defects.push({
      kind: "pack_unresolved",
      pack: packageName,
      detail: "src/pack.ts declares no *_PACK_SLUG constant",
    });
    return null;
  }
  const slug = own[2] ?? "";

  const parents: string[] = [];
  for (const m of packFile.text.matchAll(/\bextends:\s*\[([^\]]*)\]/g)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const ident = raw.trim();
      if (ident === "") continue;
      const resolved = slugConstants.get(ident);
      if (resolved === undefined) {
        defects.push({
          kind: "pack_unresolved",
          pack: slug,
          detail: `extends names '${ident}', which no pack declares as a slug constant`,
        });
        continue;
      }
      parents.push(resolved);
    }
  }

  const entities = parseEntities(slug, packFile, list, defects);
  const lifecycles = parseLifecycles(slug, list, defects);
  const declaredEvents = parseJobs(slug, list, defects);
  return { slug, parents, entities, lifecycles, declaredEvents };
}

/* ---------------------------------------------------------------- extractors */

/**
 * The span of the balanced bracket starting at `open`, string bodies skipped.
 *
 * Its own helper rather than `pg-column-coverage.ts`' `statementSpan`, which counts braces from a
 * SQL template's position and answers a different question. Strings are skipped because a pack's
 * prose descriptions contain brackets.
 */
function span(text: string, open: number): string | null {
  const first = text[open];
  if (first !== "[" && first !== "{" && first !== "(") return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i] ?? "";
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (c === "[" || c === "{" || c === "(") depth += 1;
    else if (c === "]" || c === "}" || c === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/** The identifiers and nested-array spreads an entity-list expression is built from. */
function entityListMembers(text: string, identifier: string): string[] | null {
  const decl = new RegExp(`\\b(?:const|let)\\s+${identifier}\\b[^=]*=\\s*`).exec(text);
  if (decl === null) return null;
  const at = decl.index + decl[0].length;
  const ch = text[at];
  if (ch === "[") {
    const body = span(text, at);
    return body === null ? null : [...body.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1] ?? "");
  }
  // `withModules(RAW, MAP)` and friends: the array is the call's first argument.
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(at));
  if (call === null) return null;
  const argsAt = at + call[0].length - 1;
  const args = span(text, argsAt);
  if (args === null) return null;
  const firstIdent = /^\(\s*([A-Z][A-Z0-9_]*)\b/.exec(args);
  return firstIdent === null ? null : [firstIdent[1] ?? ""];
}

function parseEntities(
  slug: string,
  packFile: PackSourceFile,
  list: readonly PackSourceFile[],
  defects: ScanDefect[],
): readonly string[] {
  const nameByConst = new Map<string, string>();
  for (const { text } of list) {
    for (const m of text.matchAll(/\b(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*:\s*Entity\s*=\s*\{/g)) {
      const body = span(text, m.index + m[0].length - 1);
      const name = body === null ? null : /\bname:\s*"([A-Z][A-Za-z0-9]*)"/.exec(body);
      if (name !== null) nameByConst.set(m[1] ?? "", name[1] ?? "");
    }
  }
  const root = /\bentities:\s*\[\s*\.\.\.\s*([A-Z][A-Z0-9_]*)\b/.exec(packFile.text);
  if (root === null) {
    defects.push({
      kind: "pack_unresolved",
      pack: slug,
      detail: "src/pack.ts has no `entities: [...IDENT]` to resolve the entity list from",
    });
    return [];
  }
  const all = list.map((f) => f.text).join("\n");
  const reached = new Set<string>();
  const seen = new Set<string>();
  const queue = [root[1] ?? ""];
  while (queue.length > 0) {
    const identifier = queue.pop() ?? "";
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    if (nameByConst.has(identifier)) {
      reached.add(identifier);
      continue;
    }
    const members = entityListMembers(all, identifier);
    if (members === null) {
      defects.push({
        kind: "pack_unresolved",
        pack: slug,
        detail: `the entity list '${identifier}' is neither an array literal nor a call over one`,
      });
      continue;
    }
    for (const member of members) queue.push(member);
  }
  for (const identifier of nameByConst.keys()) {
    if (!reached.has(identifier)) {
      defects.push({
        kind: "entity_unreferenced",
        pack: slug,
        detail: `${identifier} is declared as an Entity and the pack's entity list does not reach it, so its three event names would be counted as producible by a manifest that has no such entity`,
      });
    }
  }
  return [...reached].map((c) => nameByConst.get(c) ?? "").sort();
}

function parseLifecycles(
  slug: string,
  list: readonly PackSourceFile[],
  defects: ScanDefect[],
): readonly LifecycleFacts[] {
  const byConst = new Map<string, { entity: string; targets: readonly string[] }>();
  for (const { text } of list) {
    for (const m of text.matchAll(
      /\b(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*:\s*EntityLifecycleWorkflow\s*=\s*\{/g,
    )) {
      const body = span(text, m.index + m[0].length - 1);
      if (body === null) continue;
      const entity = /\bentity:\s*"([A-Z][A-Za-z0-9]*)"/.exec(body)?.[1];
      const at = body.indexOf("transitions:");
      const open = at < 0 ? -1 : body.indexOf("[", at);
      const transitions = open < 0 ? null : span(body, open);
      if (entity === undefined || transitions === null) continue;
      byConst.set(m[1] ?? "", { entity, targets: transitionTargets(transitions) });
    }
    // `lifecycle(entity, stateField, initialState, states, terminals, transitions)`: the entity is
    // the first string argument and the transitions are the only array of *objects*.
    for (const m of text.matchAll(/\b(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*=\s*lifecycle\s*\(/g)) {
      const args = span(text, m.index + m[0].length - 1);
      if (args === null) continue;
      const entity = /^\(\s*"([A-Z][A-Za-z0-9]*)"/.exec(args)?.[1];
      const transitions = objectArrayArgument(args);
      if (entity === undefined || transitions === null) continue;
      byConst.set(m[1] ?? "", { entity, targets: transitionTargets(transitions) });
    }
  }

  const out: LifecycleFacts[] = [];
  const keyed = new Map<string, string>();
  for (const { text } of list) {
    for (const m of text.matchAll(
      /\b(?:const|let)\s+[A-Z][A-Z0-9_]*\s*:\s*Readonly<Record<string,\s*Workflow>>\s*=\s*\{/g,
    )) {
      const body = span(text, m.index + m[0].length - 1);
      if (body === null) continue;
      for (const entry of body.matchAll(/([a-z][a-z0-9_]*)\s*:\s*([A-Z][A-Z0-9_]*)/g)) {
        const key = entry[1] ?? "";
        const constant = entry[2] ?? "";
        const prior = keyed.get(key);
        if (prior !== undefined && prior !== constant) {
          defects.push({
            kind: "workflow_key_ambiguous",
            pack: slug,
            detail: `'${key}' is mapped to both ${prior} and ${constant} in this pack, so which lifecycle the resolved manifest holds is a guess`,
          });
          continue;
        }
        keyed.set(key, constant);
        const lifecycle = byConst.get(constant);
        if (lifecycle === undefined) {
          // Only a `Workflow` map entry whose const is an entityLifecycle matters; an orchestration
          // or scheduled workflow is correctly absent from `byConst` and emits no entity event.
          if (/LIFECYCLE/.test(constant)) {
            defects.push({
              kind: "lifecycle_unparsed",
              pack: slug,
              detail: `the workflow key '${key}' names ${constant}, whose entity and transition targets the scan could not read — so its transition event names would be missing from the producible set`,
            });
          }
          continue;
        }
        out.push({ key, entity: lifecycle.entity, targets: [...lifecycle.targets] });
      }
    }
  }
  return out;
}

/** The `to:` values of a transition list, deduplicated in declaration order. */
function transitionTargets(transitions: string): readonly string[] {
  const seen = new Set<string>();
  for (const m of transitions.matchAll(/\bto:\s*"([^"]+)"/g)) seen.add(m[1] ?? "");
  return [...seen];
}

/** The first argument that is an array of object literals — `lifecycle()`'s transition list. */
function objectArrayArgument(args: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "[") continue;
    const body = span(args, i);
    if (body === null) continue;
    if (/^\[\s*\{/.test(body)) return body;
    i += body.length - 1;
  }
  return null;
}

const EVENT_TRIGGER_OCCURRENCE = /\b(?:eventName|afterEvent)\s*:\s*"|(?:\bevent|\bdelayed)\s*\(\s*"/g;

function parseJobs(
  slug: string,
  list: readonly PackSourceFile[],
  defects: ScanDefect[],
): readonly DeclaredEvent[] {
  const out: DeclaredEvent[] = [];
  for (const { file, text } of list) {
    const spans: { from: number; to: number }[] = [];
    const push = (from: number, body: string, id: string | undefined): void => {
      spans.push({ from, to: from + body.length });
      if (id === undefined) return;
      if (/\bdeprecated:\s*true/.test(body)) return;
      for (const kind of TRIGGER_KINDS) {
        const field = TRIGGER_NAME_FIELD[kind];
        // The literal trigger object, or the module-local `event(…)` / `delayed(…)` helper the
        // packs build a trigger with — both forms, because core writes one of each file.
        const hit = new RegExp(
          `kind:\\s*"${kind}"[\\s\\S]*?\\b${field}:\\s*"([^"]+)"|\\b${kind}\\s*\\(\\s*"([^"]+)"`,
        ).exec(body);
        const eventName = hit?.[1] ?? hit?.[2];
        if (eventName === undefined) continue;
        out.push({ jobId: id, eventName, triggerKind: kind });
        return;
      }
    };
    for (const m of text.matchAll(
      /\b(?:const|let)\s+[A-Z][A-Z0-9_]*\s*:\s*JobDeclaration\s*=\s*\{/g,
    )) {
      const at = m.index + m[0].length - 1;
      const body = span(text, at);
      if (body === null) continue;
      push(at, body, /\bid:\s*"([^"]+)"/.exec(body)?.[1]);
    }
    for (const m of text.matchAll(/\b(?:const|let)\s+[A-Z][A-Z0-9_]*\s*=\s*job\s*\(/g)) {
      const at = m.index + m[0].length - 1;
      const body = span(text, at);
      if (body === null) continue;
      push(at, body, /^\(\s*"([^"]+)"/.exec(body)?.[1]);
    }
    for (const m of text.matchAll(EVENT_TRIGGER_OCCURRENCE)) {
      const at = m.index;
      if (spans.some((s) => at >= s.from && at < s.to)) continue;
      defects.push({
        kind: "event_trigger_unattributed",
        pack: slug,
        detail: `${file} names an event trigger at offset ${at} that falls inside no parsed job declaration, so the job it addresses is outside this fence`,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------- resolve */

/** Merges one pack's lineage into the facts the audit reads. Exported for the same reason. */
export function resolvePack(
  source: PackSource,
  parsed: ReadonlyMap<string, PackSource>,
  defects: ScanDefect[],
): ResolvedPackFacts {
  const chain = lineage(source, parsed, defects, new Set());
  const entities = new Set<string>();
  /** Workflows merge by key, overlay last — `mergeContent`'s `mergeRecord`, which is why a pack that re-keys an inherited lifecycle takes its targets away. */
  const lifecycles = new Map<string, LifecycleFacts>();
  const jobs = new Map<string, DeclaredEvent>();
  for (const pack of chain) {
    for (const entity of pack.entities) entities.add(entity);
    for (const lifecycle of pack.lifecycles) lifecycles.set(lifecycle.key, lifecycle);
    for (const job of pack.declaredEvents) jobs.set(job.jobId, job);
  }
  const producible = new Set<string>();
  for (const entity of entities) {
    for (const verb of VERBS) producible.add(`${scanEventNameSegment(entity)}.${verb}`);
  }
  for (const lifecycle of lifecycles.values()) {
    for (const target of lifecycle.targets) {
      producible.add(
        `${scanEventNameSegment(lifecycle.entity)}.${scanEventNameSegment(target)}`,
      );
    }
  }
  return ResolvedPackFactsSchema.parse({
    pack: source.slug,
    entities: [...entities].sort(),
    lifecycles: [...lifecycles.values()],
    producibleEventNames: [...producible].sort(),
    declaredEvents: [...jobs.values()],
  });
}

/** The pack and its ancestors, parents first, so an overlay's merge order is the array's. */
function lineage(
  source: PackSource,
  parsed: ReadonlyMap<string, PackSource>,
  defects: ScanDefect[],
  visiting: ReadonlySet<string>,
): readonly PackSource[] {
  if (visiting.has(source.slug)) {
    defects.push({
      kind: "pack_unresolved",
      pack: source.slug,
      detail: "extends forms a cycle",
    });
    return [source];
  }
  const seen = new Set(visiting).add(source.slug);
  const out: PackSource[] = [];
  for (const parent of source.parents) {
    const resolved = parsed.get(parent);
    if (resolved === undefined) {
      defects.push({
        kind: "pack_unresolved",
        pack: source.slug,
        detail: `extends '${parent}', which no scanned pack declares`,
      });
      continue;
    }
    out.push(...lineage(resolved, parsed, defects, seen));
  }
  out.push(source);
  return out;
}
