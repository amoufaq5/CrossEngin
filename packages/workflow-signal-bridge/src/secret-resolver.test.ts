import { describe, expect, it } from "vitest";

import { StaticSecretResolver } from "./secret-resolver.js";

const SECRET_A = new Uint8Array(32).fill(0xaa);
const SECRET_B = new Uint8Array(32).fill(0xbb);
const TENANT = "00000000-0000-4000-8000-000000000001";

describe("StaticSecretResolver", () => {
  it("returns null when no entry matches", async () => {
    const r = new StaticSecretResolver([]);
    expect(
      await r.resolve({ tenantId: TENANT, sourceSystem: "stripe", hint: null }),
    ).toBeNull();
  });

  it("matches an entry that has tenantId=null (platform-wide)", async () => {
    const r = new StaticSecretResolver([
      { tenantId: null, sourceSystem: null, secretBytes: SECRET_A },
    ]);
    const result = await r.resolve({ tenantId: TENANT, sourceSystem: "stripe", hint: null });
    expect(result?.secretBytes).toBe(SECRET_A);
    expect(result?.toleranceSeconds).toBe(300);
  });

  it("filters by tenantId when entry tenantId is set", async () => {
    const r = new StaticSecretResolver([
      { tenantId: TENANT, sourceSystem: null, secretBytes: SECRET_A },
    ]);
    expect(
      await r.resolve({
        tenantId: "00000000-0000-4000-8000-000000000002",
        sourceSystem: null,
        hint: null,
      }),
    ).toBeNull();
  });

  it("filters by sourceSystem when entry sourceSystem is set", async () => {
    const r = new StaticSecretResolver([
      { tenantId: null, sourceSystem: "stripe", secretBytes: SECRET_A },
      { tenantId: null, sourceSystem: "shopify", secretBytes: SECRET_B },
    ]);
    expect(
      (await r.resolve({ tenantId: TENANT, sourceSystem: "stripe", hint: null }))?.secretBytes,
    ).toBe(SECRET_A);
    expect(
      (await r.resolve({ tenantId: TENANT, sourceSystem: "shopify", hint: null }))?.secretBytes,
    ).toBe(SECRET_B);
  });

  it("respects per-entry toleranceSeconds override", async () => {
    const r = new StaticSecretResolver(
      [{ tenantId: null, sourceSystem: null, secretBytes: SECRET_A, toleranceSeconds: 60 }],
      { defaultToleranceSeconds: 300 },
    );
    const result = await r.resolve({ tenantId: null, sourceSystem: null, hint: null });
    expect(result?.toleranceSeconds).toBe(60);
  });

  it("falls back to defaultToleranceSeconds when entry omits it", async () => {
    const r = new StaticSecretResolver(
      [{ tenantId: null, sourceSystem: null, secretBytes: SECRET_A }],
      { defaultToleranceSeconds: 120 },
    );
    const result = await r.resolve({ tenantId: null, sourceSystem: null, hint: null });
    expect(result?.toleranceSeconds).toBe(120);
  });

  it("returns the first matching entry when multiple could match", async () => {
    const r = new StaticSecretResolver([
      { tenantId: null, sourceSystem: null, secretBytes: SECRET_A },
      { tenantId: null, sourceSystem: null, secretBytes: SECRET_B },
    ]);
    expect(
      (await r.resolve({ tenantId: null, sourceSystem: null, hint: null }))?.secretBytes,
    ).toBe(SECRET_A);
  });
});
