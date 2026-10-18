import type { IncomingRequest } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import {
  ANONYMOUS_ROLE,
  buildPrincipalWiring,
  formatScopeRoleReading,
  parseApiKeySpec,
  principalRolesFromScopes,
} from "./principals.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const fakeReq = {} as IncomingRequest;

describe("parseApiKeySpec", () => {
  it("parses key:role:tenant with a default principalId", () => {
    const spec = parseApiKeySpec(`k1:cashier:${TENANT}`);
    expect(spec).toMatchObject({ key: "k1", role: "cashier", tenantId: TENANT });
    expect(spec.principalId).toMatch(/^[0-9a-f-]+$/);
  });

  it("parses an explicit principalId", () => {
    const spec = parseApiKeySpec(`k1:cashier:${TENANT}:00000000-0000-4000-8000-0000000000bb`);
    expect(spec.principalId).toBe("00000000-0000-4000-8000-0000000000bb");
  });

  it("rejects a malformed spec", () => {
    expect(() => parseApiKeySpec("k1:cashier")).toThrow(/invalid --api-key/);
    expect(() => parseApiKeySpec("::")).toThrow(/empty field/);
  });

  it("records whether the principal was named, rather than leaving it to be guessed", () => {
    // Not derivable by comparing against the placeholder: a spec may name that very UUID, and then
    // it means a real provisioned user who holds it.
    expect(parseApiKeySpec(`k1:cashier:${TENANT}`).namesPrincipal).toBe(false);
    expect(parseApiKeySpec(`k1:cashier:${TENANT}:00000000-0000-4000-8000-0000000000bb`).namesPrincipal).toBe(true);
    expect(parseApiKeySpec(`k1:cashier:${TENANT}:00000000-0000-4000-8000-0000000000aa`).namesPrincipal).toBe(true);
  });

  it("shares one principal id across every unnamed key, which is why the kind must say so", () => {
    // The collision is not fixable in the spec — a bare `key:role:tenant` does not carry the
    // information to tell two keys apart, and the one thing that would is the credential itself,
    // which must not be hashed into an id that lands in the audit log.
    const a = parseApiKeySpec(`k1:cashier:${TENANT}`);
    const b = parseApiKeySpec(`k2:manager:${TENANT}`);
    expect(a.principalId).toBe(b.principalId);
    expect([a.namesPrincipal, b.namesPrincipal]).toEqual([false, false]);
  });
});

describe("buildPrincipalWiring", () => {
  const wiring = buildPrincipalWiring([parseApiKeySpec(`k1:cashier:${TENANT}`)], {
    now: () => new Date("2026-06-03T12:00:00.000Z"),
  });

  it("looks up a known token to its principal ref + scopes + tenant", async () => {
    const result = await wiring.opaqueTokenLookup.lookup(fakeReq, "k1");
    expect(result).toEqual({ principalRef: "k1", scopes: ["cashier"], tenantId: TENANT });
  });

  it("returns null for an unknown token (fail-closed)", async () => {
    expect(await wiring.opaqueTokenLookup.lookup(fakeReq, "nope")).toBeNull();
  });

  it("resolves the ref to a ResolvedPrincipal", async () => {
    const principal = await wiring.principalResolver.resolve({ principalRef: "k1" } as never);
    expect(principal).toMatchObject({ tenantId: TENANT, grantedScopes: ["cashier"], authScheme: "api_key_header" });
  });

  it("bridges scopes to the primary role AND the secondary list", () => {
    // This asserted `{primaryRole: "cashier"}` alone until ADR-0369 — the reader half of the
    // defect, with no `secondaryRoles` key at all, so the 26 non-test readers that spread
    // `...(secondaryRoles ?? [])` took the empty arm however many scopes a token carried.
    expect(wiring.principalRoles({ grantedScopes: ["cashier"] } as never)).toEqual({
      primaryRole: "cashier",
      secondaryRoles: [],
    });
    expect(wiring.principalRoles({ grantedScopes: ["cashier", "auditor"] } as never)).toEqual({
      primaryRole: "cashier",
      secondaryRoles: ["auditor"],
    });
    expect(wiring.principalRoles(null)).toEqual({ primaryRole: "anonymous", secondaryRoles: [] });
  });

  it("gives an api-key the one role its spec names, which is the family's limit", () => {
    // `key:role:tenant[:principalId]` carries one role and the resolver registers
    // `grantedScopes: [spec.role]`, so a key holds exactly one however the reader is written. A
    // key names no person, so there is no membership to read a list from; a deployment wanting two
    // roles on one key declares an inheriting role in the manifest, which is a remedy that works.
    expect(wiring.principalRoles({ grantedScopes: ["cashier"] } as never).secondaryRoles).toEqual(
      [],
    );
  });

  it("resolves an unnamed key as a service account, not as a user", async () => {
    // One line, three defects downstream. As `user` it satisfied every per-person surface's guard,
    // and the placeholder is not in `meta.users`: `notification_read_states.user_id` failed its
    // foreign key (reported as a 503 for something permanent) and `actorForInstanceCancel` would
    // have handed the id to `cancelled_by_user_id`, which has the same key. And since the id is
    // shared, two keys in one tenant would have shared read state.
    const principal = await wiring.principalResolver.resolve({ principalRef: "k1" } as never);
    expect(principal?.principalKind).toBe("service_account");
  });

  it("still resolves a key that names its principal as a user", async () => {
    const named = buildPrincipalWiring(
      [parseApiKeySpec(`k9:cashier:${TENANT}:00000000-0000-4000-8000-0000000000bb`)],
      { now: () => new Date("2026-06-03T12:00:00.000Z") },
    );
    const principal = await named.principalResolver.resolve({ principalRef: "k9" } as never);
    expect(principal).toMatchObject({
      principalKind: "user",
      principalId: "00000000-0000-4000-8000-0000000000bb",
    });
  });
});

describe("principalRolesFromScopes", () => {
  it("is total and uninterpreting: it reports what the credential carries", () => {
    // No de-duplication, no filtering of names the manifest does not declare, no case folding.
    // Deciding what a role *means* belongs to `resolveEffectiveRoles` and to the gates, each of
    // which already fails closed on a name it does not know. A reader that silently dropped an
    // undeclared scope would make the fence that reports it unreachable.
    expect(principalRolesFromScopes(["a", "a", "GHOST", "b"])).toEqual({
      primaryRole: "a",
      secondaryRoles: ["a", "GHOST", "b"],
    });
  });

  it("answers the anonymous sentinel for no scopes, with an empty tail", () => {
    expect(principalRolesFromScopes([])).toEqual({
      primaryRole: ANONYMOUS_ROLE,
      secondaryRoles: [],
    });
  });
});

describe("formatScopeRoleReading", () => {
  it("says nothing when no JWT path is configured", () => {
    // An api-key-only deployment reads one scope and always did, so there is no change to report
    // and no survey to run. Deliberately not an affirmative line: a census of which memberships
    // grant a secondary role is the unscoped read ADR-0365 refused by measurement.
    expect(formatScopeRoleReading({ credentialLogin: false, externalJwks: false })).toBeNull();
  });

  it("names the membership's list for a deployment that mints its own tokens", () => {
    const read = formatScopeRoleReading({ credentialLogin: true, externalJwks: false });
    expect(read?.message).toContain("every role its membership grants");
    expect(read?.message).toContain("primary role first");
    // Not a warning: this clause is the capability, not the widening.
    expect(read?.level).toBe("info");
  });

  it("names the one behaviour change for a deployment trusting a foreign token", () => {
    // The increment's only change on a configuration that worked before it: such a token had its
    // first scope read as the role and the rest ignored. Reported, never refused — a refusal would
    // refuse a deployment that works, and an undeclared scope grants nothing anywhere.
    const read = formatScopeRoleReading({ credentialLogin: false, externalJwks: true });
    expect(read?.message).toContain("did not mint");
    expect(read?.message).toContain("scopes past the FIRST");
    // The stake, which the first draft of this line got wrong in the reassuring direction: the
    // platform gates test CLI-supplied role sets and `platform_admin` is not a manifest role, so
    // the dangerous case is the one the old reasoning called safe.
    expect(read?.message).toContain("--platform-admin-role");
    expect(read?.level).toBe("warn");
  });

  it("says both when both are configured, because both are true", () => {
    // Reachable: `--credential-login` refuses `--jwks-url` at parse, so the combination is this
    // deployment's own key beside a foreign `--jwks-key`/`--jwks-file` entry.
    const read = formatScopeRoleReading({ credentialLogin: true, externalJwks: true });
    expect(read?.message).toContain("every role its membership grants");
    expect(read?.message).toContain("did not mint");
    // The widening decides the level wherever it is present.
    expect(read?.level).toBe("warn");
  });
});
