/**
 * Which roles administer a tenant's own settings, said at boot.
 *
 * `/v1/admin/settings` is the one grant in this binary that had **no** boot line: every sibling
 * prints one (`[credential]`, `[preferences]`, `[read-state]`, `[platform]`), while the role that
 * reaches the settings routes was a hardcoded `["erp_admin"]` inside `compileOperateServer` that no
 * flag could name and nothing announced. So an operator could not discover the grant from the log,
 * and the first signal was a 403 on a page the sidebar links to unconditionally.
 */

/** A boot line and how loudly to say it. */
export interface AdminGrantReading {
  readonly message: string;
  readonly level: "info" | "warn";
}

/**
 * The boot line for the tenant-settings grant.
 *
 * **Info and never a warning, and that is a measurement rather than a preference.** The hazard
 * worth warning about would be a typo'd `--admin-role` leaving nobody able to reach the routes —
 * and the census that would detect it is the one ADR-0365 refused on measurement:
 * `meta.user_tenant_membership` carries one `ALL`-scope isolation policy and no platform read arm,
 * so a non-owner session with no tenant context reads **zero** rows and would report a clean
 * deployment because it could see nothing. There is no boot-decidable condition here to warn on,
 * so the line states the grant and lets the operator compare it against what they granted.
 *
 * A declared role the manifest does not define is **marked and not flagged**, which inverts the
 * sibling `[sensitive]` line one grant over and is the part a reader is most likely to get
 * backwards. There, an undeclared grantee is inert: every field predicate wraps
 * `resolveEffectiveRoles`, which answers false for a name the manifest has no entry for. Here the
 * check is `authorize`'s bare set membership over the roles the **session** carries, and those come
 * from the token's `scope` claim — i.e. from the membership (ADR-0369) — not from the manifest's
 * role map. `principals.ts`' own comment records the same correction for the platform gates:
 * *"the platform gates test CLI-supplied sets rather than the manifest's role map … `platform_admin`
 * is not one of `erp-core`'s fifteen declared roles."*
 *
 * So an undeclared value is legitimate and reachable, and `platform_admin` is the ordinary case:
 * it is what `deploy/.env.example` grants the bootstrap operator, it is declared by **none** of the
 * seven packs, and it is a correct thing to pass here. A refusal keyed on "undeclared" would refuse
 * the shipped compose's own correct configuration — which is why this reports.
 */
export function formatAdminGrant(opts: {
  readonly adminRoles: readonly string[];
  readonly manifestRoleNames: ReadonlySet<string>;
}): AdminGrantReading {
  const granted = [...new Set(opts.adminRoles)];
  if (granted.length === 0) {
    // Unreachable from `parseServeArgs`, which defaults the list to `["erp_admin"]`, so this arm is
    // for a direct `runServer` caller. It is the one genuinely alarming state: `authorize` answers
    // `""` for every principal, so the routes are mounted and reachable by nobody — a surface that
    // exists and cannot be used, which ADR-0334 calls worse than an absent one.
    return {
      level: "warn",
      message:
        "[settings] tenant settings: NO role is granted, so GET/PUT /v1/admin/settings answer 403" +
        " for every caller while staying mounted — the sidebar links to that page unconditionally." +
        " Declare at least one --admin-role",
    };
  }
  const undeclared = granted.filter((r) => !opts.manifestRoleNames.has(r));
  const declaredNote =
    undeclared.length === 0
      ? "every one is a role this manifest declares"
      : `${undeclared.length.toString()} of them (${undeclared.join(", ")}) ${
          undeclared.length === 1 ? "is" : "are"
        } not declared by this manifest, which is legitimate here and not a typo: the check is` +
        " against the roles a caller's session carries, which come from their membership rather" +
        " than from the manifest — platform_admin is the ordinary such value, and it is what" +
        " deploy/.env.example grants the bootstrap operator";
  return {
    level: "info",
    message:
      `[settings] tenant settings: GET/PUT /v1/admin/settings is granted to ${granted.join(", ")}` +
      ` — ${declaredNote}. Fail-closed: any other caller is 403 'admin role required'. These` +
      " routes are mounted on every deployment and deliberately outside the subscription gate, so" +
      " a lapsed tenant can still open its billing screen",
  };
}
