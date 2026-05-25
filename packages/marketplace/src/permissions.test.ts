import { describe, expect, it } from "vitest";
import {
  GRANT_STATUSES,
  PermissionGrantSetSchema,
  ScopeGrantSchema,
  buildInitialGrantSet,
  canTransitionGrant,
  resolvePermissions,
  type ScopeGrant,
} from "./permissions.js";

describe("constants", () => {
  it("GRANT_STATUSES = pending|granted|denied|revoked", () => {
    expect(GRANT_STATUSES).toEqual(["pending", "granted", "denied", "revoked"]);
  });
});

describe("canTransitionGrant", () => {
  it("pending -> granted", () => {
    expect(canTransitionGrant("pending", "granted")).toBe(true);
  });

  it("granted -> revoked", () => {
    expect(canTransitionGrant("granted", "revoked")).toBe(true);
  });

  it("denied -> pending (re-request)", () => {
    expect(canTransitionGrant("denied", "pending")).toBe(true);
  });

  it("granted -> denied is not allowed (must revoke first)", () => {
    expect(canTransitionGrant("granted", "denied")).toBe(false);
  });
});

describe("ScopeGrantSchema", () => {
  const base: ScopeGrant = {
    scope: "tenants:read",
    status: "granted",
    grantedAt: "2026-05-14T10:00:00Z",
    grantedBy: "admin-1",
    deniedAt: null,
    revokedAt: null,
    revokedBy: null,
    optional: false,
  };

  it("accepts a valid granted record", () => {
    expect(() => ScopeGrantSchema.parse(base)).not.toThrow();
  });

  it("rejects granted without grantedAt", () => {
    expect(() => ScopeGrantSchema.parse({ ...base, grantedAt: null })).toThrow(/grantedAt/);
  });

  it("rejects granted without grantedBy", () => {
    expect(() => ScopeGrantSchema.parse({ ...base, grantedBy: null })).toThrow(/grantedBy/);
  });

  it("rejects denied without deniedReason", () => {
    expect(() =>
      ScopeGrantSchema.parse({
        ...base,
        status: "denied",
        grantedAt: null,
        grantedBy: null,
        deniedAt: "2026-05-14T10:00:00Z",
      }),
    ).toThrow(/deniedReason/);
  });

  it("rejects revoked without revokedBy", () => {
    expect(() =>
      ScopeGrantSchema.parse({
        ...base,
        status: "revoked",
        revokedAt: "2026-05-14T11:00:00Z",
      }),
    ).toThrow(/revokedBy/);
  });
});

describe("PermissionGrantSetSchema", () => {
  it("rejects duplicate scopes", () => {
    expect(() =>
      PermissionGrantSetSchema.parse([
        {
          scope: "tenants:read",
          status: "granted",
          grantedAt: "2026-05-14T10:00:00Z",
          grantedBy: "x",
          deniedAt: null,
          revokedAt: null,
          revokedBy: null,
          optional: false,
        },
        {
          scope: "tenants:read",
          status: "pending",
          grantedAt: null,
          grantedBy: null,
          deniedAt: null,
          revokedAt: null,
          revokedBy: null,
          optional: false,
        },
      ]),
    ).toThrow(/duplicate scope/);
  });
});

describe("resolvePermissions", () => {
  it("returns satisfied=true when all required granted", () => {
    const r = resolvePermissions({
      request: {
        requiredScopes: ["tenants:read"],
        optionalScopes: ["files:read"],
      },
      grants: [
        {
          scope: "tenants:read",
          status: "granted",
          grantedAt: "2026-05-14T10:00:00Z",
          grantedBy: "x",
          deniedAt: null,
          revokedAt: null,
          revokedBy: null,
          optional: false,
        },
      ],
    });
    expect(r.satisfied).toBe(true);
    expect(r.missingRequired).toEqual([]);
  });

  it("flags missing required scopes", () => {
    const r = resolvePermissions({
      request: {
        requiredScopes: ["tenants:read", "files:write"],
        optionalScopes: [],
      },
      grants: [],
    });
    expect(r.satisfied).toBe(false);
    expect(r.missingRequired).toEqual(["tenants:read", "files:write"]);
  });

  it("collects granted optional scopes", () => {
    const r = resolvePermissions({
      request: {
        requiredScopes: [],
        optionalScopes: ["files:read"],
      },
      grants: [
        {
          scope: "files:read",
          status: "granted",
          grantedAt: "2026-05-14T10:00:00Z",
          grantedBy: "x",
          deniedAt: null,
          revokedAt: null,
          revokedBy: null,
          optional: true,
        },
      ],
    });
    expect(r.satisfied).toBe(true);
    expect(r.grantedOptional).toEqual(["files:read"]);
  });

  it("collects pending scopes", () => {
    const r = resolvePermissions({
      request: {
        requiredScopes: ["tenants:read"],
        optionalScopes: [],
      },
      grants: [
        {
          scope: "tenants:read",
          status: "pending",
          grantedAt: null,
          grantedBy: null,
          deniedAt: null,
          revokedAt: null,
          revokedBy: null,
          optional: false,
        },
      ],
    });
    expect(r.satisfied).toBe(false);
    expect(r.pendingScopes).toEqual(["tenants:read"]);
  });
});

describe("buildInitialGrantSet", () => {
  it("creates pending grants for all requested scopes", () => {
    const grants = buildInitialGrantSet({
      requiredScopes: ["tenants:read"],
      optionalScopes: ["files:read"],
    });
    expect(grants).toHaveLength(2);
    expect(grants[0]?.status).toBe("pending");
    expect(grants[0]?.optional).toBe(false);
    expect(grants[1]?.optional).toBe(true);
  });
});
