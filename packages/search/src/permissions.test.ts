import { describe, expect, it } from "vitest";
import {
  deriveSessionTags,
  formatPermissionTag,
  isAuthorizedForResource,
  parsePermissionTag,
  PermissionTagSchema,
  typesenseFilterExpression,
} from "./permissions.js";

describe("PermissionTagSchema", () => {
  it("accepts role:pharmacist", () => {
    expect(PermissionTagSchema.parse("role:pharmacist")).toBe("role:pharmacist");
  });

  it("accepts scope:store/5", () => {
    expect(() => PermissionTagSchema.parse("store:branch-04")).not.toThrow();
  });

  it("rejects missing colon", () => {
    expect(() => PermissionTagSchema.parse("rolepharmacist")).toThrow();
  });

  it("rejects uppercase key", () => {
    expect(() => PermissionTagSchema.parse("Role:x")).toThrow();
  });
});

describe("parsePermissionTag / formatPermissionTag", () => {
  it("round-trips", () => {
    const tag = formatPermissionTag("role", "pharmacist");
    expect(parsePermissionTag(tag)).toEqual({ key: "role", value: "pharmacist" });
  });

  it("throws on invalid tags", () => {
    expect(() => parsePermissionTag("bad")).toThrow();
  });
});

describe("deriveSessionTags", () => {
  it("derives role + secondary role + abac tags", () => {
    const tags = deriveSessionTags({
      role: "pharmacist",
      secondaryRoles: ["auditor"],
      abacAttributes: { store: "branch-04", region: "dubai" },
    });
    expect(tags.sort()).toEqual([
      "region:dubai",
      "role:auditor",
      "role:pharmacist",
      "store:branch-04",
    ]);
  });

  it("handles a principal with no extras", () => {
    const tags = deriveSessionTags({ role: "manager" });
    expect(tags).toEqual(["role:manager"]);
  });
});

describe("isAuthorizedForResource", () => {
  it("approves when role overlaps", () => {
    expect(
      isAuthorizedForResource({
        sessionTags: ["role:pharmacist"],
        resourceTags: ["role:pharmacist", "role:auditor"],
      }),
    ).toBe(true);
  });

  it("rejects when no role overlap", () => {
    expect(
      isAuthorizedForResource({
        sessionTags: ["role:technician"],
        resourceTags: ["role:pharmacist"],
      }),
    ).toBe(false);
  });

  it("requireAll enforces scope match (e.g., store)", () => {
    expect(
      isAuthorizedForResource({
        sessionTags: ["role:manager", "store:branch-04"],
        resourceTags: ["role:manager", "store:branch-04"],
        requireAll: ["store"],
      }),
    ).toBe(true);

    expect(
      isAuthorizedForResource({
        sessionTags: ["role:manager", "store:branch-04"],
        resourceTags: ["role:manager", "store:branch-99"],
        requireAll: ["store"],
      }),
    ).toBe(false);
  });

  it("approves when resource declares no role constraints", () => {
    expect(
      isAuthorizedForResource({
        sessionTags: ["role:pharmacist"],
        resourceTags: ["store:branch-04"],
      }),
    ).toBe(true);
  });
});

describe("typesenseFilterExpression", () => {
  it("emits filter_by-friendly syntax", () => {
    const expr = typesenseFilterExpression(["role:pharmacist", "store:branch-04"]);
    expect(expr).toContain("permission_tags:=");
    expect(expr).toContain("role:pharmacist");
    expect(expr).toContain("store:branch-04");
  });

  it("returns the wildcard for empty session", () => {
    expect(typesenseFilterExpression([])).toBe("permission_tags:=*");
  });
});
