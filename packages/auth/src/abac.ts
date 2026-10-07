import { ABAC_OUTCOMES, OPERATION_NAMES } from "./types.js";
import type {
  AbacDischarge,
  AbacOutcome,
  Operation,
  OperationName,
  PermissionMap,
  Principal,
} from "./types.js";

/**
 * Which outcomes admit the act, as a **total map** rather than a condition: a new outcome is a
 * compile error here instead of a member falling into whichever branch an `if`-chain ended on —
 * and the branch it would fall into is the one that allows.
 *
 * `deferred` is the member that proves the point. It arrived after the other three, and under an
 * `if (outcome === "satisfied" || outcome === "deferred")`-shaped condition it would have had to be
 * *added* to deny; here it had to be *written down* to be read at all, and `false` is the only
 * honest value: a record-bearing policy that was handed no record has decided nothing, so a caller
 * that does not re-ask with the record must refuse.
 */
export const ABAC_OUTCOME_ALLOWS: Readonly<Record<AbacOutcome, boolean>> = {
  satisfied: true,
  denied: false,
  undischargeable: false,
  deferred: false,
};

export interface AbacEvaluationInput {
  readonly policyKey: string;
  readonly principal: Principal;
  readonly entity: string;
  readonly operation: Operation;
  /** Present for a field-level grant, absent for an entity-level one. */
  readonly field?: string;
  /**
   * The stored record the act is about, when the call site has it in hand.
   *
   * **Absent means the call site could not supply one**, not that the record is empty — the same
   * distinction `Principal.abacAttributes`' `null` draws (ADR-0341), one level out. An evaluator
   * whose policy needs a record and is handed none answers `deferred`.
   */
  readonly record?: Readonly<Record<string, unknown>>;
}

export type AbacEvaluator = (input: AbacEvaluationInput) => AbacOutcome;

/**
 * One answer out of a batch, carrying the position of the question it answers.
 *
 * **For a correct implementation the index is pure redundancy, and that is its whole job.** The
 * correspondence between a question and its answer is otherwise unverifiable: a batch that returns
 * the right number of valid outcomes in the wrong order is a silent mis-authorization, and roughly
 * half of a permutation *allows* — no amount of checking the outcomes themselves can see it, because
 * every one of them is a legal answer to some question in the set. The realistic bug is not a
 * deliberate reordering but answers assembled out of a map keyed by policy key and returned in its
 * iteration order, which collapses duplicate keys and drops the question order entirely; echoing the
 * index turns exactly that into one named refusal of the whole batch.
 *
 * The indices must be **exactly ascending** — `answers[i].index === i` — rather than any permutation
 * the reader re-sorts. Re-sorting would repair an authorization answer whose order the implementation
 * did not intend, silently making a broken evaluator look correct; refusing says so.
 *
 * The residual, stated honestly: an implementation that permutes the *outcomes* while leaving the
 * indices ascending is still accepted, and nothing here can detect it. The echo catches the mistake
 * that reorders a whole list, not one that mislabels each element.
 */
export interface AbacBatchAnswer {
  readonly index: number;
  readonly outcome: AbacOutcome;
}

/**
 * The batch arm beside {@link AbacEvaluator}: one call for a set of questions whose answers are all
 * needed before any of them is acted on.
 *
 * **Which of the five readers batch, and the reasons differ:**
 * - `rbacCheck` — one obligation per call. There is nothing to group it with, so `RbacCheckInput`
 *   gains no batch field.
 * - `computeFieldRedaction` — callerless and superseded by the classified pair, so an arm here would
 *   equip dead code and leave the two read paths with different costs.
 * - `computeClassifiedFieldRedaction` / `…ForRecords` — **batches.** Every obligated field is
 *   decided, so the whole question set is known before any answer is needed, and a page of records
 *   multiplies it by the record count.
 * - `validateWriteMask` / `validateClassifiedWriteMask` — **must not.** First refusal wins, so a
 *   batch would evaluate fields past the rejection: more work, and it hands the deployment's policy
 *   layer questions whose answers were never needed. That is ADR-0340's reason `rbacCheck` consults
 *   the evaluator only after the role check passes, one position over.
 *
 * This is **prose and deliberately not a total map.** `ABAC_OUTCOME_ALLOWS` is a map because a new
 * enum *member* must be a compile error; these five are hand-written functions, and a map over them
 * could not make a sixth reader a compile error — it would be a constant nobody reads.
 */
export type AbacBatchEvaluator = (
  inputs: readonly AbacEvaluationInput[],
) => readonly AbacBatchAnswer[];

/**
 * One question in a batch. The policy key is **required**, unlike `dischargeAbac`'s parameter:
 * "there is no obligation" is expressed by not making a request at all, so there is no `null` arm in
 * the result either.
 */
export interface AbacBatchRequest {
  readonly policyKey: string;
  readonly context: Omit<AbacEvaluationInput, "policyKey">;
}

/**
 * What a field-level caller supplies to have obligations enforced.
 *
 * `entity` is **required** inside the object: a caller cannot ask for enforcement without naming
 * the entity the policy is about, because an evaluation input with an empty entity hands the
 * deployment's policy layer a question it cannot answer and gets back an answer that means nothing.
 * The four field-level functions take `EntityPermissions` rather than an entity name, so this is
 * the only place that name can come from.
 */
export interface AbacEnforcement {
  readonly entity: string;
  readonly evaluator?: AbacEvaluator;
  /**
   * The optional batch arm, **a sibling of `evaluator` and never a replacement**: supplying this
   * without that one is a half-wired seam, and `dischargeAbacBatch` refuses rather than using it.
   * See that function's rule 2 for why.
   */
  readonly evaluateBatch?: AbacBatchEvaluator;
  /**
   * What the four field-level functions pass through to `AbacEvaluationInput.record`.
   *
   * Absent means **the caller had no record**, which is ordinary on two paths: the create path has
   * none to hold, and response redaction asks once with no record to learn whether any field's
   * policy needs one before it goes to the trouble of locating records. A record-bearing policy
   * then answers `deferred`, which `ABAC_OUTCOME_ALLOWS` refuses and
   * `FieldRedactionResult.deferred` reports per field, so the second pass happens exactly when it
   * would change an answer.
   */
  readonly record?: Readonly<Record<string, unknown>>;
}

/**
 * The evaluator a deployment that has declared no policy layer gets: every obligation is
 * undischargeable, so an ABAC-qualified grant refuses rather than granting unconditionally.
 */
export const UNDISCHARGEABLE_ABAC_EVALUATOR: AbacEvaluator = () => "undischargeable";

export function describeOperation(op: Operation): string {
  return typeof op === "object" ? `transition:${op.name}` : op;
}

function isAbacOutcome(value: unknown): value is AbacOutcome {
  return typeof value === "string" && (ABAC_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Whether an attribute directory was consulted for this principal. One spelling of the comparison,
 * so a caller can ask the question `dischargeAbac` asks without restating which value means which.
 */
export function abacAttributesResolved(principal: Principal): boolean {
  return principal.abacAttributes !== null;
}

/**
 * Whether a discharge is a **refusal pending a record** — the one spelling of the comparison, so no
 * caller restates which outcome means "ask again".
 *
 * A `deferred` discharge is already a refusal: `ABAC_OUTCOME_ALLOWS` maps it to `false`, so a caller
 * that ignores it denies. The only way to turn it into an allow is to load the record and ask again
 * with it supplied — never to read the outcome as a skip.
 */
export function isAbacDeferred(discharge: AbacDischarge | null | undefined): boolean {
  return discharge !== null && discharge !== undefined && discharge.outcome === "deferred";
}

/**
 * The one place in this package that ever calls an evaluator, with five callers — `rbacCheck` and
 * the four field-level functions — so the fail-closed rules below cannot diverge between them.
 *
 * `context.record` rides through the spread below with no code here reading it, deliberately:
 * **only the evaluator knows whether a given policy key needs a record.** A record-absence refusal
 * here would reject every obligation at every position `ABAC_RECORD_AVAILABILITY` does not answer
 * `always` for, and every first pass at one that it does — including the ones whose policy is a
 * predicate over the principal's own attributes and never wanted a record at all. That is the
 * opposite mistake from the
 * `abacAttributes === null` arm, where the input is one the seam *always* claims to carry and so a
 * missing value is unambiguously a gap.
 */
export function dischargeAbac(
  policyKey: string | undefined,
  context: Omit<AbacEvaluationInput, "policyKey">,
  evaluator: AbacEvaluator | undefined,
): AbacDischarge | null {
  // No obligation. `null` rather than a `satisfied` discharge, because "there was nothing to check"
  // and "a policy answered yes" are different facts, and a caller reporting the second when the
  // first is true would claim an evaluation that never happened.
  if (policyKey === undefined) return null;

  // Attributes were never gathered, so no policy over them can be answered — and an evaluator handed
  // `{}` would read it as "this principal has no attributes" and could answer `denied` or even
  // `satisfied` from an input nobody collected.
  if (context.principal.abacAttributes === null) return { policyKey, outcome: "undischargeable" };

  // `undischargeable` and not `denied`: `denied` is a claim about this principal's attributes,
  // while this says no evaluator could answer at all. Different facts, different remedies.
  if (evaluator === undefined) return { policyKey, outcome: "undischargeable" };

  let outcome: AbacOutcome;
  try {
    const answer: unknown = evaluator({ ...context, policyKey });
    // Validated rather than trusted: the evaluator crosses a package boundary and its caller may be
    // JS, so a value outside the enum is reachable — and an unrecognised answer must not allow.
    outcome = isAbacOutcome(answer) ? answer : "undischargeable";
  } catch {
    // An exception inside an authorization check must never become an allow, and must not propagate
    // as a 500 that a client retries into the same refusal.
    outcome = "undischargeable";
  }

  return { policyKey, outcome };
}

/**
 * Read a batch evaluator's answers, or refuse the whole batch.
 *
 * `null` means **refuse every question in the batch**, and the line between that and a single
 * `undischargeable` is whether positional correspondence survives: a length fault or a wrong index
 * means no answer can be shown to belong to its question, so trusting the ones that happen to line
 * up would be guessing which. An unreadable *outcome* on a correctly indexed answer is the opposite
 * case — the correspondence is intact and exactly one answer is unreadable, which is the granularity
 * the single path already has.
 */
function readBatchAnswers(
  batch: AbacBatchEvaluator,
  inputs: readonly AbacEvaluationInput[],
): readonly AbacOutcome[] | null {
  let answers: unknown;
  try {
    answers = batch(inputs);
  } catch {
    // Same rule as the single path: an exception inside an authorization check must not become an
    // allow, and must not propagate as a 500 a client retries into the same refusal.
    return null;
  }

  if (!Array.isArray(answers)) return null;
  const list: readonly unknown[] = answers;
  if (list.length !== inputs.length) return null;

  const outcomes: AbacOutcome[] = [];
  for (const [position, answer] of list.entries()) {
    if (typeof answer !== "object" || answer === null) return null;
    const fields = answer as Readonly<Record<string, unknown>>;
    if (typeof fields.index !== "number" || fields.index !== position) return null;
    outcomes.push(isAbacOutcome(fields.outcome) ? fields.outcome : "undischargeable");
  }

  return outcomes;
}

/**
 * Discharge several obligations at once, one discharge per request and **positionally aligned** to
 * `requests`.
 *
 * The order of the rules below is the whole contract:
 *
 * 1. **No requests → `[]`, and neither function is called.** A deployment's policy service must not
 *    be woken for nothing, and it is what keeps the length check in `readBatchAnswers`
 *    non-vacuous — two empty arrays line up trivially.
 * 2. **No `evaluator` → every discharge `undischargeable`, and `batch` is not called either.**
 *    `evaluateBatch` is a sibling of `evaluator`, never a replacement: three of the five readers that
 *    call an evaluator (`rbacCheck` and the two write masks) can only ever ask one question, so a
 *    seam carrying only a batch is half-wired — every entity-level obligation in that deployment
 *    would already be answering `undischargeable` — and the one reader that *could* use the batch
 *    refuses rather than enforcing a policy the rest of the deployment cannot.
 * 3. **A request whose principal's attributes were never resolved is `undischargeable` and is
 *    excluded from the set handed to the evaluator**, exactly as `dischargeAbac` refuses it before
 *    calling one (ADR-0341). So the array a batch evaluator receives holds only questions it could
 *    answer, and its length is the number of those — not of the requests.
 * 4. Every request excluded → return without calling anything.
 * 5. With `batch`, one call; without it, `dischargeAbac` per askable request, which is exactly
 *    today's behaviour and today's cost.
 *
 * Every discharge starts `undischargeable` and is only ever overwritten by an answer, so each of the
 * refusals above is the absence of a write rather than a branch that has to remember to deny.
 */
export function dischargeAbacBatch(
  requests: readonly AbacBatchRequest[],
  evaluator: AbacEvaluator | undefined,
  batch?: AbacBatchEvaluator,
): readonly AbacDischarge[] {
  const discharges: AbacDischarge[] = requests.map((request) => ({
    policyKey: request.policyKey,
    outcome: "undischargeable",
  }));
  if (discharges.length === 0) return discharges;
  if (evaluator === undefined) return discharges;

  const askable: { readonly position: number; readonly request: AbacBatchRequest }[] = [];
  for (const [position, request] of requests.entries()) {
    if (request.context.principal.abacAttributes === null) continue;
    askable.push({ position, request });
  }
  if (askable.length === 0) return discharges;

  if (batch === undefined) {
    for (const { position, request } of askable) {
      const discharge = dischargeAbac(request.policyKey, request.context, evaluator);
      if (discharge !== null) discharges[position] = discharge;
    }
    return discharges;
  }

  const inputs = askable.map(({ request }) => ({
    ...request.context,
    policyKey: request.policyKey,
  }));
  const outcomes = readBatchAnswers(batch, inputs);
  if (outcomes === null) return discharges;

  for (const [slot, { position, request }] of askable.entries()) {
    const outcome = outcomes[slot];
    if (outcome === undefined) continue;
    discharges[position] = { policyKey: request.policyKey, outcome };
  }

  return discharges;
}

export interface AbacObligation {
  readonly entity: string;
  readonly operation: Operation;
  readonly field: string | null;
  readonly policyKey: string;
}

/**
 * Every place a permission map carries an ABAC obligation, so a deployment can be told at boot
 * which grants its evaluator must answer for rather than discovering it at the first refusal.
 *
 * Deterministic: entities ascending, then the five operation names in `OPERATION_NAMES` order,
 * then transitions by name, then fields by name with `read` before `update`.
 */
export function surveyAbacObligations(permissions: PermissionMap): readonly AbacObligation[] {
  const out: AbacObligation[] = [];

  for (const entity of Object.keys(permissions).sort()) {
    const perms = permissions[entity];
    if (perms === undefined) continue;

    for (const op of OPERATION_NAMES) {
      const key = perms[op]?.abac;
      if (key !== undefined) out.push({ entity, operation: op, field: null, policyKey: key });
    }

    const transitions = perms.transitions;
    if (transitions !== undefined) {
      for (const name of Object.keys(transitions).sort()) {
        const key = transitions[name]?.abac;
        if (key !== undefined) {
          out.push({
            entity,
            operation: { kind: "transition", name },
            field: null,
            policyKey: key,
          });
        }
      }
    }

    const fields = perms.fields;
    if (fields !== undefined) {
      for (const name of Object.keys(fields).sort()) {
        const perm = fields[name];
        if (perm === undefined) continue;
        if (perm.read?.abac !== undefined) {
          out.push({ entity, operation: "read", field: name, policyKey: perm.read.abac });
        }
        if (perm.update?.abac !== undefined) {
          out.push({ entity, operation: "update", field: name, policyKey: perm.update.abac });
        }
      }
    }
  }

  return out;
}

export function formatAbacObligation(o: AbacObligation): string {
  const target =
    o.field === null
      ? `${o.entity}.${describeOperation(o.operation)}`
      : `${o.entity}.${describeOperation(o.operation)} -> ${o.field}`;
  return `${target} requires abac policy '${o.policyKey}'`;
}

/**
 * Every position a permission map can carry an obligation in, which is also every position whose
 * record availability differs. The two entity families are split by whether the grant sits on an
 * operation or on a field, because that is what decides which call site evaluates it.
 */
export const ABAC_GRANT_POSITIONS = [
  "entity_create",
  "entity_read",
  "entity_update",
  "entity_delete",
  "entity_list",
  "entity_transition",
  "field_read",
  "field_update",
] as const;

export type AbacGrantPosition = (typeof ABAC_GRANT_POSITIONS)[number];

export const ABAC_RECORD_AVAILABILITIES = ["always", "sometimes", "never"] as const;

export type AbacRecordAvailability = (typeof ABAC_RECORD_AVAILABILITIES)[number];

/**
 * Whether the call site that evaluates an obligation in each position can supply the record.
 *
 * **This is a contract, not an observation.** It is what lets a deployment be refused at boot for
 * declaring a record-bearing policy in a position where no record will ever arrive, rather than
 * discovering it as a `deferred` refusal on the first request — ADR-0334's conversion of a page-one
 * failure into a boot refusal, applied to an authorization input.
 *
 * `never` is not a limitation of the handler that could be fixed by loading more: in `entity_create`
 * the record does not exist, and in `entity_list` the subject is a set. `sometimes` belongs to
 * `field_update` alone, and the split inside it is the sharpest consequence — see
 * `ABAC_RECORD_AVAILABILITY_REASONS`.
 *
 * `field_read` and `entity_list` are the pair worth telling apart, because the two look alike from
 * here and are not: a **field read** policy filters *columns within a row*, which a response can
 * express per record, so redaction locates each record and answers for it. An **entity list**
 * policy would filter *rows*, which is a different operation — dropping rows from a page would make
 * its `nextCursor` and any count describe a set the caller was never shown.
 */
export const ABAC_RECORD_AVAILABILITY: Readonly<
  Record<AbacGrantPosition, AbacRecordAvailability>
> = {
  entity_create: "never",
  entity_read: "always",
  entity_update: "always",
  entity_delete: "always",
  entity_list: "never",
  entity_transition: "always",
  field_read: "always",
  field_update: "sometimes",
};

/**
 * Why each position answers as it does, as a sentence fragment a boot refusal can append.
 *
 * Each one says what supplies the record and when, or what structurally prevents it. A reason that
 * restated the position name would be worthless: these strings are the whole of what an operator is
 * told about a policy their deployment cannot answer.
 */
export const ABAC_RECORD_AVAILABILITY_REASONS: Readonly<Record<AbacGrantPosition, string>> = {
  entity_create:
    "a create has no stored record: the record the policy is about does not exist until the write commits",
  entity_read:
    "the read handler fetches the record by id before it returns, so it can be loaded and supplied before the decision",
  entity_update:
    "the update handler fetches the existing record before applying the patch, so the stored record is in hand before the decision",
  entity_delete:
    "the delete handler fetches the record before removing it, so the stored record is in hand before the decision",
  entity_list:
    "a list decides for a set of records, so a per-record answer is a filter and not an authorization decision",
  entity_transition:
    "a transition reads the record to check the state it is moving from, so the stored record is in hand before the decision",
  field_read:
    "response redaction locates the records a response carries from the operation's declared shape and computes the field set per record, so a per-field read policy is answered against the record the field came from",
  field_update:
    "the update path supplies the record and the create path cannot, so an obligated field is not settable at create",
};

function entityPosition(op: OperationName): AbacGrantPosition {
  switch (op) {
    case "list":
      return "entity_list";
    case "read":
      return "entity_read";
    case "create":
      return "entity_create";
    case "update":
      return "entity_update";
    case "delete":
      return "entity_delete";
  }
}

/**
 * Which position an obligation `surveyAbacObligations` produced came from.
 *
 * **Total, and never throwing.** A throw inside an authorization survey would turn an unmodelled
 * position into a crash at boot, and a `default` arm would hand a position nobody considered
 * whichever availability the arm happened to name — which, since `always` is the permissive answer
 * for a boot check, is the direction that admits.
 */
export function abacGrantPosition(obligation: AbacObligation): AbacGrantPosition {
  // A transition is the entity position whatever `field` holds: a transition grant lives on the
  // entity's `transitions` map and has no field arm at all, so a non-null field on one cannot have
  // come from a permission map and the act it names is still the transition.
  if (typeof obligation.operation === "object") return "entity_transition";
  if (obligation.field === null) return entityPosition(obligation.operation);

  switch (obligation.operation) {
    case "read":
      return "field_read";
    case "update":
      return "field_update";
    // `surveyAbacObligations` cannot emit these: a `FieldPermission` has only `read` and `update`
    // arms, so a field obligation on any other operation is not reachable from a permission map.
    // Written down anyway rather than thrown, because the mapping is decidable — the record would
    // have to come from the same place the entity-level act gets it — and a hand-built obligation
    // asking this question deserves an answer rather than an exception.
    case "create":
    case "delete":
    case "list":
      return entityPosition(obligation.operation);
  }
}

/** The availability for an obligation, so no caller composes the two maps itself. */
export function abacRecordAvailabilityFor(obligation: AbacObligation): AbacRecordAvailability {
  return ABAC_RECORD_AVAILABILITY[abacGrantPosition(obligation)];
}
