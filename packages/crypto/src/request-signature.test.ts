import { hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AEAD_KEY_BYTES } from "./aead.js";
import { hmacSha256Hex } from "./hmac.js";
import {
  COLUMN_KEY_DERIVATION_INFO,
  COLUMN_SECRET_REFUSAL_REASONS,
  CURSOR_KEY_DERIVATION_INFO,
  ColumnSecretRefused,
  KEK_KEY_DERIVATION_INFO,
  REQUEST_SIGNING_KEY_DERIVATION_INFO,
  deriveRequestSigningKey,
  deriveTenantColumnKey,
  deriveTenantCursorKey,
  deriveTenantKek,
  parseRequestSigningSecret,
} from "./key-derivation.js";
import {
  REQUEST_SIGNATURE_DOMAIN_V1,
  REQUEST_SIGNATURE_REFUSALS,
  REQUEST_SIGNATURE_WIRE_VERSION,
  type RequestSignatureFacts,
  type RequestSignatureVerdict,
  canonicalRequestSignatureMessage,
  parseRequestSignatureHeader,
  signRequest,
  verifyRequestSignature,
} from "./request-signature.js";

const SECRET_TEXT = "crossengin-request-signing-secret-0123456789ab";
const SECRET = parseRequestSigningSecret(SECRET_TEXT);
const KEY = deriveRequestSigningKey(SECRET, "k1");
const OTHER_KEY = deriveRequestSigningKey(SECRET, "k2");

const TS = 1_700_000_000;
const BODY_SHA256 = "a".repeat(64);

/** The one fixed triple the known-answer vectors below are pinned against. */
const FACTS: RequestSignatureFacts = {
  keyId: "k1",
  timestampSeconds: TS,
  method: "POST",
  path: "/v1/invoices",
  query: { limit: "50", filter: "state[eq]=sent" },
  bodySha256: BODY_SHA256,
  host: "api.crossengin.io",
  scheme: "https",
};

type VerifyFacts = Omit<RequestSignatureFacts, "keyId" | "timestampSeconds">;

/**
 * The facts a verifier is given: the key id and the timestamp are the header's, not the request's,
 * which is why those two are tampered by editing the header text rather than by passing a
 * different value here.
 */
function verifyFactsOf(facts: RequestSignatureFacts): VerifyFacts {
  const { keyId, timestampSeconds, ...rest } = facts;
  return rest;
}

const VERIFY_FACTS = verifyFactsOf(FACTS);

function messageText(facts: RequestSignatureFacts): string {
  return Buffer.from(canonicalRequestSignatureMessage(facts)).toString("utf8");
}

/** Read through the module's own parser, so no test re-implements the wire grammar. */
function signatureHexOf(header: string): string {
  const parsed = parseRequestSignatureHeader(header);
  if (parsed === null) throw new Error(`header did not parse: ${header}`);
  return parsed.signatureHex;
}

function at(nowSeconds: number, toleranceSeconds = 300): {
  readonly toleranceSeconds: number;
  readonly nowSeconds: number;
} {
  return { toleranceSeconds, nowSeconds };
}

const HEADER = signRequest(KEY, FACTS);

function verifyWith(header: string, facts: VerifyFacts): RequestSignatureVerdict {
  return verifyRequestSignature(KEY, header, facts, at(TS + 5));
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

// Read once at module scope: three describes assert on the module's own text, and a second
// read would be a second thing to keep pointed at the right file.
const SOURCE = readFileSync(new URL("./request-signature.ts", import.meta.url), "utf8");

describe("request-signature constants", () => {
  it("pins the domain tag the canonical message opens with", () => {
    expect(REQUEST_SIGNATURE_DOMAIN_V1).toBe("crossengin.request-signature.v1");
  });

  it("pins the wire version the header carries the signature under", () => {
    expect(REQUEST_SIGNATURE_WIRE_VERSION).toBe("v1");
  });

  it("declares no header name, because this module owns the value and not the position", () => {
    // The header moved to `@crossengin/api-gateway` beside `API_KEY_HEADER`, which is the existing
    // precedent for the same question, and it is the only split that keeps one spelling: that
    // package has no workspace dependencies, so a name declared here could only reach its support
    // map and security doc as a copy — and the doc's `name` is a machine value a client generator
    // emits code from. Asserted on the source so the constant cannot come back here beside it.
    expect(SOURCE).not.toContain("export const REQUEST_SIGNATURE_HEADER");
    expect(SOURCE).toContain("There is deliberately **no header-name constant here**");
  });
});

describe("REQUEST_SIGNATURE_REFUSALS", () => {
  it("is exactly the three members, in the order the verifier decides them", () => {
    expect(REQUEST_SIGNATURE_REFUSALS).toEqual([
      "malformed_header",
      "timestamp_outside_tolerance",
      "signature_mismatch",
    ]);
  });

  it("produces malformed_header for a header the grammar does not admit", () => {
    expect(verifyWith("garbage", VERIFY_FACTS)).toEqual({
      ok: false,
      reason: "malformed_header",
    });
  });

  it("produces timestamp_outside_tolerance for a stale credential", () => {
    expect(verifyRequestSignature(KEY, HEADER, VERIFY_FACTS, at(TS + 3_600, 60))).toEqual({
      ok: false,
      reason: "timestamp_outside_tolerance",
    });
  });

  it("produces signature_mismatch under the wrong key", () => {
    expect(verifyRequestSignature(OTHER_KEY, HEADER, VERIFY_FACTS, at(TS + 5))).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("has a producer for every member, so no refusal is unreachable", () => {
    // Derived from the constant rather than listed again: a fourth member added with no producer
    // fails here instead of shipping as a modelled reason nothing can answer.
    const produced = new Set(
      [
        verifyWith("garbage", VERIFY_FACTS),
        verifyRequestSignature(KEY, HEADER, VERIFY_FACTS, at(TS + 3_600, 60)),
        verifyRequestSignature(OTHER_KEY, HEADER, VERIFY_FACTS, at(TS + 5)),
      ].map((verdict) => (verdict.ok ? "ok" : verdict.reason)),
    );
    expect(produced).toEqual(new Set(REQUEST_SIGNATURE_REFUSALS));
  });
});

describe("known-answer vector for the canonical message and its signature", () => {
  it("pins the canonical message bytes for one fixed triple", () => {
    // Pinned as a literal, not only as a recomputation. The message is what every issued client
    // computes independently, so a silent change to it stops every outstanding signature
    // verifying; editing this literal is the deliberate act that says that was considered.
    expect(messageText(FACTS)).toBe(
      `["crossengin.request-signature.v1","k1",1700000000,"POST","/v1/invoices",` +
        `[["filter",["state[eq]=sent"]],["limit",["50"]]],` +
        `"${BODY_SHA256}","api.crossengin.io","https"]`,
    );
  });

  it("pins the signature hex, computed two independent ways", () => {
    // Once through signRequest, once by building the JSON by hand and calling hmacSha256Hex. Two
    // routes to one literal: a change to the canonicalisation moves the first and not the second.
    const independentMessage = JSON.stringify([
      REQUEST_SIGNATURE_DOMAIN_V1,
      "k1",
      TS,
      "POST",
      "/v1/invoices",
      [
        ["filter", ["state[eq]=sent"]],
        ["limit", ["50"]],
      ],
      BODY_SHA256,
      "api.crossengin.io",
      "https",
    ]);
    const independentSignature = hmacSha256Hex(KEY, independentMessage);

    expect(independentSignature).toBe(
      "59a0c423adf921d6cc00cbc5b89c94516e29fafe396e02ecf057f964a38f1db4",
    );
    expect(signatureHexOf(HEADER)).toBe(independentSignature);
  });

  it("renders the whole header in the documented shape", () => {
    expect(HEADER).toBe(
      "k=k1,t=1700000000,v1=59a0c423adf921d6cc00cbc5b89c94516e29fafe396e02ecf057f964a38f1db4",
    );
  });
});

describe("the canonical message is an array, not a delimiter join", () => {
  it("separates two fact sets a |-join of method and path would collide on", () => {
    // The module's own cited precedent is computeRequestHashInputs joining [method, path, ...] on
    // `|` over a path that admits one, so this is the construction the array form exists to refuse.
    const a: RequestSignatureFacts = { ...FACTS, method: "POST", path: "/v1/a|b" };
    const b: RequestSignatureFacts = { ...FACTS, method: "POST|/v1/a", path: "b" };

    expect([a.method, a.path].join("|")).toBe([b.method, b.path].join("|"));
    expect(messageText(a)).not.toBe(messageText(b));
    expect(signRequest(KEY, a)).not.toBe(signRequest(KEY, b));
  });

  it("separates two fact sets a :-join of host and scheme would collide on", () => {
    // `:` is the delimiter a host:port makes realistic, so it is the second one worth refusing.
    const a: RequestSignatureFacts = { ...FACTS, host: "api.example.com:443", scheme: "https" };
    const b: RequestSignatureFacts = { ...FACTS, host: "api.example.com", scheme: "443:https" };

    expect([a.host, a.scheme].join(":")).toBe([b.host, b.scheme].join(":"));
    expect(messageText(a)).not.toBe(messageText(b));
    expect(signRequest(KEY, a)).not.toBe(signRequest(KEY, b));
  });
});

describe("the query is covered, and sorted", () => {
  it("is insensitive to the order the keys were inserted in", () => {
    const reordered: VerifyFacts = {
      ...VERIFY_FACTS,
      query: { filter: "state[eq]=sent", limit: "50" },
    };
    expect(verifyWith(HEADER, reordered).ok).toBe(true);
  });

  it("covers a multi-value's own order, which the keys' sort must not touch", () => {
    // `?sort=a&sort=b` and `?sort=b&sort=a` are different requests to parseListQuery, so the
    // sort is over keys only and each value list is preserved as it arrived.
    const signed = signRequest(KEY, { ...FACTS, query: { sort: ["a", "b"] } });
    expect(verifyWith(signed, { ...VERIFY_FACTS, query: { sort: ["b", "a"] } })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
    expect(verifyWith(signed, { ...VERIFY_FACTS, query: { sort: ["a", "b"] } }).ok).toBe(true);
  });

  it("reads one value and a one-element list as the same query", () => {
    // IncomingRequest.query carries either shape for a single value, so the two must canonicalise
    // identically or a client and the gateway would disagree about a one-value parameter.
    expect(messageText({ ...FACTS, query: { sort: "a" } })).toBe(
      messageText({ ...FACTS, query: { sort: ["a"] } }),
    );
  });

  it("signs and verifies an empty query, and an empty query is not any non-empty one", () => {
    const signed = signRequest(KEY, { ...FACTS, query: {} });
    expect(verifyWith(signed, { ...VERIFY_FACTS, query: {} }).ok).toBe(true);
    expect(verifyWith(signed, { ...VERIFY_FACTS, query: { a: "1" } })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });
});

describe("every covered fact is tamper-detected", () => {
  const MISMATCH = { ok: false, reason: "signature_mismatch" } as const;

  it("detects a changed key id, which travels in the header", () => {
    // The verifier takes the key id from the header and signs it into the message it recomputes,
    // so swapping it is caught even when the resolved key is unchanged.
    expect(verifyWith(HEADER.replace("k=k1", "k=k2"), VERIFY_FACTS)).toEqual(MISMATCH);
  });

  it("detects a changed timestamp inside the tolerance window", () => {
    // Shifted by one second so the freshness check still passes: otherwise the tolerance refusal
    // would fire first and this would assert nothing about the signature.
    const shifted = HEADER.replace(`t=${TS.toString()}`, `t=${(TS + 1).toString()}`);
    expect(verifyRequestSignature(KEY, shifted, VERIFY_FACTS, at(TS + 5))).toEqual(MISMATCH);
  });

  it("detects a changed method", () => {
    expect(verifyWith(HEADER, { ...VERIFY_FACTS, method: "GET" })).toEqual(MISMATCH);
  });

  it("detects a changed path", () => {
    expect(verifyWith(HEADER, { ...VERIFY_FACTS, path: "/v1/bills" })).toEqual(MISMATCH);
  });

  it("detects a changed query value, and a dropped query key", () => {
    expect(
      verifyWith(HEADER, {
        ...VERIFY_FACTS,
        query: { limit: "51", filter: "state[eq]=sent" },
      }),
    ).toEqual(MISMATCH);
    expect(verifyWith(HEADER, { ...VERIFY_FACTS, query: { limit: "50" } })).toEqual(MISMATCH);
  });

  it("detects a changed body digest, in both directions across null", () => {
    expect(verifyWith(HEADER, { ...VERIFY_FACTS, bodySha256: "b".repeat(64) })).toEqual(MISMATCH);
    expect(verifyWith(HEADER, { ...VERIFY_FACTS, bodySha256: null })).toEqual(MISMATCH);

    const signedWithoutBody = signRequest(KEY, { ...FACTS, bodySha256: null });
    expect(verifyWith(signedWithoutBody, { ...VERIFY_FACTS, bodySha256: BODY_SHA256 })).toEqual(
      MISMATCH,
    );
  });

  it("detects a changed host", () => {
    expect(verifyWith(HEADER, { ...VERIFY_FACTS, host: "evil.example.com" })).toEqual(MISMATCH);
  });

  it("detects a changed scheme, which no other field refuses", () => {
    // The field that stops a staging-minted signature being replayed against production: a key
    // id, a path and a body are all identical across environments.
    expect(verifyWith(HEADER, { ...VERIFY_FACTS, scheme: "http" })).toEqual(MISMATCH);
  });
});

describe("verifyRequestSignature", () => {
  it("accepts a freshly signed request and hands back the parsed header", () => {
    expect(verifyWith(HEADER, VERIFY_FACTS)).toEqual({
      ok: true,
      parsed: { keyId: "k1", timestampSeconds: TS, signatureHex: signatureHexOf(HEADER) },
    });
  });

  it("accepts a request carrying no body, where bodySha256 is null", () => {
    const signed = signRequest(KEY, { ...FACTS, bodySha256: null });
    expect(verifyWith(signed, { ...VERIFY_FACTS, bodySha256: null }).ok).toBe(true);
  });

  it("accepts at exactly the tolerance in both directions and refuses one second past it", () => {
    for (const now of [TS + 60, TS - 60, TS]) {
      expect(verifyRequestSignature(KEY, HEADER, VERIFY_FACTS, at(now, 60)).ok).toBe(true);
    }
    for (const now of [TS + 61, TS - 61]) {
      expect(verifyRequestSignature(KEY, HEADER, VERIFY_FACTS, at(now, 60))).toEqual({
        ok: false,
        reason: "timestamp_outside_tolerance",
      });
    }
  });

  it("reports the stale timestamp rather than the mismatch when both hold", () => {
    // The timestamp is inside the signed message, so a stale credential under the wrong key could
    // honestly be called either. Freshness is checked first so the reason is the first true thing
    // about the request, and an operator is not sent looking for a key problem.
    expect(
      verifyRequestSignature(OTHER_KEY, HEADER, VERIFY_FACTS, at(TS + 3_600, 60)),
    ).toEqual({ ok: false, reason: "timestamp_outside_tolerance" });
  });
});

describe("parseRequestSignatureHeader", () => {
  const SIG = "a".repeat(64);
  const VALID = `k=k1,t=1700000000,v1=${SIG}`;

  it("accepts the exact form and returns the three fields", () => {
    expect(parseRequestSignatureHeader(VALID)).toEqual({
      keyId: "k1",
      timestampSeconds: TS,
      signatureHex: SIG,
    });
  });

  it("refuses any field set that is not k, then t, then v1, and nothing else", () => {
    // One spelling per signature: two renderings that both verified would be two credentials to
    // anything keyed on the header text.
    const refused = [
      `t=1700000000,k=k1,v1=${SIG}`,
      `k=k1,v1=${SIG},t=1700000000`,
      `t=1700000000,v1=${SIG}`,
      `k=k1,v1=${SIG}`,
      "k=k1,t=1700000000",
      `k=k1,t=1700000000,v1=${SIG},x=1`,
      ` k=k1,t=1700000000,v1=${SIG}`,
      `k=k1, t=1700000000,v1=${SIG}`,
    ];
    for (const header of refused) {
      expect(parseRequestSignatureHeader(header)).toBeNull();
    }
  });

  it("refuses a signature that is not exactly 64 lower-case hex characters", () => {
    // Upper case is refused here rather than folded at the comparison, which is what lets the
    // constant-time compare decode both sides without a case pass.
    for (const signature of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), ""]) {
      expect(parseRequestSignatureHeader(`k=k1,t=1700000000,v1=${signature}`)).toBeNull();
    }
  });

  it("refuses a timestamp that is not a positive integer", () => {
    for (const timestamp of ["0", "-1", "xx", "", "1.5", "1e9", "+1"]) {
      expect(parseRequestSignatureHeader(`k=k1,t=${timestamp},v1=${SIG}`)).toBeNull();
    }
  });

  it("refuses a timestamp past Number.MAX_SAFE_INTEGER, which the digit bound admits", () => {
    // `\d{1,19}` admits 19 digits and parseInt loses precision above 2^53 while still answering an
    // integer, so the guard is against the safe range and not the digit count. A timestamp that
    // cannot round-trip cannot be compared against a tolerance.
    const past = "9007199254740993";
    expect(Number.parseInt(past, 10)).toBe(9_007_199_254_740_992);
    expect(Number.isInteger(Number.parseInt(past, 10))).toBe(true);
    expect(Number.isSafeInteger(Number.parseInt(past, 10))).toBe(false);
    expect(parseRequestSignatureHeader(`k=k1,t=${past},v1=${SIG}`)).toBeNull();
    expect(parseRequestSignatureHeader(`k=k1,t=${"9".repeat(19)},v1=${SIG}`)).toBeNull();
  });

  it("refuses a key id outside the character class the header grammar admits", () => {
    for (const keyId of ["k 1", "a,b", "a=b", "", "a".repeat(121)]) {
      expect(parseRequestSignatureHeader(`k=${keyId},t=1700000000,v1=${SIG}`)).toBeNull();
    }
    expect(parseRequestSignatureHeader(`k=${"a".repeat(120)},t=1700000000,v1=${SIG}`)).not.toBeNull();
  });
});

describe("signRequest refuses what it cannot render honestly", () => {
  it("throws on a timestamp that is not a positive integer", () => {
    for (const timestampSeconds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => signRequest(KEY, { ...FACTS, timestampSeconds })).toThrow(/timestampSeconds/);
    }
  });

  it("throws on a key id outside its character class", () => {
    // Refused at the signer as well as at the parser: a key id carrying a comma would render a
    // header that parses as a different field set.
    for (const keyId of ["", "bad id", "a,b", "a=b", "a".repeat(121)]) {
      expect(() => signRequest(KEY, { ...FACTS, keyId })).toThrow(/key id must match/);
    }
    expect(() => signRequest(KEY, { ...FACTS, keyId: "a".repeat(120) })).not.toThrow();
  });
});

describe("the header grammar has one spelling of each of its three patterns", () => {
  // Three second spellings lived here and one was live: with REQUEST_SIGNATURE_WIRE_VERSION flipped
  // to "v2", signRequest emitted `v2=` while the parser's own regex literal still said `v1=`, so the
  // signer and its verifier disagreed with no compile error. ADR-0288's maintained list, in the
  // module whose own doc anticipates that exact change. The behavioural half of the key-id bound is
  // pinned above on both sides (120 round-trips, 121 is refused at the parser and at the signer);
  // these two assertions pin the *derivation*, which is what a reader reintroducing a literal would
  // otherwise satisfy.

  it("builds the version field from the constant the signer interpolates", () => {
    // Constructed with `new RegExp` from the same constants, so flipping the version moves both
    // halves together. Asserted on the source rather than only on the behaviour, because a second
    // literal that happens to agree today passes every behavioural test.
    expect(SOURCE).toContain("const HEADER_RE = new RegExp(");
    expect(SOURCE).toContain(
      "`^k=(${KEY_ID_PATTERN}),t=(\\\\d{1,19}),${REQUEST_SIGNATURE_WIRE_VERSION}=(${HEX64_PATTERN})$`",
    );

    // And the literal the defect was made of does not reappear anywhere in the module. The signer's
    // own emission interpolates the constant, so `,v1=` as text would be a second spelling by
    // construction — there is no legitimate occurrence of it to exempt.
    const withoutComments = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(withoutComments).not.toContain(",v1=");
    expect(withoutComments).not.toContain("v1=(");

    // Non-vacuity: the two patterns the assertions are about are really the ones in use, and the
    // version really is the string they are derived from.
    expect(REQUEST_SIGNATURE_WIRE_VERSION).toBe("v1");
    expect(signRequest(KEY, FACTS)).toContain(`,${REQUEST_SIGNATURE_WIRE_VERSION}=`);
    expect(parseRequestSignatureHeader(signRequest(KEY, FACTS))).not.toBeNull();
  });

  it("derives the wire version from the domain tag, so the field cannot name another message", () => {
    // The wire version is not inside the canonical message — the domain tag is — so two independent
    // constants let the header claim a format the signature is not over. Measured on the built
    // module with the version declared separately and flipped to "v2": signRequest emitted
    // `k=k1,t=1800000000,v2=db2206dc…`, byte-identical to the v1 signature, so a captured v1 header
    // relabelled `v2=` verified. Derived, the two cannot disagree.
    expect(REQUEST_SIGNATURE_WIRE_VERSION).toBe(REQUEST_SIGNATURE_DOMAIN_V1.split(".").pop());
    expect(SOURCE).toContain("REQUEST_SIGNATURE_DOMAIN_V1.split(\".\").pop()");

    // Non-vacuity: the tag really does end in the version, so the derivation is not matching "".
    expect(REQUEST_SIGNATURE_WIRE_VERSION).toBe("v1");
    expect(REQUEST_SIGNATURE_DOMAIN_V1).toBe("crossengin.request-signature.v1");
  });

  it("refuses a domain tag whose version could not be interpolated safely", () => {
    // The module refuses a last segment outside `v<digits>` at load, which is what makes building
    // the parser's pattern from it safe by construction: a version carrying a regex metacharacter
    // would widen the parser in silence. Asserted as a property of the constant rather than by
    // reloading the module under a mutation, since the guard runs at import and vitest caches it.
    expect(REQUEST_SIGNATURE_WIRE_VERSION).toMatch(/^v\d+$/);
    expect(SOURCE).toContain("if (!/^v\\d+$/.test(REQUEST_SIGNATURE_WIRE_VERSION))");
    for (const unsafe of ["v1|v2", "v1.", "v(1)", "v1+", "", "1", "crossengin.request-signature"]) {
      expect(/^v\d+$/.test(unsafe.split(".").pop() ?? "")).toBe(false);
    }
  });

  it("builds the key-id and hex classes from one pattern each", () => {
    expect(SOURCE).toContain("const KEY_ID_RE = new RegExp(`^${KEY_ID_PATTERN}$`)");
    expect(SOURCE).toContain("const HEX64_RE = new RegExp(`^${HEX64_PATTERN}$`)");
    expect(SOURCE).toContain("`^k=(${KEY_ID_PATTERN})");
    expect(SOURCE).toContain("=(${HEX64_PATTERN})$`");

    // One occurrence each of the class itself: the pattern constant, and nowhere else.
    const withoutComments = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(withoutComments.split("[A-Za-z0-9._-]{1,120}").length - 1).toBe(1);
    expect(withoutComments.split("[0-9a-f]{64}").length - 1).toBe(1);
  });
});

describe("the signature comparison", () => {
  it("refuses a signature differing only past a non-hex character", () => {
    // The hex guard is what makes the constant-time compare honest rather than decorative:
    // Buffer.from(s, "hex") stops at the first non-hex pair, so two values differing only after a
    // stray character would decode to equal buffers of equal length and timingSafeEqual would
    // answer true. Here the pair is refused at the parse, which is the earliest honest place.
    expect(Buffer.from("abzz", "hex").length).toBe(1);

    const good = signatureHexOf(HEADER);
    const nonHex = `${good.slice(0, 10)}z${good.slice(11)}`;
    expect(nonHex.length).toBe(good.length);
    expect(nonHex).not.toBe(good);
    expect(verifyWith(`k=k1,t=${TS.toString()},v1=${nonHex}`, VERIFY_FACTS)).toEqual({
      ok: false,
      reason: "malformed_header",
    });
  });

  it("refuses a well-formed signature differing in one hex character", () => {
    const good = signatureHexOf(HEADER);
    const flipped = `${good.slice(0, 63)}${good.at(63) === "0" ? "1" : "0"}`;
    expect(flipped).not.toBe(good);
    expect(verifyWith(`k=k1,t=${TS.toString()},v1=${flipped}`, VERIFY_FACTS)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });
});

describe("deriveRequestSigningKey", () => {
  it("returns exactly AEAD_KEY_BYTES of raw bytes, above hmacSha256Hex's floor", () => {
    const key = deriveRequestSigningKey(SECRET, "k1");
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(AEAD_KEY_BYTES);
    expect(AEAD_KEY_BYTES).toBe(32);
    expect(() => hmacSha256Hex(key, "x")).not.toThrow();
  });

  it("matches HKDF-SHA256 computed independently with node:crypto", () => {
    const expected = new Uint8Array(
      hkdfSync(
        "sha256",
        new TextEncoder().encode(SECRET_TEXT),
        new TextEncoder().encode("k1"),
        new TextEncoder().encode(REQUEST_SIGNING_KEY_DERIVATION_INFO),
        32,
      ),
    );
    expect(hex(deriveRequestSigningKey(SECRET, "k1"))).toBe(hex(expected));
  });

  it("matches pinned known-answer vectors", () => {
    // Pinned as literals as well as recomputed above. This key is held by a client, so changing
    // the derivation invalidates every key already issued — and unlike a cursor, a client cannot
    // re-request one: an operator has to redistribute secrets. Editing these literals is the
    // deliberate act that says that was considered.
    expect(hex(deriveRequestSigningKey(SECRET, "k1"))).toBe(
      "085bca3681ab0e8b042a8758afeafd10b8620f91a3e869c160cc0ddd3ceb9757",
    );
    expect(hex(deriveRequestSigningKey(SECRET, "k2"))).toBe(
      "24dc03f91175ce80073b4e48945a7f30a2626ae4190989bb22ab4f5f71db660a",
    );
  });

  it("is distinct per key id and stable for one key id", () => {
    // The key id is the unit of issuance and revocation, so two ids sharing a secret would make
    // revoking one revoke neither.
    expect(hex(deriveRequestSigningKey(SECRET, "k1"))).not.toBe(
      hex(deriveRequestSigningKey(SECRET, "k2")),
    );
    expect(hex(deriveRequestSigningKey(SECRET, "k1"))).toBe(
      hex(deriveRequestSigningKey(SECRET, "k1")),
    );
  });

  it("refuses an empty key id rather than salting with nothing", () => {
    // An empty salt is legal HKDF, so without the check every unnamed key would share one secret.
    expect(() => deriveRequestSigningKey(SECRET, "")).toThrow(/keyId must be non-empty/);
  });

  it("is none of the other three keys for the same secret and the same salt string", () => {
    // The info strings are the entire separation between the four derivations, so it is asserted
    // rather than assumed: a request-signing key is handed to a client, so without it a client
    // would hold the key that decrypts a PHI column.
    const signing = hex(deriveRequestSigningKey(SECRET, "k1"));
    const column = Buffer.from(deriveTenantColumnKey(SECRET, "k1"), "base64").toString("hex");
    const cursor = hex(deriveTenantCursorKey(SECRET, "k1"));
    const kek = hex(deriveTenantKek(SECRET, "k1"));

    expect(new Set([signing, column, cursor, kek]).size).toBe(4);
    expect(
      new Set([
        REQUEST_SIGNING_KEY_DERIVATION_INFO,
        COLUMN_KEY_DERIVATION_INFO,
        CURSOR_KEY_DERIVATION_INFO,
        KEK_KEY_DERIVATION_INFO,
      ]).size,
    ).toBe(4);
    expect(REQUEST_SIGNING_KEY_DERIVATION_INFO).toBe("crossengin.request-signing.v1");
  });
});

describe("parseRequestSigningSecret", () => {
  it("refuses a weak secret with each reason, naming the request-signing variable", () => {
    // The label is a parameter precisely so an operator configuring this secret is not sent to
    // the column one; the reasons are the shared set, since one floor serves every deployment
    // secret this module validates.
    const cases: readonly (readonly [string, string])[] = [
      ["too_short", "tiny"],
      ["too_uniform", "a".repeat(40)],
      ["unreplaced_placeholder", "REPLACE_WITH_32_PLUS_RANDOM_CHARS"],
    ];
    for (const [reason, raw] of cases) {
      try {
        parseRequestSigningSecret(raw);
        expect.unreachable(`${raw} must be refused`);
      } catch (err) {
        expect(err).toBeInstanceOf(ColumnSecretRefused);
        const refusal = err as ColumnSecretRefused;
        expect(refusal.reason).toBe(reason);
        expect(refusal.message).toContain("request-signing secret");
        expect(refusal.message).not.toContain(raw);
      }
    }
    expect(new Set(cases.map(([reason]) => reason))).toEqual(
      new Set(COLUMN_SECRET_REFUSAL_REASONS),
    );
  });

  it("refuses the same weak secret at the derivation, so skipping the parser buys nothing", () => {
    expect(() => deriveRequestSigningKey(new TextEncoder().encode("tiny"), "k1")).toThrow(
      ColumnSecretRefused,
    );
  });
});
