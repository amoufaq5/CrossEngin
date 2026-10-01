import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BOUNCE_SECRET_ENV_VAR,
  buildBounceSecretResolverFromEnv,
} from "./bounce-webhook-env.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("buildBounceSecretResolverFromEnv", () => {
  it("serves nothing when the secret is unset", () => {
    const { resolver, skipped } = buildBounceSecretResolverFromEnv({});
    expect(resolver).toBeNull();
    expect(skipped).toContain(BOUNCE_SECRET_ENV_VAR);
  });

  it("refuses a short secret rather than serving the route with it", () => {
    // Anyone who guesses it can silence a tenant's mail, so the route not existing is the safer
    // failure — a warning plus a live route would not be.
    const { resolver, skipped } = buildBounceSecretResolverFromEnv({
      [BOUNCE_SECRET_ENV_VAR]: "tooshort",
    });
    expect(resolver).toBeNull();
    expect(skipped).toContain("shorter than 32");
  });

  it("treats a whitespace-only secret as unset", () => {
    const { resolver } = buildBounceSecretResolverFromEnv({ [BOUNCE_SECRET_ENV_VAR]: "    " });
    expect(resolver).toBeNull();
  });

  it("derives the documented per-tenant key, so a signing edge can reproduce it", () => {
    // The derivation is the deployment contract: if this changes, every edge has to change with it.
    const { resolver } = buildBounceSecretResolverFromEnv({ [BOUNCE_SECRET_ENV_VAR]: SECRET });
    const expected = new Uint8Array(
      createHmac("sha256", Buffer.from(SECRET, "utf8"))
        .update(`bounce-webhook:${TENANT}`)
        .digest(),
    );
    expect(resolver?.(TENANT)).toEqual(expected);
  });

  it("gives two tenants different keys, so one tenant's signature cannot be replayed at another", () => {
    const { resolver } = buildBounceSecretResolverFromEnv({ [BOUNCE_SECRET_ENV_VAR]: SECRET });
    expect(resolver?.(TENANT)).not.toEqual(resolver?.(OTHER));
  });

  it("is stable across calls", () => {
    const { resolver } = buildBounceSecretResolverFromEnv({ [BOUNCE_SECRET_ENV_VAR]: SECRET });
    expect(resolver?.(TENANT)).toEqual(resolver?.(TENANT));
  });

  it("matches on case, so a differently-cased tenant id verifies the same", () => {
    const { resolver } = buildBounceSecretResolverFromEnv({ [BOUNCE_SECRET_ENV_VAR]: SECRET });
    expect(resolver?.(TENANT.toUpperCase())).toEqual(resolver?.(TENANT));
  });

  it("answers null for anything that is not a tenant id", () => {
    // A derived secret for a malformed id would make the route verify a request whose write must then
    // fail on the tenant foreign key — a 500 where a 401 is the truthful answer.
    const { resolver } = buildBounceSecretResolverFromEnv({ [BOUNCE_SECRET_ENV_VAR]: SECRET });
    for (const bad of ["", "not-a-uuid", "../../etc", `${TENANT} `, `${TENANT}x`]) {
      expect(resolver?.(bad), bad).toBeNull();
    }
  });

  it("returns 32 bytes, which is what an HMAC-SHA256 key should be", () => {
    const { resolver } = buildBounceSecretResolverFromEnv({ [BOUNCE_SECRET_ENV_VAR]: SECRET });
    expect(resolver?.(TENANT)?.byteLength).toBe(32);
  });
});
