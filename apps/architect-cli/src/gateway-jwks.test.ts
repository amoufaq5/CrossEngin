import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  JwksLoadError,
  buildJwksProvider,
  loadJwksFromFile,
  resolveJwtFlags,
} from "./gateway-jwks.js";

async function withTempFile<T>(
  name: string,
  contents: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jwks-"));
  const path = join(dir, name);
  await writeFile(path, contents, "utf8");
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildJwksProvider", () => {
  it("accepts a valid {keys: [{kid, publicKeyBase64}]} object", () => {
    const provider = buildJwksProvider(
      { keys: [{ kid: "k1", publicKeyBase64: "MCowBQYDK2VwAyEA" }] },
      "test",
    );
    expect(provider.getPublicKeyForKid).toBeDefined();
  });

  it("returns a provider that looks up keys by kid", async () => {
    const provider = buildJwksProvider(
      {
        keys: [
          { kid: "k1", publicKeyBase64: "AAAA" },
          { kid: "k2", publicKeyBase64: "BBBB" },
        ],
      },
      "test",
    );
    expect(await provider.getPublicKeyForKid("k1")).toBe("AAAA");
    expect(await provider.getPublicKeyForKid("k2")).toBe("BBBB");
    expect(await provider.getPublicKeyForKid("nonexistent")).toBeNull();
  });

  it("rejects non-object inputs", () => {
    expect(() => buildJwksProvider(null, "test")).toThrow(JwksLoadError);
    expect(() => buildJwksProvider("not-an-object", "test")).toThrow(JwksLoadError);
    expect(() => buildJwksProvider(42, "test")).toThrow(JwksLoadError);
  });

  it("rejects missing keys array", () => {
    expect(() => buildJwksProvider({}, "test")).toThrow(JwksLoadError);
  });

  it("rejects empty keys array", () => {
    expect(() => buildJwksProvider({ keys: [] }, "test")).toThrow(JwksLoadError);
  });

  it("rejects key entries that aren't objects", () => {
    expect(() => buildJwksProvider({ keys: ["k1"] }, "test")).toThrow(JwksLoadError);
  });

  it("rejects key entries with missing kid", () => {
    expect(() =>
      buildJwksProvider({ keys: [{ publicKeyBase64: "x" }] }, "test"),
    ).toThrow(JwksLoadError);
  });

  it("rejects key entries with empty kid", () => {
    expect(() =>
      buildJwksProvider(
        { keys: [{ kid: "", publicKeyBase64: "x" }] },
        "test",
      ),
    ).toThrow(JwksLoadError);
  });

  it("rejects key entries with missing publicKeyBase64", () => {
    expect(() => buildJwksProvider({ keys: [{ kid: "k1" }] }, "test")).toThrow(
      JwksLoadError,
    );
  });
});

describe("loadJwksFromFile", () => {
  it("loads valid JWKS JSON from disk", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({
        keys: [{ kid: "k1", publicKeyBase64: "abc" }],
      }),
      async (path) => {
        const provider = await loadJwksFromFile(path);
        expect(await provider.getPublicKeyForKid("k1")).toBe("abc");
      },
    );
  });

  it("throws JwksLoadError when the file is missing", async () => {
    await expect(loadJwksFromFile("/nonexistent/jwks.json")).rejects.toThrow(
      JwksLoadError,
    );
  });

  it("throws JwksLoadError when the file is not valid JSON", async () => {
    await withTempFile("jwks.json", "not json", async (path) => {
      await expect(loadJwksFromFile(path)).rejects.toThrow(JwksLoadError);
    });
  });

  it("throws JwksLoadError when JSON schema is wrong", async () => {
    await withTempFile("jwks.json", JSON.stringify({ foo: "bar" }), async (path) => {
      await expect(loadJwksFromFile(path)).rejects.toThrow(JwksLoadError);
    });
  });
});

describe("resolveJwtFlags", () => {
  it("returns empty options when no JWKS flag is set", async () => {
    const result = await resolveJwtFlags({
      jwksFile: null,
      jwtIssuer: null,
      jwtAudience: null,
      clockSkewSeconds: null,
    });
    expect(result).toEqual({});
  });

  it("rejects JWT options without --jwks-file", async () => {
    await expect(
      resolveJwtFlags({
        jwksFile: null,
        jwtIssuer: "https://issuer.example",
        jwtAudience: null,
        clockSkewSeconds: null,
      }),
    ).rejects.toThrow(JwksLoadError);
  });

  it("requires --jwt-issuer when --jwks-file is set", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
      async (path) => {
        await expect(
          resolveJwtFlags({
            jwksFile: path,
            jwtIssuer: null,
            jwtAudience: "https://aud.example",
            clockSkewSeconds: null,
          }),
        ).rejects.toThrow(JwksLoadError);
      },
    );
  });

  it("requires --jwt-audience when --jwks-file is set", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
      async (path) => {
        await expect(
          resolveJwtFlags({
            jwksFile: path,
            jwtIssuer: "https://issuer.example",
            jwtAudience: null,
            clockSkewSeconds: null,
          }),
        ).rejects.toThrow(JwksLoadError);
      },
    );
  });

  it("returns provider + issuer + audience for the full flag set", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
      async (path) => {
        const result = await resolveJwtFlags({
          jwksFile: path,
          jwtIssuer: "https://issuer.example",
          jwtAudience: "https://aud.example",
          clockSkewSeconds: null,
        });
        expect(result.jwksProvider).toBeDefined();
        expect(result.jwtIssuer).toBe("https://issuer.example");
        expect(result.jwtAudience).toBe("https://aud.example");
        expect(result.clockSkewSeconds).toBeUndefined();
      },
    );
  });

  it("parses --clock-skew-seconds when valid", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
      async (path) => {
        const result = await resolveJwtFlags({
          jwksFile: path,
          jwtIssuer: "https://issuer.example",
          jwtAudience: "https://aud.example",
          clockSkewSeconds: "60",
        });
        expect(result.clockSkewSeconds).toBe(60);
      },
    );
  });

  it("rejects --clock-skew-seconds outside [0, 600]", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
      async (path) => {
        for (const bad of ["-1", "601", "not-a-number"]) {
          await expect(
            resolveJwtFlags({
              jwksFile: path,
              jwtIssuer: "https://issuer.example",
              jwtAudience: "https://aud.example",
              clockSkewSeconds: bad,
            }),
          ).rejects.toThrow(JwksLoadError);
        }
      },
    );
  });
});
