import { describe, expect, it, vi } from "vitest";
import type { PostgresKeyRegistry } from "@crossengin/crypto-pg";

import { keyRegistryResolver } from "./chain-verify.js";

const FP = "a".repeat(64);
const PUB = "cHVibGljLWtleS1iYXNlNjQ=";

/** A structural stand-in for PostgresKeyRegistry — only getByFingerprint is exercised by the resolver. */
function fakeRegistry(
  byFp: Record<string, { publicKeyBase64: string | null }>,
  spy?: (fp: string) => void,
): PostgresKeyRegistry {
  return {
    getByFingerprint: async (fp: string) => {
      spy?.(fp);
      return byFp[fp] ?? null;
    },
  } as unknown as PostgresKeyRegistry;
}

describe("keyRegistryResolver", () => {
  it("resolves a known fingerprint to its registered public key", async () => {
    const resolver = keyRegistryResolver(fakeRegistry({ [FP]: { publicKeyBase64: PUB } }));
    expect(await resolver.resolveByFingerprint(FP)).toBe(PUB);
  });

  it("returns null for an unknown fingerprint", async () => {
    const resolver = keyRegistryResolver(fakeRegistry({}));
    expect(await resolver.resolveByFingerprint(FP)).toBeNull();
  });

  it("returns null when a registered key has no public material", async () => {
    const resolver = keyRegistryResolver(fakeRegistry({ [FP]: { publicKeyBase64: null } }));
    expect(await resolver.resolveByFingerprint(FP)).toBeNull();
  });

  it("delegates to the registry's getByFingerprint", async () => {
    const spy = vi.fn();
    const resolver = keyRegistryResolver(fakeRegistry({ [FP]: { publicKeyBase64: PUB } }, spy));
    await resolver.resolveByFingerprint(FP);
    expect(spy).toHaveBeenCalledWith(FP);
  });
});
