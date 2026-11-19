import { describe, expect, it } from "vitest";

import { parseServeArgs } from "./cli.js";
import {
  ROLE_OPTION_IS_PLATFORM_AUTHORITY,
  escalatingRoles,
  platformAuthorityRoles,
} from "./platform-authority.js";

describe("escalatingRoles", () => {
  const authority = new Set(["platform_admin", "deletion_verifier"]);

  it("names a platform role the granter does not hold, sorted and once", () => {
    expect(
      escalatingRoles({
        granterRoles: ["user_admin"],
        grantedRoles: ["platform_admin", "erp_admin", "deletion_verifier", "platform_admin"],
        authorityRoles: authority,
      }),
    ).toEqual(["deletion_verifier", "platform_admin"]);
  });

  it("admits a platform role the granter holds, and any role outside the authority set", () => {
    expect(
      escalatingRoles({
        granterRoles: ["user_admin", "platform_admin"],
        grantedRoles: ["platform_admin", "erp_admin"],
        authorityRoles: authority,
      }),
    ).toEqual([]);
  });
});

describe("platformAuthorityRoles", () => {
  it("collects the platform-scoped flags and leaves the tenant-scoped ones out", () => {
    const options = parseServeArgs([
      "--pack",
      "erp-core",
      "--store",
      "pg",
      "--platform-user-routes",
      "--platform-user-role",
      "user_admin",
      "--admin-role",
      "erp_admin",
    ]);
    const roles = platformAuthorityRoles(options);
    expect(roles.has("user_admin")).toBe(true);
    // `--admin-role` governs a tenant's own settings, which its own manifest roles reach anyway.
    expect(roles.has("erp_admin")).toBe(false);
  });

  it("has an answer for every role-list option the CLI produces", () => {
    const options = parseServeArgs(["--pack", "erp-core"]) as unknown as Record<string, unknown>;
    const roleLists = Object.keys(options).filter(
      (k) => k.endsWith("Roles") && Array.isArray(options[k]),
    );
    expect(roleLists.sort()).toEqual(Object.keys(ROLE_OPTION_IS_PLATFORM_AUTHORITY).sort());
  });
});
