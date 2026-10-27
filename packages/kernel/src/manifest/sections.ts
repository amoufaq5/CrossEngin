import { canonicalizeForHash } from "./hash.js";
import type { Manifest } from "./types.js";

/**
 * Every key of a parsed manifest two manifests can differ on.
 *
 * Derived from `Manifest` rather than written out, so adding a section to `ManifestSchema` is a
 * **compile error** in the three total maps below rather than a section silently nobody compares.
 * `manifestVersion` is the one exclusion and it is a proof rather than a convention: the schema
 * pins it to `z.literal("1.0")`, so two manifests that both parse cannot disagree about it and
 * comparing it is vacuous. `meta` is deliberately *not* excluded — `meta.extends` decides whether
 * a design extends the deployment's pack or replaces it (ADR-0368), which is the single most
 * consequential fact in a tenant's manifest.
 */
export type ManifestSectionName = Exclude<keyof Manifest, "manifestVersion">;

/**
 * Declaration order of `ManifestSchema`, which `manifestSectionsMatchSchema` asserts against
 * `ManifestSchema.shape` in both directions and in order — so a renamed key fails there rather
 * than leaving a member nothing produces.
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
 * How far a change in this section reaches.
 *
 * `served` means a change alters what a request gets — a column, a route, an authorization answer,
 * a response body or a refusal. `validated_only` means the kernel checks its coherence and no
 * runtime reads it. `unread` means nothing reads it at all, `validateManifest` included.
 *
 * This is a judgement about the workspace rather than a derivation, the way
 * `pg-binding-names.ts`' divergence reasons are, so it cannot be machine-checked — what *is*
 * machine-checked is that the map is total.
 */
export const MANIFEST_SECTION_REACHES = ["served", "validated_only", "unread"] as const;
export type ManifestSectionReach = (typeof MANIFEST_SECTION_REACHES)[number];

/**
 * Measured against the committed tree. `served` is taken wherever **any** key of the section is
 * served, because under-reporting a reach is the dangerous direction: `meta` is served on
 * `extends` while `meta.compliancePacks` is counted by one fabricated field (register P0.8).
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
 * section's name already carries the section-specific half; three sentences rather than
 * seventeen is also three places for one to go stale instead of seventeen.
 *
 * None of them names a remedy, deliberately (ADR-0334): the remedy for "this changed" is to read
 * what changed, which the finding is.
 */
export const MANIFEST_SECTION_REACH_MEANINGS: Readonly<Record<ManifestSectionReach, string>> = {
  served: "a change here alters what a request gets",
  validated_only: "validated for coherence; no runtime reads it, so a change serves nothing",
  unread: "read by nothing, validateManifest included, so a change serves nothing",
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
 * drift, which `manifestSectionMemberKeyingsMatchSchema` closes by running that probe in the test
 * and comparing both ways — 17 of 17 agree as committed.
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
 */
export function manifestSectionChangeMayWithhold(change: ManifestSectionChange): boolean {
  if (change.reach !== "served") return false;
  if (change.presence === "removed") return true;
  if (change.removed.length > 0 || change.changed.length > 0) return true;
  // An unkeyed section names no member, so a shrinking count is the only withholding it can show.
  return !change.membersKeyed && change.countAfter < change.countBefore;
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
      // `named_array` sections has a key. Defensive for an object that bypassed the parse.
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
