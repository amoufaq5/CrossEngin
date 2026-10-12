/**
 * The boot-time decision about **sealing the entity-list keyset cursor**.
 *
 * This module is the deployment half of cursor sealing: where the key comes from, and what a
 * deployment is told — or refused — when it has the problem and no key. It performs no sealing
 * and no encryption. `buildCursorSealer` seals and opens; `@crossengin/crypto` derives the key
 * and holds the AEAD.
 *
 * What it exists to end is the residual of entity-list row filtering. A cursor is
 * `base64url(JSON.stringify({k: [...sort values], id}))` — plainly reversible, not a token — and
 * it is derived from the last row of the **store's** slice, which under row filtering may be a
 * row the caller is never shown. So the cursor discloses a withheld row's sort values and its
 * id, on every page, and at `limit=1` a caller can walk the whole table collecting the ids of
 * rows they were denied. Nothing about the request is wrong, so there is no request-time refusal
 * available and no per-request fix a caller could apply.
 *
 * **Sealing is uniform, not per entity.** When a secret is present every entity-list cursor is
 * sealed, including the cursors of entities with no row filtering at all. Three reasons, and the
 * first is the one that decides it: one format going forward beats a per-entity matrix, because
 * a cursor minted under one regime and presented under another is a value the deployment has to
 * be able to read either way, and a matrix makes that a per-entity question on every request. It
 * costs one AES-GCM operation per page, which is nothing beside the query it accompanies. And it
 * means cursors stop being a readable surface *at all*, rather than only where somebody
 * remembered to close them — the per-entity alternative is a hand-maintained set keyed on which
 * grants happen to carry a record-bearing policy today, which is the shape of list this repo has
 * found wrong four times.
 *
 * **And it answers a second question, for the case that is live today.** The residual above is
 * about a *withheld row's position*, and `checkAbacObligations` refuses on it — but only when a
 * grant filters rows, of which the measured count across the seven packs is **zero**, so that
 * refusal is vacuously silent on every shipped deployment. The disclosure that is not vacuous is
 * a *classified field's value*: `keysetOf` maps over the **whole declared sort** and renders
 * `String(row[field])`, so a caller naming a classified field in `?sort` is handed its plaintext
 * in the cursor of a response whose body redacted it. The redaction and the cursor are two code
 * paths and only the first consults the caller's grants. Measured: **14 (entity, sortable
 * classified field) pairs across the seven resolved packs, 8 distinct, and at least one in every
 * pack** — `Employee.work_email` (`pii`) rides in from `erp-core`, the compose default, and
 * healthcare adds `Patient.mrn`, the `phi` field ADR-0338 made `bytea` ciphertext at rest.
 *
 * The survey is deliberately **not narrowed by `--store`**, and that is a measurement rather than
 * an omission. On `--store pg-columns` an `encryptAtRest` column answers `columnExpr → null`, so
 * `?sort=mrn` is silently dropped from `ORDER BY` — which reads like an exemption and is the
 * opposite. `selectList` decrypts that column (`pgp_sym_decrypt(…) AS mrn`), `projectionColumns`
 * keeps it because the cursor needs it, and `keysetOf` reads the *record*, so the cursor carries
 * the decrypted plaintext while the ordering it claims to describe was never applied. That is
 * strictly worse than the JSONB store, where the component is at least a real position. So all
 * three stores disclose, and a store-narrowed survey would have dropped the one `phi` member — the
 * unsafe direction, from a plausible reading of one line.
 */

import { deriveTenantCursorKey, parseCursorEncryptionSecret } from "@crossengin/crypto";
import { resolvedClassifiedFields, type Manifest } from "@crossengin/kernel";
import {
  buildCursorSealer,
  listConfigForEntity,
  type CursorKeySource,
  type CursorSealer,
} from "@crossengin/operate-runtime";
import type { DataClassification } from "@crossengin/types/meta-schema";

/**
 * The deployment secret every tenant's cursor key is derived from.
 *
 * From the **environment and never from argv**: argv is readable via `ps` (ADR-0301), and
 * `COLUMN_ENCRYPTION_SECRET` is the immediate precedent — one deployment secret from which a
 * per-tenant key is derived, with nothing stored.
 *
 * A **separate** variable from the column secret rather than a second use of it. The two keys
 * protect different things with different lifetimes: a column key must stay derivable for as
 * long as the ciphertext is at rest, so rotating it is a data migration, while a cursor key
 * protects a value whose whole lifetime is one caller's pagination — rotating it invalidates
 * cursors in flight and nothing else. One variable would couple the cheap rotation to the
 * expensive one, in the direction that makes the cheap one unavailable.
 */
export const CURSOR_ENCRYPTION_SECRET_VAR = "CURSOR_ENCRYPTION_SECRET";

/**
 * The opt-out named in the refusal. A constant rather than a string literal per message, so the
 * refusal cannot name a flag the CLI does not parse.
 */
export const ALLOW_CURSOR_DISCLOSURE_FLAG = "--allow-cursor-disclosure";

export const CURSOR_SEALING_MODES = ["sealed", "plaintext_accepted", "absent"] as const;
export type CursorSealingMode = (typeof CURSOR_SEALING_MODES)[number];

/**
 * One line per mode. A **total map** rather than a switch, so a fourth mode is a compile error
 * instead of a mode inheriting whichever branch a chain ended on — and the direction that
 * matters is that an unconsidered mode must not be described as sealed.
 *
 * `absent` names the refusal it can produce, because the mode alone is not a fault: a deployment
 * whose manifest withholds no rows has nothing to *withhold*, and that is most of them. The
 * refusal is `checkAbacObligations`', which is the only place that knows whether any grant
 * filters rows.
 *
 * What that line used to go on to say — "and otherwise nothing is withheld for a cursor to
 * disclose" — was true of rows and **false of fields**, which is the whole of what
 * {@link decideCursorDisclosure} answers. Two boot lines contradicting each other is worse than
 * either, so this one now points at the second rather than claiming the absence.
 */
const MODE_DETAIL: Readonly<Record<CursorSealingMode, string>> = {
  sealed:
    `every entity-list cursor is sealed with a per-tenant key derived from ` +
    `${CURSOR_ENCRYPTION_SECRET_VAR}, including for entities whose rows are not filtered`,
  plaintext_accepted:
    `${CURSOR_ENCRYPTION_SECRET_VAR} is not set and ${ALLOW_CURSOR_DISCLOSURE_FLAG} was given, ` +
    `so every entity-list cursor stays reversible base64url JSON and a row withheld from a page ` +
    `can be the one whose sort values and id it carries back`,
  absent:
    `${CURSOR_ENCRYPTION_SECRET_VAR} is not set, so every entity-list cursor is reversible ` +
    `base64url JSON — refused at boot (cursor_discloses_withheld_rows) only if a grant filters ` +
    `rows out of a page, and otherwise reported per classified sortable field (see the cursor ` +
    `disclosure line)`,
};

/**
 * The per-tenant key source the sealer calls per page.
 *
 * The eager parse and the tenant-keyed cache are `buildColumnKeySource`'s, for exactly its
 * stated reasons: the secret is validated **once, before any closure is returned**, so a weak
 * secret fails at boot naming the measured figures rather than on the first page of a list; and
 * the cache is keyed on the tenant id alone because a generation is fixed for the life of one
 * source, so a rotation is a new source rather than an invalidation.
 *
 * The one thing that is not shared with that function is the consequence of a rotation, and it
 * is the gentler one: a new generation makes every cursor in flight unopenable, which is a
 * caller restarting its pagination. A column key's generations have to coexist because the
 * ciphertext they wrote is at rest.
 */
export function buildCursorKeySource(
  rawSecret: string,
  opts: { readonly generation?: number } = {},
): CursorKeySource {
  const secret = parseCursorEncryptionSecret(rawSecret);
  const generation = opts.generation;
  const cache = new Map<string, Uint8Array>();
  return (tenantId: string): Uint8Array => {
    const hit = cache.get(tenantId);
    if (hit !== undefined) return hit;
    // The derivation is loaded through the same package as the parser, so the two cannot
    // disagree about what an acceptable secret is; its refusal of an empty tenant id is allowed
    // to propagate rather than being turned into one shared key, which would seal every
    // tenant's cursors under a value any of them could open.
    const derived =
      generation === undefined
        ? deriveTenantCursorKey(secret, tenantId)
        : deriveTenantCursorKey(secret, tenantId, generation);
    cache.set(tenantId, derived);
    return derived;
  };
}

export interface CursorSealingResolution {
  readonly mode: CursorSealingMode;
  /** Present iff `mode` is `sealed`; the other two modes are today's plaintext cursor. */
  readonly sealer: CursorSealer | null;
}

/**
 * The three-way resolution: a secret, a knowing acceptance, or neither.
 *
 * **A secret wins over the flag, and the flag must not suppress sealing.** The flag *accepts* a
 * disclosure; it does not request one. A deployment that set a secret and also passed the flag —
 * a compose file carrying both through a migration, most likely — gets sealed cursors, because
 * reading the flag as "do not seal" would make the safe configuration defeatable by the thing an
 * operator passes while arranging it. That is ADR-0338's `PlaintextFallbackRefused` direction:
 * a silent downgrade from sealed to plaintext is the failure, not the upgrade.
 *
 * Presence is `trim().length > 0`, the spelling the column secret's reader already uses, so an
 * environment variable set to the empty string reads as unset rather than reaching the parser as
 * a nought-byte secret. The **untrimmed** string is what the derivation sees, since the bytes an
 * operator supplied are the secret.
 */
export function resolveCursorSealing(input: {
  readonly secret: string | null;
  readonly allowDisclosure: boolean;
}): CursorSealingResolution {
  const secret = input.secret;
  if (secret !== null && secret.trim().length > 0) {
    return { mode: "sealed", sealer: buildCursorSealer(buildCursorKeySource(secret)) };
  }
  return { mode: input.allowDisclosure ? "plaintext_accepted" : "absent", sealer: null };
}

/** The boot line. Carries the mode first, because that is what an operator greps for. */
export function formatCursorSealing(mode: CursorSealingMode): string {
  return `cursor sealing: ${mode} — ${MODE_DETAIL[mode]}`;
}

/**
 * How many `Entity.field` pairs a disclosure line names before it truncates.
 *
 * Its own constant rather than a shared figure, following `SENSITIVE_SURVEY_FIELD_LIMIT`'s note
 * on why it is not `column-encryption.ts`'s five: each line summarises a different population, so
 * one limit would truncate the longest to uselessness and pad the shortest. Eight, because the
 * measured per-deployment set is one to five and the across-packs set is fourteen.
 */
export const CURSOR_DISCLOSURE_FIELD_LIMIT = 8;

/**
 * One classified field a caller may name in `?sort`, and so one field whose plaintext an unsealed
 * keyset cursor carries back.
 *
 * `classification` is carried because it is what makes the field redacted-but-addressable, and it
 * is the only thing in the finding that says how much the disclosure costs. The field's **value**
 * appears nowhere here or in anything rendered from it — these are the fields whose whole purpose
 * is that their values are not disclosed, and a boot log is a disclosure. `column-encryption.ts`
 * and `sensitive-field-policy.ts` draw the same line for the same reason.
 */
export interface SortableClassifiedField {
  readonly entity: string;
  readonly field: string;
  readonly classification: DataClassification;
}

/**
 * Every classified field of this manifest that a caller may name in `?sort`.
 *
 * **The sortable set, not the default sort**, and that is the difference from
 * `abac-obligations.ts`' `listSortConflicts`, which walks `defaultSort`. That function is asking a
 * different question and is right to: a *default* sort is one no caller can decline, which is why
 * it earns a refusal with no hatch. This one asks what a caller can *choose*, and
 * `parseListQuery` honours `?sort=<field>` for any member of `config.sortableFields`. Measured,
 * the two sets are nothing like each other: healthcare's `Patient` has **one** classified default
 * sort key (`family_name`) and **five** classified sortable fields, so a default-sort survey
 * misses `Patient.mrn` — the `phi` member — entirely.
 *
 * Two borrowings rather than two restatements, each the function the request path itself uses:
 *
 *   - **`listConfigForEntity`** derives the sortable set, so this reads the set
 *     `parseListQuery` will actually accept — including that a hidden column is not sortable, that
 *     `sortable: false` opts out, and that an entity with no list view exposes no sort surface at
 *     all (an empty set, and therefore never a finding).
 *   - **`resolvedClassifiedFields`** says which fields are classified **as the served table has
 *     them**, so a classified field arriving through a **trait** is in scope. Reading
 *     `entity.fields` would be a blind spot of exactly the shape this repo keeps finding — a field
 *     `validateManifest` sees, the emitted table has, the view can sort by, and the survey does
 *     not.
 *
 * The predicate is **classified** and deliberately *not* narrowed by `isSensitiveDataClass`,
 * which is ADR-0345's stated reason at a second surface: narrowing it would let a boot pass still
 * disclose an `internal`-classified sort value. Measured, that widening is **vacuous on the seven
 * shipped packs** — all 173 classified fields there are `pii`/`phi`/`regulated`/
 * `commercial_sensitive`, so not one `internal` or `public` field exists to find — and it is still
 * the right predicate, because a *tenant's own* activated manifest (ADR-0314) is surveyed by this
 * same function and nothing stops it classifying a field `internal`.
 *
 * Order is entity declaration order, then resolved field order — `surveyPhiFields`' order, so the
 * detail a boot prints is stable across boots and diffable between two manifests. Driving the loop
 * from the classified fields rather than from `sortableFields` also makes the result naturally free
 * of duplicates, since the resolution emits each name once while a view may legitimately declare
 * one field as two columns.
 */
export function surveySortableClassifiedFields(
  manifest: Manifest,
): readonly SortableClassifiedField[] {
  const traits = manifest.traits ?? [];
  const out: SortableClassifiedField[] = [];
  for (const entity of manifest.entities ?? []) {
    const sortable = new Set(listConfigForEntity(manifest, entity.name).sortableFields);
    if (sortable.size === 0) continue;
    for (const { field, classification } of resolvedClassifiedFields(entity, traits)) {
      if (!sortable.has(field)) continue;
      out.push({ entity: entity.name, field, classification });
    }
  }
  return out;
}

export const CURSOR_DISCLOSURE_VERDICTS = [
  "no_sortable_classified_field",
  "sealed",
  "plaintext_accepted",
  "plaintext_disclosing",
] as const;
export type CursorDisclosureVerdict = (typeof CURSOR_DISCLOSURE_VERDICTS)[number];

/**
 * Which verdict each sealing mode produces once the manifest has a member. A **total map** over
 * `CursorSealingMode` rather than a chain, so a fourth sealing mode is a compile error here
 * instead of inheriting whichever branch an `if` happened to end on — and the direction that
 * matters is that an unconsidered mode must not be described as `sealed`.
 */
const VERDICT_BY_MODE: Readonly<Record<CursorSealingMode, CursorDisclosureVerdict>> = {
  sealed: "sealed",
  plaintext_accepted: "plaintext_accepted",
  absent: "plaintext_disclosing",
};

/**
 * Whether each verdict permits a boot. `PHI_VERDICT_MAY_SERVE`'s shape, and **every member is
 * `true`**: this verdict reports and never refuses.
 *
 * That is a decision and it is argued from measurement, not from taste. The three precedents
 * disagree with each other and the one that fits is the third:
 *
 *   - **ADR-0340 refuses with no hatch** because serving a grant with its qualifier removed is the
 *     *opposite* of what the manifest declares. Not this: a view declaring a column `sortable` and
 *     a field `pii` is asking for both, and serving the sort is what it asked for.
 *   - **ADR-0338 refuses by default with a hatch** on an explicit licence — *"nothing served PHI
 *     correctly today, so the refusal breaks nothing that worked"*. Measured **false** here, which
 *     is what settles it: every one of the seven packs has a member, `erp-core` included, and
 *     `erp-core` is the shipped compose default. Refusing would refuse every deployment there is.
 *   - **ADR-0334 leaves `--tenant-status-gate` opt-in** precisely because on-by-default would
 *     refuse requests of a deployment that works today. That is this case exactly.
 *
 * And one argument of its own, which is the reason a refusal here would be actively worse than a
 * report rather than merely stricter. The hatch an operator would reach for is
 * `{@link ALLOW_CURSOR_DISCLOSURE_FLAG}`, and that flag is not this verdict's — it also accepts
 * `cursor_discloses_withheld_rows`, the refusal about rows the caller was **never shown**. So a
 * refusal met on the compose default would be cleared by passing a flag that disarms the sharper
 * check standing beside it, and every deployment would arrive pre-disarmed for the day a grant
 * starts filtering rows. A verdict that drives an operator to weaken an unrelated check has made
 * things worse; "a remedy that cannot work is worse than none" (ADR-0334), one notch out.
 *
 * The map is read by {@link decideCursorDisclosure} rather than being a constant nobody consults,
 * and it earns its totality the usual way: a fifth verdict cannot be added without saying which
 * side it is on. Flipping a member to `false` is the whole of turning this into a refusal, so the
 * reasoning above has to be revisited in an ADR rather than rediscovered at the call site.
 */
export const CURSOR_DISCLOSURE_MAY_SERVE: Readonly<Record<CursorDisclosureVerdict, boolean>> = {
  no_sortable_classified_field: true,
  sealed: true,
  plaintext_accepted: true,
  plaintext_disclosing: true,
};

export interface CursorDisclosureDecision {
  readonly verdict: CursorDisclosureVerdict;
  /** The surveyed members. Non-empty for every verdict but `no_sortable_classified_field`. */
  readonly fields: readonly SortableClassifiedField[];
  /** One line for the boot log. Names `Entity.field` and a classification, never a value. */
  readonly detail: string;
  /** True iff the server may start. True for every verdict — see {@link CURSOR_DISCLOSURE_MAY_SERVE}. */
  readonly mayServe: boolean;
}

/** `Entity.field (class), … (+N more)` — names and classifications only, never a value. */
function nameFields(fields: readonly SortableClassifiedField[]): string {
  const shown = fields
    .slice(0, CURSOR_DISCLOSURE_FIELD_LIMIT)
    .map((f) => `${f.entity}.${f.field} (${f.classification})`);
  const hidden = fields.length - shown.length;
  // The count is reported separately by every caller, so a truncated list never stands in for the
  // figure an operator compares between two manifests.
  const suffix = hidden > 0 ? ` (+${hidden.toString()} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

/**
 * One renderer per verdict. A total map for `MODE_DETAIL`'s reason, and the two lines that report
 * a live disclosure carry more than the names because **none of what they describe is guessable
 * from the declaration**: that a cursor is an encoding rather than a token, that the body's
 * redaction and the cursor are two code paths, and that only the first consults the caller's
 * grants.
 */
const DETAIL: Readonly<
  Record<CursorDisclosureVerdict, (fields: readonly SortableClassifiedField[]) => string>
> = {
  no_sortable_classified_field: () =>
    `no classified field of any entity is nameable in \`?sort\`, so no entity-list cursor can ` +
    `carry a classified value`,

  sealed: (fields) =>
    `${fields.length.toString()} classified field(s) are nameable in \`?sort\` and every ` +
    `entity-list cursor is sealed with a per-tenant key derived from ` +
    `${CURSOR_ENCRYPTION_SECRET_VAR}, so none of their values travels back in the clear: ` +
    nameFields(fields),

  plaintext_accepted: (fields) =>
    `${CURSOR_ENCRYPTION_SECRET_VAR} is not set and ${ALLOW_CURSOR_DISCLOSURE_FLAG} was given, ` +
    `so a caller naming any of ${fields.length.toString()} classified field(s) in \`?sort\` is ` +
    `handed that field's plaintext in the cursor of a response whose body redacted it: ` +
    `${nameFields(fields)}. Set ${CURSOR_ENCRYPTION_SECRET_VAR} to seal it`,

  // Said out loud on every boot, which is the whole of what a report owes where a refusal would
  // be wrong (ADR-0322): the deployment starts, so this line is the only thing that distinguishes
  // a disclosure nobody has looked at from one somebody weighed.
  plaintext_disclosing: (fields) =>
    `${fields.length.toString()} classified field(s) are nameable in \`?sort\` while ` +
    `${CURSOR_ENCRYPTION_SECRET_VAR} is not set, so a caller who names one is served a body with ` +
    `that field redacted per their own grants and a \`nextCursor\` of ` +
    `base64url(JSON.stringify({k: [...sort values], id})) carrying its plaintext: ` +
    `${nameFields(fields)}. The redaction and the cursor are two code paths and only the first ` +
    `consults the caller's grants, so this is a disclosure of the field rather than of a row — ` +
    `the row is one the caller is shown, the value is one they are not. Set ` +
    `${CURSOR_ENCRYPTION_SECRET_VAR} so every entity-list cursor is sealed with a per-tenant key, ` +
    `or pass ${ALLOW_CURSOR_DISCLOSURE_FLAG} to record that the disclosure is accepted — the ` +
    `deployment starts either way, and that flag also accepts the disclosure of rows withheld by ` +
    `a record policy, so it concedes more than this line asks for`,
};

/**
 * Whether this deployment hands a classified field's plaintext back in an entity-list cursor.
 *
 * | fields | mode                 | verdict                        |
 * |--------|----------------------|--------------------------------|
 * | none   | any                  | `no_sortable_classified_field` |
 * | some   | `sealed`             | `sealed`                       |
 * | some   | `plaintext_accepted` | `plaintext_accepted`           |
 * | some   | `absent`             | `plaintext_disclosing`         |
 *
 * The empty case is answered **first and for every mode**, `decidePhiStorage`'s row 1 and for its
 * reason: with no classified sortable field there is nothing a cursor could carry, so reporting
 * `sealed` there would tell a deployment it had closed a hole it never had — and reporting
 * `plaintext_disclosing` would send it to configure a secret for data it does not hold.
 */
export function decideCursorDisclosure(input: {
  readonly mode: CursorSealingMode;
  readonly fields: readonly SortableClassifiedField[];
}): CursorDisclosureDecision {
  const { mode, fields } = input;
  const verdict = fields.length === 0 ? "no_sortable_classified_field" : VERDICT_BY_MODE[mode];
  return {
    verdict,
    fields,
    detail: DETAIL[verdict](fields),
    mayServe: CURSOR_DISCLOSURE_MAY_SERVE[verdict],
  };
}

/** The boot line. Leads with the verdict, `formatCursorSealing`'s rule. */
export function formatCursorDisclosure(decision: CursorDisclosureDecision): string {
  return `cursor disclosure: ${decision.verdict} — ${decision.detail}`;
}
