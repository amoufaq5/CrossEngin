import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  JwksLoadError,
  RefreshableJwksProvider,
  base64UrlToBase64,
  buildJwksProvider,
  loadJwksFromFile,
  loadJwksFromUrl,
  normalizeJwksEntry,
  resolveJwtFlags,
  type FetchLike,
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

function makeFetch(opts: {
  status?: number;
  body?: string;
  throwError?: unknown;
  capture?: { url: string | null; init: Parameters<FetchLike>[1] };
}): FetchLike {
  return async (url, init) => {
    if (opts.capture !== undefined) {
      opts.capture.url = url;
      opts.capture.init = init;
    }
    if (opts.throwError !== undefined) throw opts.throwError;
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      text: async () => opts.body ?? "",
    };
  };
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

  it("rejects key entries with missing publicKeyBase64 + no RFC 7517 alternative", () => {
    expect(() => buildJwksProvider({ keys: [{ kid: "k1" }] }, "test")).toThrow(
      JwksLoadError,
    );
  });
});

describe("normalizeJwksEntry — RFC 7517 OKP/Ed25519 translation", () => {
  it("translates {kty: 'OKP', crv: 'Ed25519', x: <base64url>} into publicKeyBase64", () => {
    // 32 zero bytes, base64-encoded: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    // Same bytes as base64url with no padding: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    const entry = {
      kid: "k1",
      kty: "OKP",
      crv: "Ed25519",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const out = normalizeJwksEntry(entry, 0, "test");
    expect(out.kid).toBe("k1");
    expect(out.publicKeyBase64).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  });

  it("accepts alg=EdDSA on OKP/Ed25519 entries", () => {
    const entry = {
      kid: "k2",
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const out = normalizeJwksEntry(entry, 0, "test");
    expect(out.kid).toBe("k2");
  });

  it("rejects alg=RS256 (or anything non-EdDSA) on OKP entries", () => {
    expect(() =>
      normalizeJwksEntry(
        {
          kid: "k1",
          kty: "OKP",
          crv: "Ed25519",
          alg: "RS256",
          x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        0,
        "test",
      ),
    ).toThrow(JwksLoadError);
  });

  it("rejects OKP/Ed25519 entries missing the 'x' field", () => {
    expect(() =>
      normalizeJwksEntry({ kid: "k1", kty: "OKP", crv: "Ed25519" }, 0, "test"),
    ).toThrow(/no 'x' base64url field/);
  });

  it("rejects unsupported key types (RSA / EC)", () => {
    expect(() =>
      normalizeJwksEntry({ kid: "k1", kty: "RSA", n: "...", e: "AQAB" }, 0, "test"),
    ).toThrow(JwksLoadError);
    expect(() =>
      normalizeJwksEntry({ kid: "k1", kty: "EC", crv: "P-256", x: "...", y: "..." }, 0, "test"),
    ).toThrow(JwksLoadError);
  });

  it("CrossEngin-native publicKeyBase64 takes precedence over kty hints", () => {
    const out = normalizeJwksEntry(
      {
        kid: "k1",
        kty: "OKP",
        crv: "Ed25519",
        x: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
        publicKeyBase64: "NATIVE/BASE64==",
      },
      0,
      "test",
    );
    expect(out.publicKeyBase64).toBe("NATIVE/BASE64==");
  });
});

describe("base64UrlToBase64", () => {
  it("replaces - with +, _ with /, and pads to multiple of 4", () => {
    expect(base64UrlToBase64("ab")).toBe("ab==");
    expect(base64UrlToBase64("abc")).toBe("abc=");
    expect(base64UrlToBase64("abcd")).toBe("abcd");
    expect(base64UrlToBase64("a-b_c")).toBe("a+b/c===");
  });

  it("leaves valid base64 unchanged when no url-safe chars are present", () => {
    expect(base64UrlToBase64("AAAA")).toBe("AAAA");
  });
});

describe("loadJwksFromUrl", () => {
  it("fetches the URL, parses the JSON, and returns a provider", async () => {
    const capture = { url: null as string | null, init: undefined as Parameters<FetchLike>[1] };
    const provider = await loadJwksFromUrl("https://example.com/.well-known/jwks.json", {
      fetch: makeFetch({
        body: JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abcd" }] }),
        capture,
      }),
    });
    expect(capture.url).toBe("https://example.com/.well-known/jwks.json");
    expect(capture.init?.method).toBe("GET");
    expect(capture.init?.headers?.["accept"]).toBe("application/json");
    expect(await provider.getPublicKeyForKid("k1")).toBe("abcd");
  });

  it("throws JwksLoadError on non-2xx status", async () => {
    await expect(
      loadJwksFromUrl("https://example.com/jwks", {
        fetch: makeFetch({ status: 503, body: "service unavailable" }),
      }),
    ).rejects.toThrow(/returned status 503/);
  });

  it("throws JwksLoadError on non-JSON body", async () => {
    await expect(
      loadJwksFromUrl("https://example.com/jwks", {
        fetch: makeFetch({ status: 200, body: "<html>not json</html>" }),
      }),
    ).rejects.toThrow(/non-JSON body/);
  });

  it("throws JwksLoadError on network failure", async () => {
    await expect(
      loadJwksFromUrl("https://example.com/jwks", {
        fetch: makeFetch({ throwError: new Error("ECONNREFUSED") }),
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("translates AbortError into a timeout JwksLoadError", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(
      loadJwksFromUrl("https://example.com/jwks", {
        fetch: makeFetch({ throwError: abortErr }),
        timeoutMs: 1234,
      }),
    ).rejects.toThrow(/timed out after 1234ms/);
  });

  it("accepts RFC 7517 Ed25519 entries from a remote endpoint", async () => {
    const provider = await loadJwksFromUrl("https://example.com/jwks", {
      fetch: makeFetch({
        body: JSON.stringify({
          keys: [
            {
              kid: "k1",
              kty: "OKP",
              crv: "Ed25519",
              alg: "EdDSA",
              x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            },
          ],
        }),
      }),
    });
    expect(await provider.getPublicKeyForKid("k1")).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
  });
});

describe("RefreshableJwksProvider", () => {
  function buildProvider(keys: Array<{ kid: string; publicKeyBase64: string }>) {
    return buildJwksProvider({ keys }, "test");
  }

  it("delegates getPublicKeyForKid to the current inner provider", async () => {
    const r = new RefreshableJwksProvider({
      initial: buildProvider([{ kid: "k1", publicKeyBase64: "AAAA" }]),
      loader: async () => buildProvider([{ kid: "k2", publicKeyBase64: "BBBB" }]),
      source: "test",
    });
    expect(await r.getPublicKeyForKid("k1")).toBe("AAAA");
    expect(await r.getPublicKeyForKid("k2")).toBeNull();
  });

  it("refresh() atomically swaps in the new provider", async () => {
    const r = new RefreshableJwksProvider({
      initial: buildProvider([{ kid: "k1", publicKeyBase64: "AAAA" }]),
      loader: async () => buildProvider([{ kid: "k2", publicKeyBase64: "BBBB" }]),
      source: "test",
    });
    await r.refresh();
    expect(await r.getPublicKeyForKid("k1")).toBeNull();
    expect(await r.getPublicKeyForKid("k2")).toBe("BBBB");
  });

  it("refresh() propagates loader errors and keeps the old keys", async () => {
    const r = new RefreshableJwksProvider({
      initial: buildProvider([{ kid: "k1", publicKeyBase64: "AAAA" }]),
      loader: async () => {
        throw new Error("loader exploded");
      },
      source: "test",
    });
    await expect(r.refresh()).rejects.toThrow(/loader exploded/);
    expect(await r.getPublicKeyForKid("k1")).toBe("AAAA");
    expect(r.status().lastError).toBe("loader exploded");
  });

  it("startPeriodicRefresh fires onResult on each tick", async () => {
    let loaderCalls = 0;
    const r = new RefreshableJwksProvider({
      initial: buildProvider([{ kid: "k1", publicKeyBase64: "AAAA" }]),
      loader: async () => {
        loaderCalls += 1;
        return buildProvider([{ kid: "k" + loaderCalls.toString(), publicKeyBase64: "AAAA" }]);
      },
      source: "test",
    });
    const results: Array<{ ok: boolean; error?: string }> = [];
    r.startPeriodicRefresh({
      intervalMs: 10,
      onResult: (result) => results.push(result),
    });
    await new Promise((res) => setTimeout(res, 35));
    r.stopPeriodicRefresh();
    expect(loaderCalls).toBeGreaterThanOrEqual(1);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      expect(result.ok).toBe(true);
    }
  });

  it("startPeriodicRefresh is idempotent (subsequent calls are no-ops)", async () => {
    const r = new RefreshableJwksProvider({
      initial: buildProvider([{ kid: "k1", publicKeyBase64: "AAAA" }]),
      loader: async () => buildProvider([{ kid: "k1", publicKeyBase64: "AAAA" }]),
      source: "test",
    });
    let calls = 0;
    r.startPeriodicRefresh({
      intervalMs: 1_000,
      onResult: () => (calls += 1),
    });
    r.startPeriodicRefresh({
      intervalMs: 1_000,
      onResult: () => (calls += 1),
    });
    r.stopPeriodicRefresh();
    expect(calls).toBe(0);
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
      jwksUrl: null,
      jwksRefreshSeconds: null,
      jwtIssuer: null,
      jwtAudience: null,
      clockSkewSeconds: null,
    });
    expect(result).toEqual({});
  });

  it("rejects JWT options without --jwks-file or --jwks-url", async () => {
    await expect(
      resolveJwtFlags({
        jwksFile: null,
        jwksUrl: null,
        jwksRefreshSeconds: null,
        jwtIssuer: "https://issuer.example",
        jwtAudience: null,
        clockSkewSeconds: null,
      }),
    ).rejects.toThrow(JwksLoadError);
  });

  it("rejects --jwks-file and --jwks-url together (mutually exclusive)", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
      async (path) => {
        await expect(
          resolveJwtFlags({
            jwksFile: path,
            jwksUrl: "https://example.com/jwks",
            jwksRefreshSeconds: null,
            jwtIssuer: "https://issuer.example",
            jwtAudience: "https://aud.example",
            clockSkewSeconds: null,
          }),
        ).rejects.toThrow(/mutually exclusive/);
      },
    );
  });

  it("requires --jwt-issuer when --jwks-file is set", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
      async (path) => {
        await expect(
          resolveJwtFlags({
            jwksFile: path,
            jwksUrl: null,
            jwksRefreshSeconds: null,
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
            jwksUrl: null,
            jwksRefreshSeconds: null,
            jwtIssuer: "https://issuer.example",
            jwtAudience: null,
            clockSkewSeconds: null,
          }),
        ).rejects.toThrow(JwksLoadError);
      },
    );
  });

  it("returns provider + issuer + audience + refreshable for the full --jwks-file flag set", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
      async (path) => {
        const result = await resolveJwtFlags({
          jwksFile: path,
          jwksUrl: null,
          jwksRefreshSeconds: null,
          jwtIssuer: "https://issuer.example",
          jwtAudience: "https://aud.example",
          clockSkewSeconds: null,
        });
        expect(result.jwksProvider).toBeDefined();
        expect(result.refreshable).toBeDefined();
        expect(result.refreshable?.source).toBe(path);
        expect(result.jwtIssuer).toBe("https://issuer.example");
        expect(result.jwtAudience).toBe("https://aud.example");
        expect(result.clockSkewSeconds).toBeUndefined();
      },
    );
  });

  it("returns refreshable for the full --jwks-url flag set", async () => {
    const result = await resolveJwtFlags({
      jwksFile: null,
      jwksUrl: "https://example.com/jwks",
      jwksRefreshSeconds: null,
      jwtIssuer: "https://issuer.example",
      jwtAudience: "https://aud.example",
      clockSkewSeconds: null,
      fetch: makeFetch({
        body: JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abcd" }] }),
      }),
    });
    expect(result.refreshable?.source).toBe("https://example.com/jwks");
    expect(await result.jwksProvider!.getPublicKeyForKid("k1")).toBe("abcd");
  });

  it("propagates URL load failures as JwksLoadError", async () => {
    await expect(
      resolveJwtFlags({
        jwksFile: null,
        jwksUrl: "https://example.com/jwks",
        jwksRefreshSeconds: null,
        jwtIssuer: "https://issuer.example",
        jwtAudience: "https://aud.example",
        clockSkewSeconds: null,
        fetch: makeFetch({ status: 404, body: "not found" }),
      }),
    ).rejects.toThrow(/returned status 404/);
  });

  it("parses --clock-skew-seconds when valid", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
      async (path) => {
        const result = await resolveJwtFlags({
          jwksFile: path,
          jwksUrl: null,
          jwksRefreshSeconds: null,
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
              jwksUrl: null,
              jwksRefreshSeconds: null,
              jwtIssuer: "https://issuer.example",
              jwtAudience: "https://aud.example",
              clockSkewSeconds: bad,
            }),
          ).rejects.toThrow(JwksLoadError);
        }
      },
    );
  });

  it("rejects --jwks-refresh-seconds outside [0, 86400]", async () => {
    await expect(
      resolveJwtFlags({
        jwksFile: null,
        jwksUrl: "https://example.com/jwks",
        jwksRefreshSeconds: "-1",
        jwtIssuer: "https://issuer.example",
        jwtAudience: "https://aud.example",
        clockSkewSeconds: null,
        fetch: makeFetch({
          body: JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
        }),
      }),
    ).rejects.toThrow(/in \[0, 86400\]/);
    await expect(
      resolveJwtFlags({
        jwksFile: null,
        jwksUrl: "https://example.com/jwks",
        jwksRefreshSeconds: "100000",
        jwtIssuer: "https://issuer.example",
        jwtAudience: "https://aud.example",
        clockSkewSeconds: null,
        fetch: makeFetch({
          body: JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
        }),
      }),
    ).rejects.toThrow(/in \[0, 86400\]/);
  });

  it("rejects --jwks-refresh-seconds>0 in --jwks-file mode (file uses SIGHUP)", async () => {
    await withTempFile(
      "jwks.json",
      JSON.stringify({ keys: [{ kid: "k1", publicKeyBase64: "abc" }] }),
      async (path) => {
        await expect(
          resolveJwtFlags({
            jwksFile: path,
            jwksUrl: null,
            jwksRefreshSeconds: "60",
            jwtIssuer: "https://issuer.example",
            jwtAudience: "https://aud.example",
            clockSkewSeconds: null,
          }),
        ).rejects.toThrow(/only supported with --jwks-url/);
      },
    );
  });
});
