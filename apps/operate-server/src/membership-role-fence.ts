/**
 * Whether a membership grant names roles the tenant's served manifest declares.
 *
 * `GrantMembershipInputSchema.primaryRole` is `z.string().min(1)` and `secondaryRoles` is an array
 * of the same, and nothing anywhere compared either against `manifest.roles`. So the operator's
 * very first act after provisioning a colleague can hand them an account that authorizes nothing,
 * and the symptom is indistinguishable from the product being broken: the grant stores cleanly,
 * echoes back in the response, and mints a session that is refused everywhere.
 *
 * Measured against the real `rbacCheck` over resolved `erp-core`, which declares **15** roles
 * (`ap_clerk` … `warehouse_clerk`) and does **not** declare `platform_admin`: granting
 * `platform_admin` reaches **0 of 255** (entity, operation) pairs and **0 of 51** entities, where
 * the control `erp_admin` reaches 250 of 255 and 50 of 51. Nothing in between — an undeclared
 * primary role is a total denial, not a narrowed one.
 *
 * ## The two positions are not the same defect, and the difference is not declaredness
 *
 * This section used to argue that a secondary warning must offer no remedy at all, because a
 * secondary role is granted, stored (`secondary_roles TEXT[] NOT NULL`), read back by
 * `rowToMembership`, echoed in the API body — and then reached no authorization decision, for
 * **two** independent reasons either of which alone was sufficient. `mintSessionToken` stamped
 * `scope: input.role`, one string, from `roleFor`, which returned `membership.primaryRole` alone;
 * and `principalRoles` was `(p) => ({primaryRole: p?.grantedScopes[0] ?? "anonymous"})`, which
 * returned no `secondaryRoles` key at all, so every `...(secondaryRoles ?? [])` reader took the
 * empty arm however many scopes a token carried. **ADR-0369 closed both.** Declaring a secondary
 * role now does something, so withholding the catalog from that warning would be ADR-0334's
 * remedy-that-cannot-work rule applied to a remedy that works. Both positions offer the names.
 *
 * What survives is a difference in the **consequence**, which is why the two details are still two
 * sentences and why `NOT_DECLARED_COST` is a map rather than one string. An undeclared **primary**
 * denies: it resolves to no grant, and with nothing else in the membership to supply one the
 * session authorizes nothing — ADR-0365's 0 of 255 (entity, operation) pairs. An undeclared
 * **secondary** can only ever fail to *add*: `resolveEffectiveRoles` visits it with `"skip"` beside
 * a primary that still resolves, so the membership authorizes whatever it would have without the
 * name. Total against no-op, and neither warning may read as the other.
 *
 * The qualifier on that first half is ADR-0369's own doing and is worth stating rather than
 * rounding off, because this module's measurement predates it: ADR-0365 measured the 0 of 255 on a
 * grant carrying **no** secondary roles, and before ADR-0369 that generalised, since an undeclared
 * primary denied whatever the list held — the list was unread. Now a *declared* secondary beside an
 * undeclared primary genuinely carries grants, so the primary detail says `unless a declared
 * secondary role carries one`. The position is still the consequential one for two reasons no
 * measurement here touches: it is the role `UiViewer.primaryRole` shows, and the only role an
 * `--api-key key:role:tenant` spec can express.
 *
 * ## Why this warns and never refuses
 *
 * The directory answers from the manifest the deployment serves *this tenant*, and under
 * `--tenant-manifests` (ADR-0314) a tenant may serve its own activated manifest declaring roles the
 * boot pack does not. A refusal would therefore refuse a grant that is correct for that tenant, on
 * the strength of a catalog that is not the one the tenant is served from. `checkMembershipRoles`
 * has no refusing outcome at all, which is the same split `surveyViewPermissionOverrides` takes:
 * report where the remedy belongs to somebody the refusal cannot reach.
 *
 * ## Why this is not the boot survey its siblings are
 *
 * An **unscoped** census is the trap, and that half is measured: `META_USER_TENANT_MEMBERSHIP`
 * carries exactly one policy — `membership_tenant_isolation`, with no `command`, so `ALL`-scope —
 * and **no platform read arm**, so a non-owner session with no tenant context reads **zero rows**
 * and would report a clean deployment because it could see nothing: ADR-0333's silent-zero class,
 * in the one table whose rows are the finding.
 *
 * A **scoped** census is a different matter and is genuinely available, which is worth writing down
 * because the obvious reason to dismiss it is false: `META_TENANTS` declares no `rls` block at all —
 * it carries no `tenant_id`, so it is platform-wide and skips RLS — and `membershipsForTenant`
 * already reads one tenant's rows inside `withTenantContext` behind a strict scope filter. A
 * per-tenant loop would therefore work. What it would not be is *this*: it answers for memberships
 * that **already exist**, at a boot the operator who granted them is not watching, where this
 * answers for the grant in front of them. The two are additive and neither substitutes.
 *
 * So the write is where this lives for a positive reason rather than for want of a read: the roles
 * are in the request body, so the fact is in hand without reading that table at all, and the
 * operator hears it at the one moment the remedy — name a declared role instead — is theirs.
 */

/**
 * Answers which roles a tenant's served manifest declares. `null` = this deployment cannot say.
 *
 * Keyed on the tenant and not on the deployment, because under per-tenant manifests the answer
 * genuinely differs per tenant and a deployment-wide set taken from the boot pack would be right
 * only for the tenants serving it.
 */
export type MembershipRoleDirectory = (tenantId: string) => Promise<ReadonlySet<string> | null>;

export const MEMBERSHIP_ROLE_VERDICTS = ["declared", "not_declared", "unresolved"] as const;
export type MembershipRoleVerdict = (typeof MEMBERSHIP_ROLE_VERDICTS)[number];

/**
 * Which verdicts the operator is told about. A total map so a fourth verdict is a compile error.
 *
 * `warningVerdictOf` reads it, so the map decides rather than documenting a decision taken
 * somewhere else — for every verdict but `declared`, which that function answers by comparison
 * instead, for the soundness reason stated there. So the entry for `declared` is the one member of
 * this map nothing branches on: it is here because a hole in a total map is what a total map exists
 * to prevent, and the test asserting it is the *single* `false` is what keeps the map and
 * `MembershipRoleWarning.verdict`'s excluded member from drifting apart.
 */
export const MEMBERSHIP_ROLE_VERDICT_WARNS: Readonly<Record<MembershipRoleVerdict, boolean>> = {
  declared: false,
  not_declared: true,
  unresolved: true,
};

export const MEMBERSHIP_ROLE_POSITIONS = ["primary", "secondary"] as const;
export type MembershipRolePosition = (typeof MEMBERSHIP_ROLE_POSITIONS)[number];

/** The verdicts a warning can carry: every member of the enum that `_WARNS` admits. */
type MembershipRoleWarningVerdict = Exclude<MembershipRoleVerdict, "declared">;

export interface MembershipRoleWarning {
  readonly position: MembershipRolePosition;
  readonly role: string;
  readonly verdict: Exclude<MembershipRoleVerdict, "declared">;
  /** One sentence naming the consequence; never a remedy this deployment cannot perform. */
  readonly detail: string;
  /** The declared roles, sorted, for `not_declared`; null for `unresolved` (nothing was read). */
  readonly declaredRoles: readonly string[] | null;
}

export interface MembershipRoleCheckInput {
  readonly tenantId: string;
  readonly primaryRole: string;
  readonly secondaryRoles: readonly string[];
}

/** How many declared role names a `not_declared` detail offers before summarising the rest. */
const NAMED_DECLARED_ROLE_LIMIT = 8;

/**
 * The verdict a warning carries, or `null` where the map says this one is silent.
 *
 * `declared` is excluded by **comparison** and not by a type predicate over the map, because the
 * predicate form is an annotation standing in for a check (ADR-0362) in one line: the compiler
 * cannot see that `MEMBERSHIP_ROLE_VERDICT_WARNS.declared` is `false`, so flipping that entry would
 * have it narrow `declared` to a type that excludes it and push a warning whose `verdict` field is
 * typed as something it is not. Written this way the narrowing is the compiler's, the map still
 * decides for every verdict the type does admit, and a flipped `declared` goes silent — which is
 * the direction the `MembershipRoleWarning` type already asserts.
 */
function warningVerdictOf(verdict: MembershipRoleVerdict): MembershipRoleWarningVerdict | null {
  if (verdict === "declared") return null;
  return MEMBERSHIP_ROLE_VERDICT_WARNS[verdict] ? verdict : null;
}

/**
 * What one check knows about the tenant's role catalog.
 *
 * Discriminated rather than a `ReadonlySet | null` carried beside a `string[] | null`, so the pair
 * ADR-0331 keeps apart cannot be held half-and-half. There is then no state in which a role
 * classifies `not_declared` and the names it was compared against are absent — which is the state a
 * `?? []` default would have to invent, and the value it would invent is the *claim* ("this manifest
 * declares no role") standing in for the *gap* ("nobody looked"): this module's own distinction,
 * defaulted away where it builds the warning that carries it.
 */
type RoleCatalog =
  | {
      readonly read: true;
      readonly declares: ReadonlySet<string>;
      readonly names: readonly string[];
    }
  | { readonly read: false };

function nameSome(declared: readonly string[]): string {
  if (declared.length <= NAMED_DECLARED_ROLE_LIMIT) return declared.join(", ");
  const shown = declared.slice(0, NAMED_DECLARED_ROLE_LIMIT).join(", ");
  return `${shown} (+${String(declared.length - NAMED_DECLARED_ROLE_LIMIT)} more)`;
}

/**
 * What an undeclared role costs, per position: total denial against no-op, and nothing else.
 *
 * A total map, so a third position is a compile error here rather than a sentence that silently
 * describes the wrong one — and declared once, because after ADR-0369 this pair *is* the whole
 * difference between the two warnings. The remedy clause and the "not declared by this tenant's
 * manifest" opening are now shared, so a difference that lived in two sentence builders would be
 * two chances to state it inconsistently.
 *
 * The primary's conditional clause is load-bearing and not hedging: ADR-0369 made a declared
 * secondary role resolve, so a grant pairing an undeclared primary with a declared secondary does
 * authorize something, where before that increment it could not.
 */
const NOT_DECLARED_COST: Readonly<Record<MembershipRolePosition, string>> = {
  primary:
    "so it resolves to no grant and, unless a declared secondary role carries one, this membership" +
    " authorizes nothing",
  secondary:
    "so it resolves to no grant and adds nothing to what the rest of this membership authorizes",
};

/**
 * The primary's cost on an **empty** catalog, which is not the same sentence.
 *
 * `NOT_DECLARED_COST.primary` qualifies the denial with *unless a declared secondary role carries
 * one* — true wherever a catalog has names in it, and self-contradictory where it has none: if the
 * manifest declares no role at all then no secondary can be declared either, so the qualifier
 * offers a possibility the same clause has just ruled out.
 *
 * Found by review, and the review is also where the cause is: sharing one map across both branches
 * was the fix for *two sentence builders stating one difference inconsistently*, and it produced
 * the inconsistency one axis across, because only the non-empty branch wanted the qualifier. The
 * axis is `(position, catalogEmpty)` and not `position`, so the second axis is written down rather
 * than folded into the first. The secondary's cost needs no variant: *adds nothing to what the
 * rest of this membership authorizes* is true whatever the catalog holds.
 *
 * `RoleWarnings.tsx` carried the unqualified sentence for this branch all along, which is how the
 * disagreement was visible: the server's `detail` lands in the 201 body and in the audit row, and
 * the console's copy said something else about the same fact.
 */
const NOT_DECLARED_COST_EMPTY_CATALOG =
  "so it resolves to no grant and, with no role declared for a secondary to carry either, this" +
  " membership authorizes nothing";

/** The same difference where nothing was read: what is *unknown* is per position too. */
const UNRESOLVED_COST: Readonly<Record<MembershipRolePosition, string>> = {
  primary: "so whether this membership authorizes anything is unknown",
  secondary: "so whether it adds anything to this membership is unknown",
};

function unresolvedDetail(position: MembershipRolePosition, role: string): string {
  // No remedy in either position, because none is known: nothing was read, so the grant may well be
  // correct. Naming the role catalog here would be naming a catalog this call could not see. That
  // is the one argument ADR-0369 leaves standing for withholding the names from a secondary.
  return (
    `${position} role '${role}' was not checked: this deployment cannot say which roles the` +
    ` tenant's manifest declares, ${UNRESOLVED_COST[position]}`
  );
}

/** `declared` is non-nullable: a `not_declared` verdict is only reachable from a read catalog. */
function notDeclaredDetail(
  position: MembershipRolePosition,
  role: string,
  declared: readonly string[],
): string {
  // The empty catalog gets no remedy in **either** position, for the reason the `unresolved` case
  // does not: there is no declared name to re-grant with, and making the manifest declare one is
  // not an act available at a grant. A sentence offering "one of the declared roles" would name an
  // empty list.
  if (declared.length === 0) {
    const cost =
      position === "primary" ? NOT_DECLARED_COST_EMPTY_CATALOG : NOT_DECLARED_COST[position];
    return (
      `${position} role '${role}' is not declared by this tenant's manifest, which declares no` +
      ` role at all, ${cost}`
    );
  }
  return (
    `${position} role '${role}' is not declared by this tenant's manifest,` +
    ` ${NOT_DECLARED_COST[position]}; the roles a session can carry are ${nameSome(declared)}`
  );
}

/**
 * One role's warning, or `null` where it produces none.
 *
 * Exact membership, never trimmed or case-folded: `resolveEffectiveRoles` looks the role up in a
 * `Map` keyed by the manifest's own names, so a name differing by a space or a capital is a
 * different role there. Normalising here would make the fence agree with a comparison nothing
 * performs and pass a grant the runtime then denies.
 */
function warningFor(
  position: MembershipRolePosition,
  role: string,
  catalog: RoleCatalog,
): MembershipRoleWarning | null {
  if (!catalog.read) {
    const verdict = warningVerdictOf("unresolved");
    return verdict === null
      ? null
      : { position, role, verdict, detail: unresolvedDetail(position, role), declaredRoles: null };
  }
  if (catalog.declares.has(role)) return null;
  const verdict = warningVerdictOf("not_declared");
  return verdict === null
    ? null
    : {
        position,
        role,
        verdict,
        detail: notDeclaredDetail(position, role, catalog.names),
        declaredRoles: catalog.names,
      };
}

async function readCatalog(
  tenantId: string,
  directory: MembershipRoleDirectory,
): Promise<RoleCatalog> {
  let declares: ReadonlySet<string> | null;
  try {
    declares = await directory(tenantId);
  } catch {
    // A throw and a `null` are the same fact here — nobody looked. The fence is advisory and rides
    // a privileged write, so an unreadable role catalog must not turn a correct grant into a 500.
    declares = null;
  }
  if (declares === null) return { read: false };
  // Sorted once per check, not per warning: every `not_declared` warning in one check describes the
  // same catalog, and a Set's iteration order follows how the manifest was built, so sorting is
  // what makes the line comparable between two boots.
  return { read: true, declares, names: [...declares].sort() };
}

/**
 * Every role this grant names that the tenant's manifest does not declare, or that could not be
 * checked. Empty means every named role is declared.
 *
 * The directory is consulted **once**, before any role is classified. Two calls could answer
 * differently — a manifest can be activated between them — and a warning set drawn from two
 * answers would be about no single manifest, so the `declaredRoles` it reports would belong to
 * neither. `readCatalog` carries the rest of that read, including why a throw is not propagated.
 *
 * Warnings come out in input order, primary first, and a role named twice warns once. The first
 * occurrence is what survives, which puts a role named as both primary and secondary at the
 * `primary` position — the consequential one, since that is the position a session reads.
 */
export async function checkMembershipRoles(
  input: MembershipRoleCheckInput,
  directory: MembershipRoleDirectory,
): Promise<readonly MembershipRoleWarning[]> {
  const catalog = await readCatalog(input.tenantId, directory);

  const warnings: MembershipRoleWarning[] = [];
  const seen = new Set<string>();
  const positions: readonly (readonly [MembershipRolePosition, string])[] = [
    ["primary", input.primaryRole],
    ...input.secondaryRoles.map(
      (role): readonly [MembershipRolePosition, string] => ["secondary", role],
    ),
  ];
  for (const [position, role] of positions) {
    if (seen.has(role)) continue;
    seen.add(role);
    const warning = warningFor(position, role, catalog);
    if (warning !== null) warnings.push(warning);
  }
  return warnings;
}

/**
 * One line per warning, for a log or an audit detail. Never includes a remedy that cannot work.
 *
 * An empty list renders as the empty string rather than an affirmative "all roles declared" line.
 * That is the opposite of the boot surveys' rule, and for a stated reason: those say the clean case
 * out loud because a boot log's silence cannot be told from a survey that did not run, whereas this
 * runs per grant and its caller holds the array — it can already tell empty from unresolved, and an
 * affirmative line would be one log entry per membership granted.
 */
export function formatMembershipRoleWarnings(ws: readonly MembershipRoleWarning[]): string {
  return ws.map((w) => `[membership] ${w.verdict}: ${w.detail}`).join("\n");
}
