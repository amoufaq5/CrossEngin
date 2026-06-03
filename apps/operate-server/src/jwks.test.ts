import { generateEd25519Keypair, signEd25519 } from "@crossengin/crypto";
import { InMemoryEntityStore } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import {
  base64UrlToBase64,
  JwksRefreshPoller,
  parseJwksDocument,
  RemoteJwksProvider,
  type FetchLike,
  type IntervalScheduler,
} from "./jwks.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { buildOperateHttpServer } from "./server.js";

function b64url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A JWKS doc for an Ed25519 public key (base64) under a kid. */
function jwksDoc(kid: string, publicKeyBase64: string): { keys: unknown[] } {
  return { keys: [{ kty: "OKP", crv: "Ed25519", kid, x: b64url(publicKeyBase64) }] };
}

function stubFetch(docs: Array<{ keys: unknown[] }>, counter: { n: number }): FetchLike {
  return async () => {
    const doc = docs[Math.min(counter.n, docs.length - 1)]!;
    counter.n += 1;
    return { ok: true, status: 200, json: async () => doc };
  };
}

describe("base64UrlToBase64", () => {
  it("restores +/ and padding", () => {
    expect(base64UrlToBase64("ab-_")).toBe("ab+/");
    expect(base64UrlToBase64("YQ")).toBe("YQ==");
  });
});

describe("parseJwksDocument", () => {
  it("maps OKP/Ed25519 keys by kid (x → base64) and ignores other types", () => {
    const doc = {
      keys: [
        { kty: "OKP", crv: "Ed25519", kid: "k1", x: "ab-_" },
        { kty: "RSA", kid: "rsa1", n: "..." },
        { kty: "OKP", crv: "X25519", kid: "x1", x: "zzz" },
      ],
    };
    const map = parseJwksDocument(doc);
    expect(map.get("k1")).toBe("ab+/");
    expect(map.has("rsa1")).toBe(false);
    expect(map.has("x1")).toBe(false);
  });
  it("tolerates a malformed document", () => {
    expect(parseJwksDocument(null).size).toBe(0);
    expect(parseJwksDocument({ keys: "nope" }).size).toBe(0);
  });
});

describe("RemoteJwksProvider — caching + rotation", () => {
  it("fetches once and serves from cache within the TTL", async () => {
    const kp = generateEd25519Keypair();
    const counter = { n: 0 };
    const provider = new RemoteJwksProvider({
      url: "https://idp/jwks",
      fetch: stubFetch([jwksDoc("k1", kp.publicKeyBase64)], counter),
      now: () => 1000,
    });
    expect(await provider.getPublicKeyForKid("k1")).toBe(kp.publicKeyBase64);
    expect(await provider.getPublicKeyForKid("k1")).toBe(kp.publicKeyBase64);
    expect(counter.n).toBe(1); // cached
  });

  it("refetches on an unknown kid (rotation) past the min-refetch floor", async () => {
    const kp1 = generateEd25519Keypair();
    const kp2 = generateEd25519Keypair();
    const counter = { n: 0 };
    let clock = 1000;
    const provider = new RemoteJwksProvider({
      url: "https://idp/jwks",
      fetch: stubFetch([jwksDoc("k1", kp1.publicKeyBase64), jwksDoc("k2", kp2.publicKeyBase64)], counter),
      minRefetchMs: 10_000,
      cacheTtlMs: 300_000,
      now: () => clock,
    });
    expect(await provider.getPublicKeyForKid("k1")).toBe(kp1.publicKeyBase64);
    // unknown kid within the floor: no refetch, null
    expect(await provider.getPublicKeyForKid("k2")).toBeNull();
    expect(counter.n).toBe(1);
    // past the floor: refetch picks up the rotated key
    clock += 20_000;
    expect(await provider.getPublicKeyForKid("k2")).toBe(kp2.publicKeyBase64);
    expect(counter.n).toBe(2);
  });

  it("keeps the last good key set when a refetch fails", async () => {
    const kp = generateEd25519Keypair();
    let clock = 1000;
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 200, json: async () => jwksDoc("k1", kp.publicKeyBase64) };
      return { ok: false, status: 503, json: async () => ({}) };
    };
    const provider = new RemoteJwksProvider({ url: "https://idp/jwks", fetch, cacheTtlMs: 1000, now: () => clock });
    expect(await provider.getPublicKeyForKid("k1")).toBe(kp.publicKeyBase64);
    clock += 5000; // stale → refetch (which fails) → serve stale
    expect(await provider.getPublicKeyForKid("k1")).toBe(kp.publicKeyBase64);
  });
});

describe("JwksRefreshPoller", () => {
  function fakeScheduler(): { scheduler: IntervalScheduler; tick: () => void; cleared: () => boolean } {
    let fn: (() => void) | null = null;
    let handle: object | null = null;
    return {
      scheduler: {
        setInterval(handler) {
          fn = handler;
          handle = {};
          return handle;
        },
        clearInterval(h) {
          if (h === handle) handle = null;
        },
      },
      tick: () => fn?.(),
      cleared: () => handle === null,
    };
  }

  it("refreshes immediately on start and on each interval tick", async () => {
    let count = 0;
    const provider = { refresh: async () => void (count += 1) };
    const f = fakeScheduler();
    const poller = new JwksRefreshPoller({ provider, intervalMs: 60_000, scheduler: f.scheduler });
    poller.start();
    expect(count).toBe(1); // refreshOnStart
    f.tick();
    f.tick();
    await Promise.resolve();
    expect(count).toBe(3);
  });

  it("can skip the start refresh and stops cleanly", async () => {
    let count = 0;
    const provider = { refresh: async () => void (count += 1) };
    const f = fakeScheduler();
    const poller = new JwksRefreshPoller({ provider, intervalMs: 1000, refreshOnStart: false, scheduler: f.scheduler });
    poller.start();
    expect(count).toBe(0);
    poller.stop();
    expect(f.cleared()).toBe(true);
  });

  it("routes a refresh error to onError without throwing", async () => {
    const errors: unknown[] = [];
    const provider = { refresh: async () => { throw new Error("boom"); } };
    const f = fakeScheduler();
    const poller = new JwksRefreshPoller({ provider, intervalMs: 1000, scheduler: f.scheduler, onError: (e) => errors.push(e) });
    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });
});

describe("operate-server — authenticates a JWT via a remote JWKS", () => {
  it("verifies a Bearer JWT against keys fetched from the JWKS endpoint", async () => {
    const kp = generateEd25519Keypair();
    const ISS = "https://idp/";
    const AUD = "https://api/";
    const NOW = new Date("2026-06-03T12:00:00.000Z");
    const nowS = Math.floor(NOW.getTime() / 1000);
    const counter = { n: 0 };
    const manifest = await loadBuiltinPack("erp-retail");

    const header = b64url(Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "k1" })).toString("base64"));
    const payload = b64url(
      Buffer.from(
        JSON.stringify({ iss: ISS, aud: AUD, sub: "u1", scope: "store_manager", exp: nowS + 3600, nbf: nowS - 60 }),
      ).toString("base64"),
    );
    const sig = b64url(signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, new TextEncoder().encode(`${header}.${payload}`)));
    const token = `${header}.${payload}.${sig}`;

    const { httpServer } = buildOperateHttpServer({
      manifest,
      store: new InMemoryEntityStore(),
      apiKeys: [],
      jwt: {
        jwksProvider: new RemoteJwksProvider({
          url: "https://idp/jwks",
          fetch: stubFetch([jwksDoc("k1", kp.publicKeyBase64)], counter),
          now: () => NOW.getTime(),
        }),
        issuer: ISS,
        audience: AUD,
      },
      now: () => NOW,
    });

    const res = await httpServer.dispatch(
      {
        method: "GET",
        url: "/v1/products",
        headers: { authorization: `Bearer ${token}`, host: "api.example.com", "x-tenant-id": "00000000-0000-4000-8000-000000000001" },
        remoteAddress: "203.0.113.1",
      },
      null,
    );
    expect(res.status).toBe(200);
    expect(counter.n).toBeGreaterThanOrEqual(1); // fetched from the JWKS endpoint
  });
});
