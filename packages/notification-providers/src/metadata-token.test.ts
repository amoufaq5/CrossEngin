import { describe, expect, it } from "vitest";

import {
  MAX_ACCESS_TOKEN_LIFETIME_SECONDS,
  TOKEN_EXPIRY_SKEW_SECONDS,
  type FcmTokenClock,
} from "./fcm-token.js";
import {
  classifyMetadataResponse,
  classifyMetadataTransportFailure,
  DEFAULT_METADATA_REQUEST_TIMEOUT_MS,
  defaultMetadataTokenUrl,
  errorCodeOf,
  GCE_METADATA_ADDRESS,
  GCE_METADATA_BASE_URL,
  GCE_METADATA_HOST,
  METADATA_FLAVOR_HEADER,
  METADATA_FLAVOR_VALUE,
  METADATA_TOKEN_ERROR_KINDS,
  metadataEndpointDefect,
  metadataRequestHeaders,
  metadataServerFcmTokenProvider,
  MetadataServerFcmTokenProvider,
  MetadataTokenError,
  metadataTokenPath,
  parseMetadataTokenResponse,
  RETRYABLE_METADATA_TOKEN_ERROR_KINDS,
} from "./metadata-token.js";
import type { FcmAccessTokenProvider } from "./push-fcm.js";
import { FakeFetch } from "./test-fakes.js";

/*
 * Everything here runs against `FakeFetch` and an injected clock. That is not only the package's
 * rule — it is the only way to test this provider at all: the real endpoint is a link-local address
 * that exists on a Google instance and nowhere else, so a test that reached for it would pass on
 * GKE and fail everywhere, which is the inverse of useful.
 */

const T0 = Date.parse("2026-10-05T09:00:00.000Z");

class TestClock implements FcmTokenClock {
  constructor(private ms: number) {}
  nowMs(): number {
    return this.ms;
  }
  advanceSeconds(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

function tokenResponse(accessToken = "ya29.metadata", expiresIn = 3599): string {
  return JSON.stringify({
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: "Bearer",
  });
}

function provider(
  fetch: FakeFetch,
  clock: FcmTokenClock = new TestClock(T0),
  opts: Readonly<Record<string, unknown>> = {},
): MetadataServerFcmTokenProvider {
  return new MetadataServerFcmTokenProvider({ fetch: fetch.fn, clock, ...opts });
}

/** A fetch that rejects with a libuv-style error, optionally nested the way undici nests them. */
function failingFetch(err: unknown): FakeFetch["fn"] {
  return async () => {
    throw err;
  };
}

function nodeError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function kindOf(fetch: FakeFetch["fn"]): Promise<MetadataTokenError> {
  const subject = new MetadataServerFcmTokenProvider({
    fetch,
    clock: new TestClock(T0),
  });
  try {
    await subject.token();
  } catch (err) {
    expect(err).toBeInstanceOf(MetadataTokenError);
    return err as MetadataTokenError;
  }
  throw new Error("the mint was expected to reject");
}

// ---------------------------------------------------------------------------

describe("the endpoint", () => {
  it("defaults to the link-local metadata server over plain http", () => {
    // Pinned as an exact string on purpose. The scheme is http because the host is a link-local
    // address with no route off the instance and no CA that could certify it, so an "upgrade" to
    // https here would silently break every GKE deployment this module exists for.
    expect(defaultMetadataTokenUrl()).toBe(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    );
    expect(GCE_METADATA_BASE_URL).toBe(`http://${GCE_METADATA_HOST}`);
    expect(new URL(defaultMetadataTokenUrl()).protocol).toBe("http:");
  });

  it("percent-encodes a service account named by its email address", () => {
    expect(metadataTokenPath("push@crossengin-prod.iam.gserviceaccount.com")).toBe(
      "/computeMetadata/v1/instance/service-accounts/push%40crossengin-prod.iam.gserviceaccount.com/token",
    );
  });

  it("accepts the two link-local spellings over http", () => {
    expect(metadataEndpointDefect(defaultMetadataTokenUrl())).toBeNull();
    expect(
      metadataEndpointDefect(`http://${GCE_METADATA_ADDRESS}/computeMetadata/v1/x`),
    ).toBeNull();
  });

  it("accepts a loopback stand-in on any port", () => {
    expect(metadataEndpointDefect("http://127.0.0.1:8080/token")).toBeNull();
    expect(metadataEndpointDefect("http://localhost:19999/token")).toBeNull();
    expect(metadataEndpointDefect("http://[::1]:8080/token")).toBeNull();
  });

  /*
   * The rule that makes the override safe to have. An operator who could set it already owns the
   * process's environment, so this is not a defence against them — it is what stops an ordinary
   * misconfiguration from sending "give me this workload's identity" off the instance in cleartext.
   */
  it("refuses plain http to anywhere that is not on the instance", () => {
    expect(metadataEndpointDefect("http://metadata.evil.example/token")).toContain(
      "only use http for a link-local or loopback host",
    );
  });

  it("refuses a scheme that is neither http nor https", () => {
    expect(metadataEndpointDefect("file:///etc/token")).toBe(
      "endpoint must be http (link-local) or https",
    );
  });

  it("refuses something that is not a URL", () => {
    expect(metadataEndpointDefect("metadata.google.internal/token")).toBe(
      "endpoint is not a URL",
    );
  });
});

describe("the mandatory Metadata-Flavor header", () => {
  /*
   * Google requires this header specifically because a request that *cannot* set a custom header — a
   * form post, an image tag, a browser on the instance following a redirect — must never be able to
   * reach the token endpoint. It is what makes an SSRF against this URL harmless, so it is not
   * optional and there is no code path that builds a header set without it.
   */
  it("is present in the only function that builds a header set", () => {
    expect(metadataRequestHeaders()[METADATA_FLAVOR_HEADER]).toBe(
      METADATA_FLAVOR_VALUE,
    );
    expect(METADATA_FLAVOR_VALUE).toBe("Google");
  });

  it("is on the request the provider actually sends", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    await provider(fetch).token();
    expect(fetch.only.headers[METADATA_FLAVOR_HEADER]).toBe("Google");
  });

  it("is on every request, not only the first", async () => {
    const fetch = new FakeFetch([
      { status: 200, body: tokenResponse("ya29.a", 3600) },
      { status: 200, body: tokenResponse("ya29.b", 3600) },
    ]);
    const subject = provider(fetch);
    await subject.token();
    subject.invalidate();
    await subject.token();
    expect(fetch.requests).toHaveLength(2);
    for (const request of fetch.requests) {
      expect(request.headers[METADATA_FLAVOR_HEADER]).toBe("Google");
    }
  });

  it("sends no authorization header — the network position is the credential", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    await provider(fetch).token();
    expect(fetch.only.headers["authorization"]).toBeUndefined();
    expect(fetch.only.body).toBeUndefined();
  });
});

describe("the request", () => {
  it("GETs the link-local URL by default", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    await provider(fetch).token();
    expect(fetch.only.url).toBe(defaultMetadataTokenUrl());
    expect(fetch.only.method).toBe("GET");
  });

  it("reads a named service account instead of the attached one", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    await provider(fetch, new TestClock(T0), {
      serviceAccount: "push@crossengin-prod.iam.gserviceaccount.com",
    }).token();
    expect(fetch.only.url).toContain("push%40crossengin-prod");
  });

  it("appends requested scopes as a comma-joined query", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    await provider(fetch, new TestClock(T0), {
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    }).token();
    expect(fetch.only.url).toContain(
      "?scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Ffirebase.messaging",
    );
  });

  it("asks for no scopes at all by default, taking the instance's own", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    await provider(fetch).token();
    expect(fetch.only.url).not.toContain("scopes=");
  });

  it("uses an https override, and reports it for a boot log line", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    const subject = provider(fetch, new TestClock(T0), {
      endpoint: "https://metadata-proxy.internal.example/token",
    });
    expect(subject.tokenEndpoint()).toBe(
      "https://metadata-proxy.internal.example/token",
    );
    await subject.token();
    expect(fetch.only.url).toBe("https://metadata-proxy.internal.example/token");
  });

  it("passes an abort signal, so a silent metadata server cannot hang a send", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse() }]);
    const seen: (AbortSignal | undefined)[] = [];
    await new MetadataServerFcmTokenProvider({
      clock: new TestClock(T0),
      fetch: async (url, init) => {
        seen.push(init.signal);
        return fetch.fn(url, init);
      },
    }).token();
    expect(seen[0]?.aborted).toBe(false);
    expect(DEFAULT_METADATA_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("construction refusals", () => {
  it("holds an override to the plaintext rule", () => {
    expect(
      () =>
        new MetadataServerFcmTokenProvider({
          endpoint: "http://metadata.evil.example/token",
        }),
    ).toThrow(/only use http for a link-local or loopback host/);
  });

  it("refuses an override that is not a URL, with its own error class and kind", () => {
    try {
      new MetadataServerFcmTokenProvider({ endpoint: "not-a-url" });
      expect.unreachable("a bad endpoint must refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(MetadataTokenError);
      const error = err as MetadataTokenError;
      expect(error.kind).toBe("invalid_configuration");
      expect(error.message).toContain("endpoint is not a URL");
    }
  });

  /* Unbounded is the one timeout this must not accept: off GCE the address never answers. */
  it("refuses a non-positive timeout", () => {
    expect(() => new MetadataServerFcmTokenProvider({ timeoutMs: 0 })).toThrow(
      /positive number of milliseconds/,
    );
  });

  it("refuses a negative expiry skew", () => {
    expect(
      () => new MetadataServerFcmTokenProvider({ expirySkewSeconds: -1 }),
    ).toThrow(/must not be negative/);
  });

  it("refuses an empty service account name", () => {
    expect(
      () => new MetadataServerFcmTokenProvider({ serviceAccount: "" }),
    ).toThrow(/must not be empty/);
  });

  /* Constructing must not touch the network: boot cannot depend on a link-local request. */
  it("probes nothing at construction", () => {
    const fetch = new FakeFetch([]);
    provider(fetch);
    expect(fetch.requests).toEqual([]);
  });

});

describe("the cache", () => {
  /* One queued response: a second request throws `no queued response`, which is the assertion. */
  it("serves a second call from the cache without a second request", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.cached") }]);
    const subject = provider(fetch);
    expect(await subject.token()).toBe("ya29.cached");
    expect(await subject.token()).toBe("ya29.cached");
    expect(fetch.requests).toHaveLength(1);
  });

  it("keeps serving the cached token right up to the skew window", async () => {
    const clock = new TestClock(T0);
    const fetch = new FakeFetch([
      { status: 200, body: tokenResponse("ya29.cached", 3600) },
    ]);
    const subject = provider(fetch, clock);
    await subject.token();
    clock.advanceSeconds(3600 - TOKEN_EXPIRY_SKEW_SECONDS - 1);
    expect(await subject.token()).toBe("ya29.cached");
    expect(fetch.requests).toHaveLength(1);
  });

  /*
   * The near edge. A token still valid for `skew` seconds is refreshed anyway: between this answer
   * and FCM receiving it there is a queued send and a TLS handshake, and a token that lapses in that
   * gap is a 401 indistinguishable from an identity that was unbound.
   */
  it("refreshes once inside the skew window, before the token has expired", async () => {
    const clock = new TestClock(T0);
    const fetch = new FakeFetch([
      { status: 200, body: tokenResponse("ya29.first", 3600) },
      { status: 200, body: tokenResponse("ya29.second", 3600) },
    ]);
    const subject = provider(fetch, clock);
    await subject.token();
    clock.advanceSeconds(3600 - TOKEN_EXPIRY_SKEW_SECONDS);
    expect(await subject.token()).toBe("ya29.second");
    expect(fetch.requests).toHaveLength(2);
  });

  it("reports when the cached token stops being servable, skew included", async () => {
    const clock = new TestClock(T0);
    const subject = provider(
      new FakeFetch([{ status: 200, body: tokenResponse("ya29.first", 3600) }]),
      clock,
    );
    expect(subject.cachedTokenServableUntilMs()).toBeNull();
    await subject.token();
    expect(subject.cachedTokenServableUntilMs()).toBe(
      T0 + (3600 - TOKEN_EXPIRY_SKEW_SECONDS) * 1000,
    );
  });

  it("invalidate forces the next call to fetch", async () => {
    const fetch = new FakeFetch([
      { status: 200, body: tokenResponse("ya29.first") },
      { status: 200, body: tokenResponse("ya29.second") },
    ]);
    const subject = provider(fetch);
    await subject.token();
    subject.invalidate();
    expect(await subject.token()).toBe("ya29.second");
  });

  it("caps an implausible expires_in rather than trusting it", async () => {
    const clock = new TestClock(T0);
    const subject = provider(
      new FakeFetch([{ status: 200, body: tokenResponse("ya29.long", 604_800) }]),
      clock,
    );
    await subject.token();
    expect(subject.cachedTokenServableUntilMs()).toBe(
      T0 +
        (MAX_ACCESS_TOKEN_LIFETIME_SECONDS - TOKEN_EXPIRY_SKEW_SECONDS) * 1000,
    );
  });

  it("dates the cache from the answer, not from when the request started", async () => {
    const clock = new TestClock(T0);
    const subject = new MetadataServerFcmTokenProvider({
      clock,
      fetch: async () => {
        clock.advanceSeconds(2);
        return {
          ok: true,
          status: 200,
          text: async (): Promise<string> => tokenResponse("ya29.slow", 3600),
        };
      },
    });
    await subject.token();
    expect(subject.cachedTokenServableUntilMs()).toBe(
      T0 + 2000 + (3600 - TOKEN_EXPIRY_SKEW_SECONDS) * 1000,
    );
  });
});

describe("concurrency", () => {
  /* One queued response: a second fetch would throw, so this asserts the in-flight share. */
  it("makes one request for many concurrent callers", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.shared") }]);
    const subject = provider(fetch);
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => subject.token()),
    );
    expect(tokens).toEqual(Array.from({ length: 8 }, () => "ya29.shared"));
    expect(fetch.requests).toHaveLength(1);
  });

  it("gives every concurrent caller the same rejection", async () => {
    const fetch = new FakeFetch([{ status: 503, body: "" }]);
    const subject = provider(fetch);
    const settled = await Promise.allSettled([subject.token(), subject.token()]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(fetch.requests).toHaveLength(1);
  });

  it("does not remember a failure: the next caller retries and succeeds", async () => {
    const fetch = new FakeFetch([
      { status: 500, body: "" },
      { status: 200, body: tokenResponse("ya29.after-retry") },
    ]);
    const subject = provider(fetch);
    await expect(subject.token()).rejects.toThrow(MetadataTokenError);
    expect(await subject.token()).toBe("ya29.after-retry");
    expect(fetch.requests).toHaveLength(2);
  });
});

describe("not on GCE versus on GCE and refused", () => {
  /*
   * The distinction this module's vocabulary exists for. Both arrive as "no token, so no push", and
   * they want opposite responses: one says supply a key file instead, the other says look at an IAM
   * binding. Classifying them together sends an operator reading IAM policy for a deployment running
   * on their laptop.
   */
  it("reads a name that does not resolve as not being on GCE, and does not retry it", async () => {
    const error = await kindOf(failingFetch(nodeError("ENOTFOUND", "getaddrinfo ENOTFOUND")));
    expect(error.kind).toBe("metadata_server_unreachable");
    expect(error.isRetryable()).toBe(false);
    expect(error.message).toContain("not running on GCE/GKE");
    expect(error.message).toContain("service-account key");
  });

  it("reads an unroutable host the same way, through undici's nested cause", async () => {
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: nodeError("EHOSTUNREACH"),
    });
    const error = await kindOf(failingFetch(wrapped));
    expect(error.kind).toBe("metadata_server_unreachable");
  });

  it("reads a refused connection as not being on GCE", async () => {
    expect(classifyMetadataTransportFailure(nodeError("ECONNREFUSED"))).toBe(
      "metadata_server_unreachable",
    );
  });

  /*
   * A silence is the one genuinely ambiguous case, and it is resolved towards retryable on purpose:
   * calling a wedged node terminal *drops* a notification, while calling an unroutable address
   * retryable only delays one, and the two mistakes do not cost the same.
   */
  it("keeps a timeout separate from unreachable, and retryable", async () => {
    const error = await kindOf(
      failingFetch(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
    expect(error.kind).toBe("metadata_server_timeout");
    expect(error.isRetryable()).toBe(true);
    expect(error.message).not.toContain("not running on GCE/GKE");
  });

  it("treats a temporary resolver failure as transient rather than as not-on-GCE", () => {
    // EAI_AGAIN is a DNS blip, not evidence about where this process is running.
    expect(classifyMetadataTransportFailure(nodeError("EAI_AGAIN"))).toBe(
      "network_error",
    );
  });

  it("falls back to a retryable network error for an unrecognised throw", async () => {
    const error = await kindOf(failingFetch(nodeError("ECONNRESET")));
    expect(error.kind).toBe("network_error");
    expect(error.isRetryable()).toBe(true);
  });

  it("names a 404 as a service account that is not attached, and does not retry it", async () => {
    const error = await kindOf(new FakeFetch([{ status: 404, body: "" }]).fn);
    expect(error.kind).toBe("service_account_not_attached");
    expect(error.status).toBe(404);
    expect(error.isRetryable()).toBe(false);
  });

  it("classifies any other 4xx as a refusal, terminal", async () => {
    const error = await kindOf(new FakeFetch([{ status: 403, body: "" }]).fn);
    expect(error.kind).toBe("metadata_server_refused");
    expect(error.isRetryable()).toBe(false);
  });

  it("classifies 5xx and 429 as retryable, because the server is plainly there", () => {
    expect(classifyMetadataResponse(503)).toBe("metadata_server_unavailable");
    expect(classifyMetadataResponse(429)).toBe("rate_limited");
    expect(RETRYABLE_METADATA_TOKEN_ERROR_KINDS.has("metadata_server_unavailable")).toBe(
      true,
    );
    expect(RETRYABLE_METADATA_TOKEN_ERROR_KINDS.has("rate_limited")).toBe(true);
  });

  it("digs a code out of an AggregateError's members", () => {
    const aggregate = Object.assign(new Error("all attempts failed"), {
      errors: [new Error("plain"), nodeError("ENETUNREACH")],
    });
    expect(errorCodeOf(aggregate)).toBe("ENETUNREACH");
  });

  it("gives up rather than recursing forever on a self-referential cause", () => {
    const looping: { cause?: unknown } = {};
    looping.cause = looping;
    expect(errorCodeOf(looping)).toBeNull();
  });

  it("every declared kind is either retryable or not, and the retryable set is a subset", () => {
    for (const kind of RETRYABLE_METADATA_TOKEN_ERROR_KINDS) {
      expect(METADATA_TOKEN_ERROR_KINDS).toContain(kind);
    }
    expect(RETRYABLE_METADATA_TOKEN_ERROR_KINDS.has("invalid_configuration")).toBe(false);
    expect(RETRYABLE_METADATA_TOKEN_ERROR_KINDS.has("malformed_token_response")).toBe(
      false,
    );
  });
});

describe("the token response", () => {
  it("reads an access token and its lifetime", () => {
    expect(parseMetadataTokenResponse(tokenResponse("ya29.x", 3599))).toEqual({
      accessToken: "ya29.x",
      expiresInSeconds: 3599,
    });
  });

  it("refuses a 2xx body that is not JSON, and does not retry it", async () => {
    const error = await kindOf(
      new FakeFetch([{ status: 200, body: "<html>proxy</html>" }]).fn,
    );
    expect(error.kind).toBe("malformed_token_response");
    expect(error.isRetryable()).toBe(false);
  });

  /*
   * Each refusal named, in one test, because the point is the *set*: guessing a lifetime would
   * either re-fetch on every send or cache a token past its real expiry and turn every push into a
   * 401, so an absent `expires_in` is as malformed as an absent token.
   */
  it("names every way a 2xx body can be unusable rather than assuming a default", () => {
    expect(() => parseMetadataTokenResponse("[1,2]")).toThrow(/not an object/);
    expect(() => parseMetadataTokenResponse('{"expires_in":60}')).toThrow(
      /no access_token/,
    );
    expect(() => parseMetadataTokenResponse('{"access_token":""}')).toThrow(
      /no access_token/,
    );
    expect(() => parseMetadataTokenResponse('{"access_token":"a"}')).toThrow(
      /no positive expires_in/,
    );
    expect(() =>
      parseMetadataTokenResponse('{"access_token":"a","expires_in":0}'),
    ).toThrow(/no positive expires_in/);
    expect(() =>
      parseMetadataTokenResponse('{"access_token":"a","expires_in":"3599"}'),
    ).toThrow(/no positive expires_in/);
  });
});

describe("what an error message may carry", () => {
  /*
   * There is no credential of ours to leak here — which is this route's one genuine advantage over a
   * key file — so the risk runs the other way: a stand-in endpoint that throws or answers with
   * something containing a *token* must not get it written into a boot log.
   */
  it("never echoes a thrown object's contents", async () => {
    const error = await kindOf(
      failingFetch({ secret: "ya29.leaked-access-token", code: "ECONNRESET" }),
    );
    expect(error.message).not.toContain("ya29.leaked-access-token");
  });

  it("never echoes a non-2xx body", async () => {
    const error = await kindOf(
      new FakeFetch([
        { status: 403, body: "Forbidden: token ya29.leaked-access-token" },
      ]).fn,
    );
    expect(error.message).toBe("the metadata server answered 403");
  });

  it("never echoes a malformed 2xx body", async () => {
    const error = await kindOf(
      new FakeFetch([{ status: 200, body: "ya29.leaked-access-token" }]).fn,
    );
    expect(error.message).not.toContain("ya29.leaked-access-token");
  });
});

describe("the FcmAccessTokenProvider seam", () => {
  /*
   * The point of writing this module: `FcmPushSender` must not be able to tell the two routes apart.
   * The seam is a bare function type, so conformance is structural and asserted by assignment.
   */
  it("conforms by assignment, as the service-account provider does", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.seam") }]);
    const asProvider: FcmAccessTokenProvider = provider(fetch).asProvider();
    expect(await asProvider()).toBe("ya29.seam");
  });

  it("the one-line helper returns the same function, refusing at construction", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.helper") }]);
    const asProvider: FcmAccessTokenProvider = metadataServerFcmTokenProvider({
      fetch: fetch.fn,
      clock: new TestClock(T0),
    });
    expect(await asProvider()).toBe("ya29.helper");
    expect(() =>
      metadataServerFcmTokenProvider({ endpoint: "http://off.instance.example/t" }),
    ).toThrow(MetadataTokenError);
  });

  it("shares the cache across every call made through the seam", async () => {
    const fetch = new FakeFetch([{ status: 200, body: tokenResponse("ya29.one") }]);
    const subject = provider(fetch);
    const asProvider = subject.asProvider();
    await asProvider();
    await asProvider();
    await subject.token();
    expect(fetch.requests).toHaveLength(1);
  });
});
