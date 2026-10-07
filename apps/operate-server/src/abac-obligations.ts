/**
 * The boot-time decision about ABAC-qualified grants.
 *
 * A manifest `RbacGrant` may carry `abac`, naming an attribute policy the grant is
 * conditional on. Nothing in this workspace ever evaluated one: `rbacCheck` handed
 * `requiresAbac` back and no caller read it, and all four field-level functions in
 * `@crossengin/auth` read `rule.roles` and ignored `rule.abac`. So an ABAC-qualified grant
 * granted **unconditionally** — the inverse of this repo's fail-closed invariant, and in the
 * one place a manifest author wrote down a condition.
 *
 * `@crossengin/auth` fails closed now: with no `AbacEvaluator` supplied — or with one that does
 * not hold this grant's policy key — the obligation resolves `undischargeable` and the grant is
 * denied. That closes the hole and converts it into a **silent total denial**, which is
 * ADR-0339's own finding — total redaction looks exactly like classification working, so a
 * deployment serving a manifest whose declared obligations it denies at every request reads as
 * healthy until somebody asks why a role with a grant cannot use it.
 *
 * So the deployment refuses at boot, naming what it cannot evaluate. That is ADR-0334's
 * conversion for an unservable `duration` field (refused at plan time by name rather than
 * 500ing on page 1) and ADR-0338's for a missing column-encryption key (a boot refusal
 * naming the entities and fields). A failure that is certain at boot belongs at boot.
 *
 * This matters without a pack author in the loop: `ManifestSchema.permissions` *is*
 * `@crossengin/auth`'s `EntityPermissionsSchema`, so the AI Architect can author an `abac`
 * grant, a reviewer approves it reading a declaration the runtime discarded, and activation
 * serves it. The seven builtin packs declare none today, which is what makes this refusal
 * vacuous now and a forcing function later — `abac-obligations.test.ts` measures that.
 *
 * Not every consequence of a coherent declaration is a refusal, and the module answers on two
 * axes rather than one. `ABAC_RECORD_AVAILABILITY` says whether a position can be *asked*, and
 * `ABAC_DENIAL_EFFECT` says what a denial there *does* — refuse the request, withhold a field,
 * or filter the row out of the page. A position that can be asked and whose denial filters rows
 * is not a configuration error; it is a list that behaves differently, and the author is **told**
 * rather than refused.
 *
 * Two things *are* still refused on that path, and both are about the same artefact: the keyset
 * cursor, which is `base64url(JSON.stringify({k: [...sort values], id}))` derived from the last
 * row of the **store's** slice — under row filtering, a row the caller was never shown. A list
 * whose *default* sort addresses a classified field is refused because no caller can opt out of a
 * sort the manifest chose; and a row-filtering list on a deployment that neither seals the cursor
 * nor accepted its disclosure is refused because the cursor discloses the withheld rows'
 * positions whatever the sort is. The second is the only refusal here with an escape hatch, for
 * the reason given on `ABAC_OBLIGATION_REFUSALS`.
 */

import { resolvedFields, type Manifest } from "@crossengin/kernel";
import {
  abacGrantPosition,
  abacRecordAvailabilityFor,
  formatAbacObligation,
  surveyAbacObligations,
  ABAC_DENIAL_EFFECT,
  ABAC_DENIAL_EFFECT_DESCRIPTIONS,
  ABAC_RECORD_AVAILABILITY_REASONS,
  type AbacObligation,
} from "@crossengin/auth";
import { listConfigForEntity } from "@crossengin/operate-runtime";
import { entityClassifiedFields, type DataClassification } from "@crossengin/types/meta-schema";

import { ABAC_POLICY_FLAG } from "./abac-policy.js";
import {
  ALLOW_CURSOR_DISCLOSURE_FLAG,
  CURSOR_ENCRYPTION_SECRET_VAR,
  type CursorSealingMode,
} from "./cursor-encryption.js";

/**
 * Four of these five have deliberately no escape-hatch flag, and the fifth has one deliberately,
 * and the line between them is ADR-0340's. That ADR refused a flag because serving a grant with
 * its qualifier removed is the *opposite* of what the manifest declares: an unevaluated
 * obligation is not a degraded state an operator may knowingly accept, it is the hole, so a flag
 * would be an option to serve it on purpose. `record_unavailable` is the same fact at a position,
 * and `list_sort_addresses_withheld_field` needs no flag for a stronger reason still — every
 * remedy for it is a one-line manifest edit the refusal names, so a flag would buy nothing but
 * the leak.
 *
 * `cursor_discloses_withheld_rows` is ADR-0338's `--allow-plaintext-phi` shape instead, and it
 * earns the hatch by being **degraded but coherent**: the policy is evaluated, the denied rows
 * are withheld from the page, and what escapes is only their *position* — the sort values and
 * id the keyset cursor is derived from. An operator whose ids are opaque and whose sort key is
 * uninteresting may knowingly accept that, exactly as one may knowingly accept plaintext PHI on
 * a store that cannot encrypt. So the flag mirrors that one, including being named in the
 * refusal: a refusal that hides its own opt-out is a refusal an operator works around by
 * weakening the manifest instead.
 */
export const ABAC_OBLIGATION_REFUSALS = [
  "obligation_unevaluable",
  "policy_undeclared",
  "record_unavailable",
  "list_sort_addresses_withheld_field",
  "cursor_discloses_withheld_rows",
] as const;
export type AbacObligationRefusal = (typeof ABAC_OBLIGATION_REFUSALS)[number];

/** Entity+field pairs printed before the line truncates. */
export const OBLIGATION_DETAIL_LIMIT = 8;

/**
 * One list view whose **default** sort addresses a classified field of an entity whose rows the
 * same page may withhold.
 *
 * `entity` and `field` are both required because the remedy is a manifest edit to *that view*, and
 * a finding naming only the policy key would send an operator to the grant when the thing to change
 * is the `sort`. `classification` is carried because it is what makes the field addressable-but-
 * unreadable, and `policyKey` because removing the obligation is the other remedy.
 *
 * No field **value** appears here or in anything rendered from it — the same line
 * `sensitive-field-policy.ts` draws, and for the same reason: these are the fields whose whole
 * purpose is that their values are not disclosed, and a boot log is a disclosure.
 */
export interface ListSortConflict {
  readonly entity: string;
  readonly field: string;
  readonly classification: DataClassification;
  readonly policyKey: string;
}

export interface AbacObligationCheckInput {
  readonly manifest: Manifest;
  /**
   * The policy keys the deployment's evaluator can answer. Empty = no evaluator declared.
   *
   * The set rather than a `boolean`, because "an evaluator exists" was never the right
   * question. A declared-but-incomplete evaluator answers `undischargeable` at request time
   * for exactly the keys it does not hold, which is the same silent total denial — per grant
   * instead of per deployment — that this boot refusal exists to prevent. "Can it answer
   * *this* grant" is the question, and only the key set can be asked it.
   */
  readonly answerableKeys: ReadonlySet<string>;
  /**
   * The subset of those keys whose policy compares against a **field of the record** — the half
   * ADR-0341's Q1 left inexpressible and this increment closes.
   *
   * Required rather than optional, and the reason is the direction of the mistake: a caller that
   * forgot it would compute an empty set, find no record-bearing obligation anywhere and refuse
   * nothing, so a manifest putting a record policy on a `create` would boot and deny that grant at
   * every request — the silent total denial this whole module exists to convert into a boot
   * refusal. An optional field can be forgotten with the type still valid (ADR-0330's rule), so
   * the compiler asks instead.
   *
   * In a correct deployment it is a subset of `answerableKeys`: a key the evaluator cannot answer
   * is reported by `policy_undeclared`, which is checked first.
   */
  readonly recordBearingKeys: ReadonlySet<string>;
  /**
   * Whether this deployment seals the entity-list keyset cursor, accepts its disclosure
   * knowingly, or has neither.
   *
   * Required rather than optional, for `recordBearingKeys`' reason. There is no safe default: an
   * optional field would have to default to one of the three, and the only one that refuses
   * nothing is `sealed` — so a caller who forgot it would assert sealing this deployment does not
   * do, and a manifest whose `list` grant withholds rows would boot handing every caller the
   * positions of the rows it withheld. That is the silent degradation this module exists to
   * convert into a boot refusal, so the compiler asks instead (ADR-0330's rule: an optional field
   * can be forgotten with the type still valid).
   */
  readonly cursorSealing: CursorSealingMode;
}

export interface AbacObligationCheck {
  readonly obligations: readonly AbacObligation[];
  readonly evaluatorDeclared: boolean;
  /**
   * The obligations an evaluator **is** declared for and cannot answer. Empty when no
   * evaluator is declared: with none, there is no per-key gap to report — every obligation is
   * unanswerable for one reason, which `obligation_unevaluable` states once. Reporting both
   * would name a remedy (declare these keys) beside one that supersedes it (declare a policy
   * layer at all).
   */
  readonly unanswerable: readonly AbacObligation[];
  /**
   * Record-bearing obligations at a position where no call site can **ever** supply a record.
   *
   * **Entity `create` is the only member position**, and it is the only one that can be: the record
   * the policy is about does not exist until the write commits, so there is nothing to load and no
   * later stage to load it in. Every such obligation would be denied at every request.
   *
   * This set held three positions and now holds one, and both departures were the same mistake
   * read twice — a limitation of the *stage* mistaken for a limitation of the *question*. Field
   * `read` left when response redaction was given the operation's declared record shape, so it
   * locates the records a response carries and computes the field set per record (ADR-0343). Entity
   * `list` left when a denial there stopped meaning "refuse the request" and started meaning "drop
   * the row": the list handler loads the page before it returns, so every row was in hand all
   * along, and what separates `list` from `field_read` is not availability but
   * `ABAC_DENIAL_EFFECT` — a field policy withholds columns within a row, a list policy withholds
   * whole rows. Reading that as an availability difference is what kept both refused at boot for
   * longer than the facts warranted. See `rowFiltered`, which is where entity `list` went.
   */
  readonly recordUnavailable: readonly AbacObligation[];
  /**
   * Record-bearing obligations on a per-field `update` grant, where the availability is
   * `sometimes`: the update path loads the record and the create path has none, so the field is
   * not settable at create.
   *
   * Reported and **not refused**, because unlike `recordUnavailable` this is a real consequence of
   * a coherent declaration rather than a configuration error — "you may only set this field on a
   * record that is yours" genuinely cannot admit a create. So the boot line says it and the
   * deployment starts (ADR-0322's rule: a surface that degrades rather than refusing has to say so
   * out loud).
   */
  readonly createBlocked: readonly AbacObligation[];
  /**
   * Record-bearing obligations whose position's `ABAC_DENIAL_EFFECT` is `filters_rows` — today the
   * entity `list` grant, and read off that map rather than compared against the position name, so
   * the position and its effect keep one definition and this set cannot disagree with the map the
   * list handler enforces.
   *
   * Reported and **not refused**, for `createBlocked`'s reason: a denial that drops a row is a
   * coherent answer and not a misconfiguration. But it needs its own sentence, because the
   * consequences are not ones a manifest author would guess from the declaration — a page shorter
   * than `limit`, a count route that refuses, and a classified field that can no longer be named in
   * `?sort`/`?filter`/`?q`. `rowFilteredNote` is where those three are said.
   */
  readonly rowFiltered: readonly AbacObligation[];
  /**
   * The list views whose **default** sort addresses a classified field of an entity in
   * `rowFiltered`. Non-empty is the `list_sort_addresses_withheld_field` refusal.
   */
  readonly listSortConflicts: readonly ListSortConflict[];
  /**
   * The `rowFiltered` obligations whose withheld rows a reversible cursor would disclose — so
   * `rowFiltered` itself when the deployment seals nothing and nothing was accepted, and empty
   * otherwise. Non-empty is the `cursor_discloses_withheld_rows` refusal.
   *
   * A set rather than a boolean beside `rowFiltered`, because the refusal names the grants an
   * operator has to look at, and because a caller catching the error should not have to re-apply
   * the sealing condition to work out which of the reported obligations the cursor reaches.
   */
  readonly cursorDisclosing: readonly AbacObligation[];
  /** Echoed from the input, so one `AbacObligationCheck` is enough to render the boot line. */
  readonly cursorSealing: CursorSealingMode;
  readonly refusal: AbacObligationRefusal | null;
}

/**
 * The classified fields of one manifest entity, keyed by field name.
 *
 * Asked over the **resolved** field list rather than `entity.fields`, so a classified field a
 * trait contributes is in scope — `sensitive-field-policy.ts` synthesises the entity the same way,
 * and for the same reason: the kernel resolves which fields exist and `entityClassifiedFields`
 * says which of them are classified, so neither rule is spelled a second time here.
 *
 * An entity a permission map names and the manifest does not declare answers empty rather than
 * throwing. That is the conservative direction for a *refusal*: an entity with no declared fields
 * has no declared sort either, so there is nothing a cursor could carry.
 */
function classifiedFieldsOf(
  manifest: Manifest,
  entityName: string,
): ReadonlyMap<string, DataClassification> {
  const entity = (manifest.entities ?? []).find((e) => e.name === entityName);
  if (entity === undefined) return new Map();
  const resolved = resolvedFields(entity, manifest.traits ?? []);
  return new Map(
    entityClassifiedFields({ ...entity, fields: [...resolved] }).map((c) => [
      c.field,
      c.classification,
    ]),
  );
}

/**
 * The list views whose default sort addresses a field the same page may withhold.
 *
 * Driven from `rowFiltered` rather than from the manifest's views, so the question asked is
 * "which of the entities whose rows are filtered sorts by a classified field" and not the reverse
 * — a view over an entity with no record-bearing `list` obligation withholds nothing and its sort
 * is nobody's problem.
 *
 * `listConfigForEntity` is the same function the list handler derives its sort from, so this reads
 * the sort that will actually be applied (including the view's declared direction and the
 * no-matching-view case, which is an empty sort and therefore never a conflict) rather than
 * re-deriving one from `manifest.views`.
 */
function listSortConflicts(
  manifest: Manifest,
  rowFiltered: readonly AbacObligation[],
): readonly ListSortConflict[] {
  const out: ListSortConflict[] = [];
  const seen = new Set<string>();
  for (const obligation of rowFiltered) {
    const classified = classifiedFieldsOf(manifest, obligation.entity);
    if (classified.size === 0) continue;
    for (const sort of listConfigForEntity(manifest, obligation.entity).defaultSort) {
      const classification = classified.get(sort.field);
      if (classification === undefined) continue;
      const key = `${obligation.entity}\u0000${sort.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        entity: obligation.entity,
        field: sort.field,
        classification,
        policyKey: obligation.policyKey,
      });
    }
  }
  return out;
}

/**
 * Surveys the manifest's declared obligations and answers whether the server may start.
 *
 * The manifest is already resolved — `loadBuiltinPack` follows `meta.extends` through
 * `resolveManifest` before anything here sees it — so a pack extending another is surveyed
 * over its merged lineage and an inherited `abac` grant is in scope.
 */
export function checkAbacObligations(input: AbacObligationCheckInput): AbacObligationCheck {
  const obligations = surveyAbacObligations(input.manifest.permissions ?? {});
  const evaluatorDeclared = input.answerableKeys.size > 0;
  const unanswerable = evaluatorDeclared
    ? obligations.filter((o) => !input.answerableKeys.has(o.policyKey))
    : [];

  // Both axes are read off `@crossengin/auth`'s total maps rather than re-listed here, so the
  // positions a record can reach, what a denial there does, and the handlers that implement both
  // have one definition apiece. In particular `rowFiltered` tests the **effect** and never the
  // position name: comparing against `"entity_list"` would be a second copy of `ABAC_DENIAL_EFFECT`
  // that a change to the map could not reach, and the two could then disagree about which grants
  // filter rows — the shape of hand-maintained list this repo has found wrong four times.
  const recordBearing = obligations.filter((o) => input.recordBearingKeys.has(o.policyKey));
  const recordUnavailable = recordBearing.filter((o) => abacRecordAvailabilityFor(o) === "never");
  const createBlocked = recordBearing.filter((o) => abacRecordAvailabilityFor(o) === "sometimes");
  const rowFiltered = recordBearing.filter(
    (o) => ABAC_DENIAL_EFFECT[abacGrantPosition(o)] === "filters_rows",
  );
  const conflicts = listSortConflicts(input.manifest, rowFiltered);
  // A reversible cursor is only a disclosure where something is withheld, so this is
  // `rowFiltered` gated on the mode and never the mode alone: a deployment that seals nothing and
  // withholds nothing has nothing to disclose, which is every deployment serving a manifest with
  // no record-bearing `list` grant.
  const cursorDisclosing = input.cursorSealing === "absent" ? rowFiltered : [];

  // First refusal wins, and the order is chosen so the one reported is the one whose remedy is
  // true (ADR-0340's ordering argument). With no evaluator, `recordBearingKeys` is empty by
  // construction, so nothing could be classified record-bearing and the last three would be
  // vacuously silent — hence they come after both questions that do not need the declaration.
  // `list_sort_addresses_withheld_field` and `cursor_discloses_withheld_rows` are last of all for
  // the same reason one notch further in: both are computed from `rowFiltered`, a subset of the
  // record-bearing set, so neither can fire unless `record_unavailable` has had its chance.
  //
  // And the cursor refusal comes after the sort one rather than before it, which is not merely
  // the order they were written in: **sealing does not rescue a classified default sort.** Per
  // `listSortMessage`, the list handler's own addressing guard sees the manifest's default sort
  // and refuses every list request on that entity before a cursor is ever minted, so a deployment
  // that answered the cursor refusal by setting a secret would find the entity still unservable
  // and the remedy it was given still owed. The reverse is not true — fixing the sort leaves the
  // cursor refusal standing for every other row-filtered entity, which is then reported.
  let refusal: AbacObligationRefusal | null = null;
  if (obligations.length > 0) {
    if (!evaluatorDeclared) refusal = "obligation_unevaluable";
    else if (unanswerable.length > 0) refusal = "policy_undeclared";
    else if (recordUnavailable.length > 0) refusal = "record_unavailable";
    else if (conflicts.length > 0) refusal = "list_sort_addresses_withheld_field";
    else if (cursorDisclosing.length > 0) refusal = "cursor_discloses_withheld_rows";
  }

  return {
    obligations,
    evaluatorDeclared,
    unanswerable,
    recordUnavailable,
    createBlocked,
    rowFiltered,
    listSortConflicts: conflicts,
    cursorDisclosing,
    cursorSealing: input.cursorSealing,
    refusal,
  };
}

/**
 * `a, b, c (+N more)` over `formatAbacObligation`. The count is reported separately by every
 * caller, so a truncated list never stands in for the figure an operator compares.
 */
function renderObligations(obligations: readonly AbacObligation[]): string {
  const shown = obligations.slice(0, OBLIGATION_DETAIL_LIMIT).map(formatAbacObligation);
  const hidden = obligations.length - shown.length;
  const suffix = hidden > 0 ? ` (+${hidden.toString()} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

/**
 * The no-evaluator text. Both remedies are named, and the second is worded as a capability
 * rather than a flag because there is no flag — supplying an evaluator is a change to what this
 * deployment can do.
 */
function unevaluableMessage(obligations: readonly AbacObligation[]): string {
  return (
    `${obligations.length.toString()} abac-qualified grant(s) are declared and this ` +
    `deployment has no ABAC evaluator, so each would be denied at every request rather ` +
    `than evaluated: ${renderObligations(obligations)}. Remove the \`abac\` key from the ` +
    `grant — the role grant beside it is enforced and stays — or give the deployment an ` +
    `ABAC evaluator, a capability it does not currently have.`
  );
}

/**
 * The other refusal's text. This one **does** name a flag where `unevaluableMessage` refuses to,
 * and the asymmetry is the point: declaring a policy for a key is something the CLI can do, while
 * supplying an evaluator is a capability no flag confers. A message naming a remedy that does not
 * exist is worse than one naming none.
 */
function undeclaredMessage(unanswerable: readonly AbacObligation[]): string {
  const keys = [...new Set(unanswerable.map((o) => o.policyKey))].sort();
  return (
    `${unanswerable.length.toString()} abac-qualified grant(s) name a policy key this ` +
    `deployment's ABAC evaluator cannot answer, so each would be denied at every request ` +
    `rather than evaluated: ${renderObligations(unanswerable)}. Declare a policy for ` +
    `${keys.map((k) => `'${k}'`).join(", ")} with ${ABAC_POLICY_FLAG}, or remove the \`abac\` ` +
    `key from the grant — the role grant beside it is enforced and stays.`
  );
}

/**
 * `Chart.create requires abac policy 'same_dept' — ⟨what supplies the record, or what prevents
 * it⟩`, one per line.
 *
 * The reason is attached **per obligation** and comes from `ABAC_RECORD_AVAILABILITY_REASONS`
 * rather than being written here, so the position's reason and the handler that enforces it have
 * one definition. Repeating a reason across two obligations at the same position is accepted: an
 * operator reads the line for the grant they are fixing, and grouping would make a truncated list
 * ambiguous about which reason belonged to which grant.
 */
function renderWithReason(obligations: readonly AbacObligation[]): string {
  const shown = obligations
    .slice(0, OBLIGATION_DETAIL_LIMIT)
    .map(
      (o) =>
        `${formatAbacObligation(o)} — ${ABAC_RECORD_AVAILABILITY_REASONS[abacGrantPosition(o)]}`,
    );
  const hidden = obligations.length - shown.length;
  const suffix = hidden > 0 ? `; (+${hidden.toString()} more)` : "";
  return `${shown.join("; ")}${suffix}`;
}

/**
 * The same shape over the **other** axis: what a denial at this obligation's position does to the
 * response, from `ABAC_DENIAL_EFFECT_DESCRIPTIONS`.
 *
 * Two renderers rather than one taking a map, because the two axes answer different questions and
 * a caller choosing a map would be choosing which question it is asking — which is exactly the
 * confusion that kept entity `list` in `recordUnavailable`. The descriptions are keyed per
 * **effect** rather than per position, so the composition here is the one place the two maps meet.
 */
function renderWithDenialEffect(obligations: readonly AbacObligation[]): string {
  const shown = obligations.slice(0, OBLIGATION_DETAIL_LIMIT).map((o) => {
    const effect = ABAC_DENIAL_EFFECT[abacGrantPosition(o)];
    return `${formatAbacObligation(o)} — ${ABAC_DENIAL_EFFECT_DESCRIPTIONS[effect]}`;
  });
  const hidden = obligations.length - shown.length;
  const suffix = hidden > 0 ? `; (+${hidden.toString()} more)` : "";
  return `${shown.join("; ")}${suffix}`;
}

/**
 * `Patient.family_name (pii) under abac policy 'same_facility'`, one per entry.
 *
 * The classification is named because it is what makes the field addressable-but-unreadable, and
 * the policy key because removing the obligation is the second remedy. The field's **value** never
 * appears: that is the whole of what this refusal is protecting.
 */
function renderConflicts(conflicts: readonly ListSortConflict[]): string {
  const shown = conflicts
    .slice(0, OBLIGATION_DETAIL_LIMIT)
    .map((c) => `${c.entity}.${c.field} (${c.classification}) under abac policy '${c.policyKey}'`);
  const hidden = conflicts.length - shown.length;
  const suffix = hidden > 0 ? ` (+${hidden.toString()} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

/**
 * The record-position refusal's text. Three remedies, in the order an operator would try them:
 * weaken the policy, move the obligation, or drop it. The first is named with the flag because the
 * CLI can do it; the second is a manifest edit and is described rather than flagged.
 *
 * The list of positions that *do* supply a record grew as the refusal shrank, and it is written out
 * rather than derived from `ABAC_RECORD_AVAILABILITY` deliberately: a derived list would also name
 * the `sometimes` position without saying that it is one, and "move it to a per-field `update`"
 * needs the caveat that a create still cannot satisfy it.
 */
function recordUnavailableMessage(recordUnavailable: readonly AbacObligation[]): string {
  return (
    `${recordUnavailable.length.toString()} abac-qualified grant(s) name a policy that compares ` +
    `against a field of the record, at a position where no call site can ever supply one, so each ` +
    `would be denied at every request rather than evaluated: ${renderWithReason(recordUnavailable)}. ` +
    `Declare that key as a comparison that does not reference the record ` +
    `(${ABAC_POLICY_FLAG} <key>=<attribute>:eq|ne|in|present[:<value>]), move the \`abac\` key to a ` +
    `grant that does supply a record (an entity \`read\`/\`update\`/\`delete\`/\`list\`, a ` +
    `transition, a per-field \`read\`, or a per-field \`update\` — which supplies one on update and ` +
    `still cannot at create), or remove it — the role grant beside it is enforced and stays.`
  );
}

/**
 * The default-sort refusal's text, and the one refusal on the row-filtering path.
 *
 * Why this is a **refusal** where `rowFiltered` beside it is only a report. The keyset cursor is
 * `base64url(JSON.stringify({k: [...sort values], id}))` — plainly reversible, not a token — and it
 * is derived from the **last row of the store's slice**, which under row filtering may be a row the
 * caller was never shown. So a classified default sort puts that field's value, for a withheld row,
 * into a string handed back on **every** list request. There is no per-request fix available: the
 * caller did not ask for that sort, the manifest did. A failure certain at boot belongs at boot
 * (ADR-0334's conversion, and the same shape as ADR-0338's missing-key refusal) rather than as a
 * 400 on page one, which here would not even be reachable — nothing about the request is wrong.
 *
 * An **explicit** `?sort` naming a classified field is a different case and deliberately not this
 * module's: the caller addressed the field, so the request carries the fault and the list handler
 * refuses it with a 400 at request time. This refusal exists precisely because the default sort is
 * the one a caller cannot decline.
 *
 * And measured against the handler as it stands, the symptom is sharper than the leak that
 * motivates it: `parseListQuery` falls back to `config.defaultSort` when the request names no
 * `?sort`, so the handler's own addressing guard sees the default sort and **refuses every list
 * request on that entity**, with nothing the caller can change. So the value does not in fact reach
 * a cursor today — the guard gets there first — and what this boot refusal converts is an entity
 * whose list route 400s unconditionally. The cursor argument is still the reason the guard has to
 * exist and the reason weakening it is not an option; the 400 is what an operator would actually
 * hit, and either way it is certain at boot and so belongs at boot.
 */
function listSortMessage(conflicts: readonly ListSortConflict[]): string {
  return (
    `${conflicts.length.toString()} list view(s) sort by default on a classified field of an ` +
    `entity whose \`list\` grant carries a record-bearing abac policy, so a row the caller was ` +
    `never shown can be the one whose value the keyset cursor carries back: ` +
    `${renderConflicts(conflicts)}. The cursor is ` +
    `base64url(JSON.stringify({k: [...sort values], id})) and is derived from the last row of the ` +
    `store's slice, which under row filtering may be a row the caller was not shown — and no ` +
    `caller can opt out, because the sort came from the manifest and not from the request. Change ` +
    `that view's \`sort\` to an unclassified field, drop the classification from the field, or ` +
    `remove the \`abac\` key from that entity's \`list\` grant — the role grant beside it is ` +
    `enforced and stays.`
  );
}

/**
 * The cursor refusal's text, and the second refusal on the row-filtering path.
 *
 * It names the cursor's **construction** rather than calling it "reversible", because the remedy
 * depends on believing the claim: an operator weighing `${ALLOW_CURSOR_DISCLOSURE_FLAG}` has to be
 * able to see for themselves that `base64url(JSON.stringify(…))` is an encoding and not a token,
 * and that the row it was derived from is one the filter removed.
 *
 * The `limit=1` sentence is the part that decides the grade. A disclosure of one withheld row's
 * sort values per page sounds marginal; the same disclosure under a caller-chosen `limit` of 1 is
 * an enumeration of the ids of every row the policy denied, one request at a time, which is a
 * different fact about the same mechanism and the one an operator needs before accepting it.
 *
 * Both remedies, in the order an operator would try them: the secret first, because it removes
 * the disclosure, and the flag second, because it accepts it. Naming the flag second rather than
 * not at all is the ADR-0338 shape — see `ABAC_OBLIGATION_REFUSALS`.
 */
function cursorDisclosureMessage(cursorDisclosing: readonly AbacObligation[]): string {
  return (
    `${cursorDisclosing.length.toString()} abac-qualified grant(s) filter rows out of a list ` +
    `page while this deployment's entity-list cursor is unsealed, so the cursor carries back the ` +
    `position of a row the caller was never shown: ${renderWithDenialEffect(cursorDisclosing)}. ` +
    `The cursor is base64url(JSON.stringify({k: [...sort values], id})) and is derived from the ` +
    `last row of the store's slice, which under row filtering may be a row the caller is never ` +
    `shown — so that row's sort values and its id travel back on every page, and at \`limit=1\` ` +
    `each page's cursor names exactly one withheld row, which is an enumeration of the ids the ` +
    `policy denied. Set ${CURSOR_ENCRYPTION_SECRET_VAR} so every entity-list cursor is sealed ` +
    `with a per-tenant key, or pass ${ALLOW_CURSOR_DISCLOSURE_FLAG} to accept the disclosure ` +
    `knowingly.`
  );
}

/**
 * The refusal detail, selected by refusal and shared by the boot line and the thrown error so the
 * two cannot disagree.
 */
function refusalMessage(check: AbacObligationCheck): string {
  if (check.refusal === "policy_undeclared") return undeclaredMessage(check.unanswerable);
  if (check.refusal === "record_unavailable") {
    return recordUnavailableMessage(check.recordUnavailable);
  }
  if (check.refusal === "list_sort_addresses_withheld_field") {
    return listSortMessage(check.listSortConflicts);
  }
  if (check.refusal === "cursor_discloses_withheld_rows") {
    return cursorDisclosureMessage(check.cursorDisclosing);
  }
  return unevaluableMessage(check.obligations);
}

/**
 * The `sometimes` note, appended to an otherwise healthy boot line. Said on every boot rather than
 * only when somebody asks, because an obligated field silently refusing every create is exactly
 * the shape of thing a deployment reads as the rule working.
 */
function createBlockedNote(createBlocked: readonly AbacObligation[]): string {
  return (
    `; ${createBlocked.length.toString()} obligated field(s) are therefore not settable at ` +
    `create: ${renderWithReason(createBlocked)}`
  );
}

/**
 * The `filters_rows` note, appended to an otherwise healthy boot line.
 *
 * A report and not a refusal — a denial that drops a row is a coherent answer — but it gets its own
 * sentence rather than riding along on the obligation list, because **none of its three
 * consequences is guessable from the declaration**, and all three are things a client integration
 * gets wrong silently:
 *
 *   1. A page comes back shorter than `limit` and may be empty while `nextCursor` is non-null, so
 *      the only end-of-pages signal is `nextCursor === null`. A client that stops on an empty
 *      `data` stops early and reads it as "no more records" rather than "none on this page".
 *   2. The association **count** route over that entity refuses, because a count answers for the
 *      whole set with one number and there is nothing to filter — a filtered count would be a
 *      figure about a set nobody can enumerate.
 *   3. `?sort`, `?filter` and `?q` naming a **classified** field on that entity are refused at
 *      request time, because a caller may not address rows by a field they may not read.
 *
 * Said on every boot rather than only when somebody asks, for `createBlockedNote`'s reason: a list
 * quietly serving fewer rows than it holds is exactly the shape of thing a deployment reads as the
 * rule working.
 */
function rowFilteredNote(rowFiltered: readonly AbacObligation[]): string {
  return (
    `; ${rowFiltered.length.toString()} entity list grant(s) therefore filter rows out of the ` +
    `page instead of refusing the request: ${renderWithDenialEffect(rowFiltered)}. Three ` +
    `consequences follow for every caller of those lists: a page comes back shorter than \`limit\` ` +
    `and may be empty while \`nextCursor\` is non-null, so only \`nextCursor === null\` means the ` +
    `end and a client that stops on an empty \`data\` stops early; the association count route ` +
    `over that entity refuses, because a count answers for the whole set with one number and there ` +
    `is nothing to filter; and \`?sort\`, \`?filter\` and \`?q\` naming a classified field on that ` +
    `entity are refused at request time, because a caller may not address rows by a field they may ` +
    `not read`
  );
}

/**
 * The accepted-disclosure note, appended to an otherwise healthy boot line.
 *
 * Said on every boot rather than once at the moment the flag was passed, which is
 * `createBlockedNote`'s and `rowFilteredNote`'s rule and ADR-0322's: a surface that degrades
 * rather than refusing has to say so out loud. The flag buys a boot, not silence — and this one
 * is a *standing* disclosure of every withheld row's position, so the deployment that accepted it
 * should meet the sentence again every time it starts, not only in the shell history of whoever
 * added the flag.
 */
function cursorPlaintextNote(rowFiltered: readonly AbacObligation[]): string {
  return (
    `; ${ALLOW_CURSOR_DISCLOSURE_FLAG} was given, so the keyset cursor of those ` +
    `${rowFiltered.length.toString()} list(s) stays reversible base64url JSON derived from the ` +
    `last row of the store's slice — a row the caller may never have been shown, whose sort ` +
    `values and id the cursor therefore discloses. Set ${CURSOR_ENCRYPTION_SECRET_VAR} to seal it`
  );
}

/**
 * One boot line. The no-obligations case says so **affirmatively**: "we surveyed and found
 * none" cannot be claimed from the absence of a log line, which is this repo's recurring
 * rule, and it is the line that makes the refusal's vacuity visible on every boot.
 */
export function formatAbacObligationCheck(check: AbacObligationCheck): string {
  if (check.obligations.length === 0) {
    return "abac obligations: none declared, so no grant depends on an ABAC evaluator";
  }
  if (check.refusal !== null) {
    return `abac obligations: ${refusalMessage(check)}`;
  }
  return (
    `abac obligations: ${check.obligations.length.toString()} declared and an evaluator is ` +
    `declared, so each is evaluated per request: ${renderObligations(check.obligations)}` +
    (check.createBlocked.length > 0 ? createBlockedNote(check.createBlocked) : "") +
    (check.rowFiltered.length > 0 ? rowFilteredNote(check.rowFiltered) : "") +
    (check.rowFiltered.length > 0 && check.cursorSealing === "plaintext_accepted"
      ? cursorPlaintextNote(check.rowFiltered)
      : "")
  );
}

/**
 * Thrown at boot for any of the refusals. Carries the obligations and each refusal's own subset so
 * a caller can report them structurally rather than re-deriving them from the message.
 *
 * One error for all of them rather than a class each: every one is the same fact narrowed — an
 * obligation this deployment cannot serve as declared — so `refusal` is what distinguishes them
 * and a caller catching one catches all.
 */
export class AbacObligationsUnevaluable extends Error {
  readonly refusal: AbacObligationRefusal;
  readonly obligations: readonly AbacObligation[];
  readonly unanswerable: readonly AbacObligation[];
  readonly recordUnavailable: readonly AbacObligation[];
  readonly listSortConflicts: readonly ListSortConflict[];
  readonly cursorDisclosing: readonly AbacObligation[];

  constructor(check: AbacObligationCheck) {
    super(refusalMessage(check));
    this.name = "AbacObligationsUnevaluable";
    // A check whose `refusal` the caller did not consult still names one, and it is the strictest
    // of them: `obligation_unevaluable` claims nothing about which keys are declared.
    this.refusal = check.refusal ?? "obligation_unevaluable";
    this.obligations = check.obligations;
    this.unanswerable = check.unanswerable;
    this.recordUnavailable = check.recordUnavailable;
    this.listSortConflicts = check.listSortConflicts;
    this.cursorDisclosing = check.cursorDisclosing;
  }
}
