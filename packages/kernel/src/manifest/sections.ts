import { canonicalizeForHash } from "./hash.js";
import type { Manifest } from "./types.js";

/**
 * Every key of a parsed manifest two manifests can differ on.
 *
 * Derived from `Manifest` rather than written out, and it is worth being exact about what that
 * buys, because an earlier version of this comment claimed a compile error in "the three total
 * maps below" and the figure is **two**: `MANIFEST_SECTION_REACH` and
 * `MANIFEST_SECTION_MEMBER_KEYING` are keyed by section, while `MANIFEST_SECTION_REACH_MEANINGS`
 * is keyed by *reach* and a new section cannot touch it.
 *
 * It also claimed that was "rather than a section silently nobody compares", and the loop driver
 * is the one thing the compiler does **not** fence: `MANIFEST_SECTION_NAMES` is
 * `satisfies readonly ManifestSectionName[]`, which is a subset check, so measured — a section
 * added to `ManifestSchema` and to both maps typechecks clean while `diffManifestSections` never
 * compares it. What catches that is `sections.test.ts`, in three places: `manifestSectionsMatchSchema`,
 * `manifestSectionMemberKeyingsMatchSchema` and the reach map's own assertion.
 *
 * A tuple-exhaustiveness type fence is deliberately **not** added beside them, and the reason is a
 * measurement rather than taste: a *renamed* section already errors here and at both maps (TS2820
 * at the array, TS2561 at each map), so the only case such a fence would add is an **addition** —
 * a strict subset of what those three tests catch, since they also compare declaration **order**
 * and the schema's own key spellings, neither of which any type over `ManifestSectionName` can see
 * (that type is derived from the same schema, so a rename moves both sides together). Under
 * `noUnusedLocals` the fence would also have to be an exported dummy value in the kernel's public
 * API. A strictly weaker check at that price is not worth having.
 *
 * `manifestVersion` is the one exclusion and it is a proof rather than a convention: the schema
 * pins it to `z.literal("1.0")`, so two manifests that both parse cannot disagree about it and
 * comparing it is vacuous. `meta` is deliberately *not* excluded — `meta.extends` decides whether
 * a design extends the deployment's pack or replaces it (ADR-0368), which is the single most
 * consequential fact in a tenant's manifest.
 */
export type ManifestSectionName = Exclude<keyof Manifest, "manifestVersion">;

/**
 * Declaration order of `ManifestSchema`, which `sections.test.ts`'s `manifestSectionsMatchSchema`
 * compares against `ManifestSchema.shape` in both directions **and in order** — so a renamed key,
 * an added one and a reordering each fail there. The first of those also fails to compile; the
 * other two do not. See `ManifestSectionName` above for why that is the fence.
 */
export const MANIFEST_SECTION_NAMES = [
  "meta",
  "entities",
  "traits",
  "relations",
  "roles",
  "permissions",
  "workflows",
  "integrations",
  "jobs",
  "files",
  "reports",
  "dashboards",
  "views",
  "customWidgets",
  "theme",
  "i18n",
  "search",
] as const satisfies readonly ManifestSectionName[];

/**
 * How far a change in this section reaches **a request**.
 *
 * `served` means a change alters what a request gets — a column, a route, an authorization answer,
 * a response body or a refusal. `validated_only` means the kernel checks its coherence and no
 * request path reads it. `unread` means not even that: no validator and no request path.
 *
 * The axis is the **request** and not readership in general, which the three sentences used to
 * claim and two of them got wrong. Measured against the committed tree: `manifest.reports` and
 * `manifest.dashboards` are read by `apps/operate-server`'s boot survey of unserved ABAC positions,
 * so "no runtime reads it" was false of both; and `manifest.customWidgets` is read by
 * `apps/architect-cli`'s manifest summary, which counts it and prints the count, so "nothing reads
 * it at all, `validateManifest` included" was false of it too. Every section is also read by
 * `extends.ts`'s lineage merge, which alone makes an unqualified "read by nothing" unavailable.
 *
 * A fourth member for *read by a developer tool or a boot survey* was considered and refused: it
 * would have to be answered by every map keyed by reach, it would split
 * `{reports, dashboards, customWidgets}` off from `{integrations, files, search, theme, i18n}` on
 * an axis no reviewer of a manifest acts on, and the thing a reviewer needs to know — whether this
 * change can alter what a request gets — is already the question `served` asks.
 *
 * This is a judgement about the workspace rather than a derivation, the way
 * `pg-binding-names.ts`' divergence reasons are, so it cannot be machine-checked — what *is*
 * machine-checked is that the map is total, that every member has at least one section, and that
 * each section's reach is the one measured here rather than merely one of the three.
 */
export const MANIFEST_SECTION_REACHES = ["served", "validated_only", "unread"] as const;
export type ManifestSectionReach = (typeof MANIFEST_SECTION_REACHES)[number];

/**
 * Measured against the committed tree. `served` is taken wherever **any** key of the section is
 * served, because under-reporting a reach is the dangerous direction: `meta` is served on
 * `extends` while `meta.compliancePacks` is counted by one fabricated field (register P0.8).
 *
 * The non-`served` entries, with the reader that fixes each — because "nothing reads it" is the
 * claim that went stale, and a named reader is checkable where an absence is not.
 * `validated_only`: `integrations`, `files`, `reports`, `dashboards` and `search` are each named by
 * one `validateManifest` call and by nothing on the request path. `unread`: `validateManifest`
 * names `customWidgets`, `theme` and `i18n` nowhere — it is a hand-written sequence of thirteen
 * calls and those three are not among them, which is why they are a reach of their own rather than
 * `validated_only`.
 */
export const MANIFEST_SECTION_REACH: Readonly<Record<ManifestSectionName, ManifestSectionReach>> = {
  meta: "served",
  entities: "served",
  traits: "served",
  relations: "served",
  roles: "served",
  permissions: "served",
  workflows: "served",
  integrations: "validated_only",
  jobs: "served",
  files: "validated_only",
  reports: "validated_only",
  dashboards: "validated_only",
  views: "served",
  customWidgets: "unread",
  theme: "unread",
  i18n: "unread",
  search: "validated_only",
};

/**
 * What a reader is being told, per reach. Keyed by **reach** and not by section, because the
 * section's name already carries the section-specific half.
 *
 * It used to say "three places for one to go stale instead of seventeen", and the count was wrong
 * in the direction that mattered: there were **four** copies, because `apps/operate-web` held its
 * own three sentences and this map had no non-test reader at all — so the live copy was the one
 * nothing compared, and its two non-served sentences each dropped a different clause, between them
 * exactly the two facts that separate `validated_only` from `unread`. `ManifestSectionChange`
 * carries `reachNote` for that reason: one source, sent with the change, with no copy to drift.
 *
 * Both non-served sentences say **request path** rather than runtime or readership, which is the
 * axis `MANIFEST_SECTION_REACH` measures and the only one a reviewer acts on — see there for the
 * three sections an unqualified "nothing reads it" was false of.
 *
 * None of them names a remedy, deliberately (ADR-0334): the remedy for "this changed" is to read
 * what changed, which the finding is. `sections.test.ts` checks that rather than taking it on
 * trust, which the test that claimed to had not.
 */
export const MANIFEST_SECTION_REACH_MEANINGS: Readonly<Record<ManifestSectionReach, string>> = {
  served: "a change here alters what a request gets",
  validated_only: "validated for coherence; no request path reads it, so a change serves nothing",
  unread: "not validated and no request path reads it, so a change serves nothing",
};

/**
 * How this section's members are named, so a change can be reported as more than a count.
 *
 * `record` keys by the record's own key, `named_array` by each member's `name`, `object_keys` by
 * the object's own top-level keys. `unkeyed_array` is `relations` alone: its members are a
 * discriminated union with neither `name` nor `id`, so there is no key to report and the change
 * carries counts and the fact that the canonical bytes moved.
 */
export const MANIFEST_SECTION_MEMBER_KEYINGS = [
  "record",
  "named_array",
  "object_keys",
  "unkeyed_array",
] as const;
export type ManifestSectionMemberKeying = (typeof MANIFEST_SECTION_MEMBER_KEYINGS)[number];

/**
 * Declared rather than probed from `ManifestSchema.shape` at run time, for two reasons and one
 * cost. The reasons: a `Record<ManifestSectionName, …>` is a compile-time obligation where a
 * probe can only be a run-time answer, and `named_array` has to know the key property is `name`,
 * which a probe over an element's shape can only guess from candidates. The cost is that it can
 * drift, which `sections.test.ts`'s `manifestSectionMemberKeyingsMatchSchema` closes by running
 * that probe and comparing both ways — 17 of 17 agree as committed.
 *
 * What that probe does **not** establish, measured: it answers `unkeyed_array` for `relations`
 * because the element is a `ZodDiscriminatedUnion` rather than a `ZodObject`, not because its
 * members lack a `name` — none does, so the agreement is right for the right reason today and the
 * probe would give the same answer for an array of a union whose members all carried one. And for
 * `named_array` it tests `"name" in element.shape`, the same hardcoded string this module uses, so
 * the key's identity is assumed on both sides. Its required-and-non-empty-ness is asserted on its
 * own, because `namedMemberKey` silently skips a member without it.
 */
export const MANIFEST_SECTION_MEMBER_KEYING: Readonly<
  Record<ManifestSectionName, ManifestSectionMemberKeying>
> = {
  meta: "object_keys",
  entities: "named_array",
  traits: "named_array",
  relations: "unkeyed_array",
  roles: "record",
  permissions: "record",
  workflows: "record",
  integrations: "record",
  jobs: "record",
  files: "record",
  reports: "record",
  dashboards: "record",
  views: "record",
  customWidgets: "record",
  theme: "object_keys",
  i18n: "object_keys",
  search: "object_keys",
};

/**
 * `meta.manifestResolution` is the receipt resolution writes onto a manifest, not an authored
 * declaration — `canonicalManifestJson` strips it before hashing, so including it here would
 * report a change in a section whose contribution to `manifestHash` did not move.
 */
const META_KEYS_NOT_AUTHORED: readonly string[] = ["manifestResolution"];

/** Whether this section was present on each side, which `{}` and absent differ in. */
export const MANIFEST_SECTION_PRESENCES = ["added", "removed", "present"] as const;
export type ManifestSectionPresence = (typeof MANIFEST_SECTION_PRESENCES)[number];

export interface ManifestSectionChange {
  readonly section: ManifestSectionName;
  readonly reach: ManifestSectionReach;
  /**
   * `MANIFEST_SECTION_REACH_MEANINGS[reach]`, carried rather than left for a consumer to look up.
   *
   * It rides on the change because the alternative was measured and is worse: that map had **no
   * non-test reader anywhere in the workspace**, while `apps/operate-web` held its own hand-written
   * `REACH_NOTE` with three sentences of its own — so the live copy was the one nothing compared,
   * and each of its two non-served sentences dropped a different clause, between them exactly the
   * two facts that separate `validated_only` from `unread`. Nothing could have caught that: the
   * reach crosses the wire as a bare `string`, the client's note is a `Record<string, string>`
   * rather than a total map over the union, and that app has no tests. Sending the sentence removes
   * the copy instead of fencing it, which is the only fix that cannot drift.
   */
  readonly reachNote: string;
  readonly keying: ManifestSectionMemberKeying;
  /** `added`/`removed` is the section key itself appearing or disappearing, not its members. */
  readonly presence: ManifestSectionPresence;
  /**
   * False for `unkeyed_array` only. When it is false the three member lists are empty **because
   * there is no key to name**, never because nothing changed — the change being returned at all
   * is what says the canonical bytes moved (ADR-0331's distinction, inside one record).
   */
  readonly membersKeyed: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly countBefore: number;
  readonly countAfter: number;
}

/**
 * Which sections of `next` differ from `active`, named member by member where the section has
 * members to name.
 *
 * Equality is `canonicalizeForHash`, which is the same function `manifestHash` commits through —
 * so for a parsed manifest a section this reports unchanged contributes identical bytes to the
 * hash a reviewer approves, and there is no second notion of "the same manifest" to drift from
 * the first. The one deliberate exception is `meta.manifestResolution`, which the hash strips
 * too. The consequence worth knowing is inherited rather than chosen: that canonicaliser sorts an
 * array of named objects and leaves an unnamed one in place, so reordering `relations` reads as a
 * change here exactly as it moves the hash.
 *
 * Reports **every** differing section and holds no opinion about which a caller renders in
 * detail elsewhere; filtering is the caller's, so a seventeenth section needs no caller change to
 * be shown. A null `active` is everything-added, matching `computeManifestDiff`.
 */
export function diffManifestSections(
  active: Manifest | null,
  next: Manifest,
): readonly ManifestSectionChange[] {
  const changes: ManifestSectionChange[] = [];
  for (const section of MANIFEST_SECTION_NAMES) {
    const before = active === null ? undefined : active[section];
    const after = next[section];
    const change = compareSection(section, before, after);
    if (change !== null) changes.push(change);
  }
  return changes;
}

/**
 * Whether **adding** a member to this section can narrow a surface a request currently gets.
 *
 * `false` for sixteen of the seventeen, because a new member of a `record` or `named_array` section
 * declares something that did not exist: a new entity, role, permission block or job takes nothing
 * away, and `meta.extends` appearing *inherits* a pack rather than replacing one.
 *
 * `views` is the exception and the reason is structural rather than incidental — a view **overrides
 * a derived default**. `listConfigForEntity` answers from every text field when an entity has no
 * list view and from the view's visible columns when it has one, so the *first* view for an entity
 * narrows the searchable set, and a *second* one inserted ahead of the first narrows it again
 * (`Object.values` order decides which serves, where `canonicalizeForHash` sorts keys — so the
 * shadowing member is invisible to the hash's ordering). Measured: adding one list view takes
 * `[label, note]` to `[label]`, and since ADR-0359 `?note=x` then answers **400
 * `not_filterable`** where it used to filter. Exactly the `views` consequence ADR-0388 singles out,
 * from a change whose only non-empty list is `added`.
 *
 * A total map so a section added to the schema has to answer, and separate from
 * `MANIFEST_SECTION_REACH` because the two ask different questions: that one is *does a change here
 * reach a request at all*, this one is *does a change of this shape narrow it*.
 */
export const MANIFEST_SECTION_ADDED_MAY_NARROW: Readonly<Record<ManifestSectionName, boolean>> = {
  meta: false,
  entities: false,
  traits: false,
  relations: false,
  roles: false,
  permissions: false,
  workflows: false,
  integrations: false,
  jobs: false,
  files: false,
  reports: false,
  dashboards: false,
  views: true,
  customWidgets: false,
  theme: false,
  i18n: false,
  search: false,
};

/**
 * Whether this change **can** take away something a request currently gets.
 *
 * A `may` and deliberately over-reporting: a changed `roles` member may only have moved a label,
 * and a changed `views` member may have dropped the column that made a `?field=` filter
 * serveable, which since ADR-0359 the store answers 400 rather than ignoring. Nothing here can
 * tell those apart without re-diffing each section's own shape, and under-reporting is the
 * direction that lets a reviewer approve a removal blind.
 *
 * It is a statement about the manifest rather than about any caller's rendering, which is why the
 * kernel holds it: a consumer that maps it to a banner, an impact or a warning grade is then
 * mapping one fact rather than re-deriving a judgement.
 *
 * **An unkeyed change is `true` for any presence but `added`, and the narrower reading it replaced
 * was unsound in two directions.** `relations` is the only `unkeyed_array` section, its
 * `removed`/`changed` are empty by invariant, so the old last line — a strictly shrinking count —
 * was the whole of its answer, under a comment asserting that was the only withholding it could
 * show. Measured, three shapes it called safe: one `many_to_many` swapped for another at **equal**
 * count loses **8 association routes and a join table**; one removed while two are added makes the
 * count *grow* while a list route and its join table go; and a `many_to_one` whose `onDelete` moves
 * `set_null` → `restrict` makes a parent delete that used to succeed start failing. A pure
 * **reorder** is a fourth, because `relationDeleteIndex` is last-wins over `(from, field)`, so
 * reordering two relations on one pair changes the effective policy at equal count and identical
 * contents. A multiset difference over the members' canonical bytes would catch the first three and
 * not the fourth, so the answer here is the conservative one — a reported unkeyed change at
 * `present` means the bytes moved and nothing available here can say no member went — and the
 * refinement is left as a *content* improvement rather than a predicate one.
 */
export function manifestSectionChangeMayWithhold(change: ManifestSectionChange): boolean {
  if (change.reach !== "served") return false;
  if (change.presence === "removed") return true;
  if (change.removed.length > 0 || change.changed.length > 0) return true;
  if (change.added.length > 0 && MANIFEST_SECTION_ADDED_MAY_NARROW[change.section]) return true;
  return !change.membersKeyed && change.presence !== "added";
}

function compareSection(
  section: ManifestSectionName,
  before: unknown,
  after: unknown,
): ManifestSectionChange | null {
  const keying = MANIFEST_SECTION_MEMBER_KEYING[section];
  const presence = presenceOf(before, after);
  if (presence === null) return null;

  if (keying === "unkeyed_array") {
    const beforeItems = asArray(before);
    const afterItems = asArray(after);
    if (presence === "present" && canonical(before) === canonical(after)) return null;
    return {
      section,
      reach: MANIFEST_SECTION_REACH[section],
      reachNote: MANIFEST_SECTION_REACH_MEANINGS[MANIFEST_SECTION_REACH[section]],
      keying,
      presence,
      membersKeyed: false,
      added: [],
      removed: [],
      changed: [],
      countBefore: beforeItems.length,
      countAfter: afterItems.length,
    };
  }

  const beforeMembers = membersOf(section, keying, before);
  const afterMembers = membersOf(section, keying, after);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, value] of afterMembers) {
    const prior = beforeMembers.get(key);
    if (prior === undefined) {
      added.push(key);
      continue;
    }
    if (prior !== value) changed.push(key);
  }
  for (const key of beforeMembers.keys()) {
    if (!afterMembers.has(key)) removed.push(key);
  }

  if (
    presence === "present" &&
    added.length === 0 &&
    removed.length === 0 &&
    changed.length === 0
  ) {
    return null;
  }

  return {
    section,
    reach: MANIFEST_SECTION_REACH[section],
    reachNote: MANIFEST_SECTION_REACH_MEANINGS[MANIFEST_SECTION_REACH[section]],
    keying,
    presence,
    membersKeyed: true,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    countBefore: beforeMembers.size,
    countAfter: afterMembers.size,
  };
}

/**
 * `null` means neither side has the section — nothing to compare and nothing to report. A section
 * absent on one side is reported even when it holds no members, because `{views: {}}` and no
 * `views` key are different bytes to `manifestHash`.
 */
function presenceOf(before: unknown, after: unknown): ManifestSectionPresence | null {
  const had = before !== undefined;
  const has = after !== undefined;
  if (!had && !has) return null;
  if (!had) return "added";
  if (!has) return "removed";
  return "present";
}

/** Each member's key mapped to its canonical bytes, so a changed member is one string compare. */
function membersOf(
  section: ManifestSectionName,
  keying: Exclude<ManifestSectionMemberKeying, "unkeyed_array">,
  value: unknown,
): ReadonlyMap<string, string> {
  const members = new Map<string, string>();
  if (value === undefined || value === null) return members;

  if (keying === "named_array") {
    for (const item of asArray(value)) {
      const name = namedMemberKey(item);
      // Unreachable for a parsed manifest rather than a tolerated loss: `EntitySchema.name` and
      // `TraitSchema.name` are both required non-empty strings, so every member of the only two
      // `named_array` sections has a key — asserted in `sections.test.ts` rather than assumed here,
      // because this branch is what rests on it. Defensive for an object that bypassed the parse,
      // and for one of those the loss is an **under-count** as well as an unnamed member: the
      // counts below are the `Map`'s size, so a skipped member reports `countAfter: 0` for an array
      // holding one — a change with nothing in it.
      if (name === null) continue;
      if (!members.has(name)) members.set(name, canonical(item));
    }
    return members;
  }

  if (typeof value !== "object" || Array.isArray(value)) return members;
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (member === undefined) continue;
    if (section === "meta" && META_KEYS_NOT_AUTHORED.includes(key)) continue;
    members.set(key, canonical(member));
  }
  return members;
}

function namedMemberKey(item: unknown): string | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const name = (item as Record<string, unknown>)["name"];
  return typeof name === "string" && name.length > 0 ? name : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function canonical(value: unknown): string {
  return JSON.stringify(canonicalizeForHash(value)) ?? "undefined";
}
