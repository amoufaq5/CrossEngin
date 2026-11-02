import { describe, expect, it } from "vitest";

import { formatAdminGrant } from "./admin-grant.js";

const SEVEN_PACK_ROLES = new Set(["erp_admin", "hr_manager", "ap_clerk", "erp_viewer"]);

describe("formatAdminGrant", () => {
  it("names the granted roles, so the grant is discoverable from the log", () => {
    // The whole defect was a silence: this was the one grant in the binary with no boot line, so an
    // operator's first signal that only `erp_admin` reaches the settings routes was a 403.
    const line = formatAdminGrant({
      adminRoles: ["erp_admin"],
      manifestRoleNames: SEVEN_PACK_ROLES,
    });
    expect(line.level).toBe("info");
    expect(line.message).toContain("erp_admin");
    expect(line.message).toContain("/v1/admin/settings");
  });

  it("says a declared role the manifest does not define is legitimate, not a typo", () => {
    // This is the clause that inverts the `[sensitive]` line one grant over, and the one a reader
    // is most likely to get backwards. There an undeclared grantee is INERT, because every field
    // predicate wraps `resolveEffectiveRoles` and answers false for an undeclared name. Here the
    // check is a bare set membership over the roles the *session* carries, which come from the
    // membership rather than from the manifest — so the role works.
    const line = formatAdminGrant({
      adminRoles: ["erp_admin", "platform_admin"],
      manifestRoleNames: SEVEN_PACK_ROLES,
    });
    expect(line.level).toBe("info");
    expect(line.message).toContain("platform_admin");
    expect(line.message).toMatch(/legitimate here and not a typo/);
    // And it must name the mechanism, because "trust me" is not a remedy: the operator needs to
    // know the role has to come from a membership.
    expect(line.message).toContain("membership");
  });

  it("does not call an undeclared role inert, which would be the opposite of true", () => {
    const line = formatAdminGrant({
      adminRoles: ["platform_admin"],
      manifestRoleNames: SEVEN_PACK_ROLES,
    });
    expect(line.message).not.toMatch(/grant(s)? nothing|inert|reaches nobody/);
  });

  it("says so plainly when every declared role IS a manifest role", () => {
    // The affirmative half: "we checked and found nothing" cannot be claimed from the absence of a
    // clause, so the clean case gets its own sentence rather than silence.
    const line = formatAdminGrant({
      adminRoles: ["erp_admin", "hr_manager"],
      manifestRoleNames: SEVEN_PACK_ROLES,
    });
    expect(line.message).toContain("every one is a role this manifest declares");
    expect(line.message).not.toMatch(/not declared by this manifest/);
  });

  it("warns, and only warns, when the grant reaches nobody at all", () => {
    // The one boot-decidable alarming state. `parseServeArgs` defaults the list, so this is
    // reachable from a direct `runServer` caller — and it is a surface that is mounted and usable
    // by no principal, which ADR-0334 calls worse than an absent one.
    const line = formatAdminGrant({ adminRoles: [], manifestRoleNames: SEVEN_PACK_ROLES });
    expect(line.level).toBe("warn");
    expect(line.message).toMatch(/NO role is granted/);
    expect(line.message).toContain("--admin-role");
  });

  it("de-duplicates a repeated role rather than printing it twice", () => {
    const line = formatAdminGrant({
      adminRoles: ["erp_admin", "erp_admin"],
      manifestRoleNames: SEVEN_PACK_ROLES,
    });
    expect(line.message.match(/erp_admin/g)).toHaveLength(1);
  });

  it("agrees in number with itself for one undeclared role and for two", () => {
    // A trivial-looking assertion that catches a real defect shape: the message pluralises, and a
    // line reading "1 of them (platform_admin) are not declared" is the kind of thing nobody reads
    // closely enough to notice while still reading as sloppy.
    const one = formatAdminGrant({
      adminRoles: ["ops"],
      manifestRoleNames: SEVEN_PACK_ROLES,
    }).message;
    const two = formatAdminGrant({
      adminRoles: ["ops", "sre"],
      manifestRoleNames: SEVEN_PACK_ROLES,
    }).message;
    expect(one).toContain("1 of them (ops) is not declared");
    expect(two).toContain("2 of them (ops, sre) are not declared");
  });

  it("states the two facts an operator cannot infer from the grant alone", () => {
    const line = formatAdminGrant({
      adminRoles: ["erp_admin"],
      manifestRoleNames: SEVEN_PACK_ROLES,
    }).message;
    // Fail-closed, with the body a caller actually gets, so a 403 in a log is recognisable.
    expect(line).toContain("admin role required");
    // And that these routes are outside the subscription gate by design — which is why a lapsed
    // tenant can still reach the page, and therefore why a 403 here is a dead end rather than a
    // billing problem.
    expect(line).toMatch(/subscription gate/);
  });
});
