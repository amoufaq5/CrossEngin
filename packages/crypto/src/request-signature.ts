import { timingSafeEqual } from "node:crypto";

import { hmacSha256Hex } from "./hmac.js";

/**
 * The domain tag the canonical message opens with, and the `v1` the wire format carries.
 *
 * Declared and never probed, which is `SEALED_CURSOR_PREFIX`'s rule (ADR-0346) and the four
 * `crossengin.tombstone.content.v*` tags' (ADR-0351): a reader selects the message version from an
 * explicit field rather than inferring it from the shape, because an inference reads a *stripped*
 * field as an older format — a tamper that covers its own tracks.
 *
 * It is the **message** version and not the algorithm's: a second canonical message ships as `v2`
 * at the same offset, and `hmac-sha256` is fixed by `MAC_ALGORITHMS`.
 */
export const REQUEST_SIGNATURE_DOMAIN_V1 = "crossengin.request-signature.v1";

/**
 * The `v<n>=` field the wire format carries the signature under — **derived from the domain tag**,
 * which is the one thing that makes the field honest.
 *
 * Measured rather than reasoned: the wire version is deliberately *not* inside the canonical
 * message (the domain tag is), so with the two declared independently and the version flipped to
 * `v2`, `signRequest` emitted `k=…,v2=<hex>` where `<hex>` was **byte-identical** to the v1
 * signature — so a captured v1 header, relabelled `v2=`, would verify, and the version field would
 * name a message format the signature is not over. One spelling cannot say two things, and a
 * second canonical message means a second domain tag, so the version comes out of the tag.
 *
 * Bounded to `v<digits>` at module load, which is what makes interpolating it into `HEADER_RE` safe
 * by construction rather than by a convention: a version carrying a regex metacharacter would widen
 * the parser silently. A second message ships as a `.v2` tag plus a map from version to tag
 * (`PROOF_VERSION_COVERAGE`'s shape) rather than as a second independent constant.
 */
export const REQUEST_SIGNATURE_WIRE_VERSION =
  REQUEST_SIGNATURE_DOMAIN_V1.split(".").pop() ?? "";

if (!/^v\d+$/.test(REQUEST_SIGNATURE_WIRE_VERSION)) {
  throw new Error(
    `the domain tag's last segment must be v<digits> so it can name the wire version and be interpolated into the header pattern, got ${REQUEST_SIGNATURE_DOMAIN_V1}`,
  );
}

/**
 * There is deliberately **no header-name constant here**, and the split is the point: this module
 * owns the *value* — the canonical message, the grammar, the sign and the verify — while which
 * position on the wire carries it is the gateway's contract, declared as
 * `REQUEST_SIGNATURE_HEADER` in `@crossengin/api-gateway` beside `API_KEY_HEADER`, the existing
 * precedent for exactly this question.
 *
 * It is also the only split the dependency graph permits in one spelling: `@crossengin/api-gateway`
 * has no workspace dependencies at all, so a name declared here could only reach the support map
 * and the security doc as a second copy — and the security doc's `name` is a machine value a client
 * generator emits code from, which is the worst place for one.
 */

/**
 * A key id is **not** a secret, and that is load-bearing rather than incidental.
 *
 * It travels in the clear in the header, so it may be logged, may be a principal reference and may
 * be compared without a constant-time primitive. That is the one structural advantage this scheme
 * has over an api key: `principals.ts` refuses to derive a principal id from an api key because
 * "a principal id is not a secret (it lands in `meta.audit_log`) and a reversible-by-brute-force
 * function of a credential turns an audit reader into an offline attacker" — an argument about the
 * *credential* being the only distinguishing field, which does not apply here.
 *
 * Bounded to `tchar`-safe characters and 120 to match `ParsedAuthCredential.hmacKeyId`'s own bound,
 * minus the characters that would end a field in the wire grammar.
 */
const KEY_ID_PATTERN = "[A-Za-z0-9._-]{1,120}";
const KEY_ID_RE = new RegExp(`^${KEY_ID_PATTERN}$`);

/** `hmacSha256Hex` emits lower-case hex; a signature is compared against that and nothing else. */
const HEX64_PATTERN = "[0-9a-f]{64}";
const HEX64_RE = new RegExp(`^${HEX64_PATTERN}$`);

/** The facts a request signature covers. Every one is on the **typed** `IncomingRequest`. */
export interface RequestSignatureFacts {
  readonly keyId: string;
  /** Integer unix **seconds**, matching `signWebhookPayload` rather than an ISO instant. */
  readonly timestampSeconds: number;
  readonly method: string;
  readonly path: string;
  /** As `IncomingRequest.query` carries it: unsorted, one value or several. */
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  /**
   * `sha256(body)` hex, or **`null` for no body**.
   *
   * The digest and not the bytes, for three reasons that compose. It is declared on
   * `IncomingRequest` (`bodySha256`) where the bytes are not, so a verifier needs no cast —
   * `rawBody` lives on `RuntimeIncomingRequest` and reaches the pipeline only because
   * `PipelineState.request` is typed to the narrower contract. It is already computed on every
   * request by `bodyHashFromBytes`, so covering it is free. And a client can compute it: measured,
   * `bodyHashFromBytes` is plain `sha256(bytes)` hex with no framing.
   *
   * `null` rather than a sentinel string, which is only safe because the canonical message is an
   * **array**: `computeRequestHashInputs` needs `?? "no-body"` precisely because it joins on `|`,
   * and that join is the construction `cursorSealAad` refuses by name.
   */
  readonly bodySha256: string | null;
  readonly host: string;
  /**
   * Covered so a signature minted against staging cannot be replayed against production, which no
   * other field refuses: a key id, a path and a body are identical across environments.
   */
  readonly scheme: string;
}

/**
 * The bytes a request signature is computed over: **canonical JSON of an array**, opening with the
 * domain tag.
 *
 * An array rather than a delimiter-joined string, for `cursorSealAad`'s reason (ADR-0346) and
 * `dataKeyWrapAad`'s (ADR-0347): JSON renders it unambiguously by construction, where a joined
 * form would rest on an assumption about which characters a path, a query key or a key id cannot
 * contain. The repo has a measured instance of that assumption being wrong —
 * `computeRequestHashInputs` joins `[method, path, principalId, bodySha256]` on `|`, and both
 * `IncomingRequest.path` and a spec-supplied `principalId` admit a `|` — so the nearest existing
 * precedent for *identifying a request* is the one construction this must not copy.
 *
 * **The query is covered, and sorted.** Omitting it would let a captured signature be replayed
 * against a different `?filter=`, which changes which rows come back — ADR-0359's own class, where
 * a dropped surface widens the answer rather than narrowing it. `query` is measured unsorted
 * (insertion order), so the keys are sorted here and a multi-value's own order is preserved,
 * because `?sort=a&sort=b` and `?sort=b&sort=a` are different requests to `parseListQuery`.
 *
 * **`operationId` is deliberately absent.** This message is verified at `authenticate`, which is
 * stage 5, and `match_route` is stage 7 — so no route, no operation id and no api version are in
 * hand. That is stated here rather than discovered by whoever first wants per-operation policy:
 * binding one would move the check to stage 12, and the cost of that position is measured in
 * ADR-0393.
 */
export function canonicalRequestSignatureMessage(facts: RequestSignatureFacts): Uint8Array {
  const query = Object.keys(facts.query)
    .sort()
    .map((key) => {
      const value = facts.query[key];
      return [key, typeof value === "string" ? [value] : [...(value ?? [])]];
    });
  return Buffer.from(
    JSON.stringify([
      REQUEST_SIGNATURE_DOMAIN_V1,
      facts.keyId,
      facts.timestampSeconds,
      facts.method,
      facts.path,
      query,
      facts.bodySha256,
      facts.host,
      facts.scheme,
    ]),
    "utf8",
  );
}

/** The `CrossEngin-Request-Signature` value for these facts under this key. */
export function signRequest(keyBytes: Uint8Array, facts: RequestSignatureFacts): string {
  if (!Number.isInteger(facts.timestampSeconds) || facts.timestampSeconds <= 0) {
    throw new Error(
      `timestampSeconds must be a positive integer, got ${String(facts.timestampSeconds)}`,
    );
  }
  if (!KEY_ID_RE.test(facts.keyId)) {
    throw new Error(`key id must match ${String(KEY_ID_RE)}`);
  }
  const signatureHex = hmacSha256Hex(keyBytes, canonicalRequestSignatureMessage(facts));
  return `k=${facts.keyId},t=${facts.timestampSeconds.toString()},${REQUEST_SIGNATURE_WIRE_VERSION}=${signatureHex}`;
}

/**
 * The three fields the header carries, before any key is resolved.
 *
 * Parsing is separated from verifying because the **key id is needed to find the secret**: a
 * verifier cannot be handed a key, it has to be told which one. That ordering is why
 * `parseRequestSignatureHeader` answers a value rather than a verdict.
 */
export interface ParsedRequestSignature {
  readonly keyId: string;
  readonly timestampSeconds: number;
  readonly signatureHex: string;
}

/**
 * Anchored, ordered and exact: `k=`, then `t=`, then the wire version, nothing else.
 *
 * Order is fixed rather than parsed as an unordered field set, and the reason is the message: a
 * signature covers the *facts*, not the header's rendering, so two renderings of one signature
 * would both verify and a cache or a dedup keyed on the header text would see two credentials. One
 * spelling per signature keeps the header and the message in bijection.
 *
 * **Derived from the three constants the signer uses, never written out again.** Each of the three
 * had a second spelling here and one of them was live: with `REQUEST_SIGNATURE_WIRE_VERSION`
 * flipped to `v2`, `signRequest` emitted `v2=` and this parser — its own — answered `null`, so the
 * signer and the verifier disagreed with **no compile error**, in the module whose doc above
 * anticipates exactly that change (*"a second canonical message ships as `v2` at the same
 * offset"*). ADR-0288's maintained list, which this repo has found wrong four times. The key-id
 * class and the hex class were the same shape one field across, latent because neither has moved.
 */
const HEADER_RE = new RegExp(
  `^k=(${KEY_ID_PATTERN}),t=(\\d{1,19}),${REQUEST_SIGNATURE_WIRE_VERSION}=(${HEX64_PATTERN})$`,
);

export function parseRequestSignatureHeader(header: string): ParsedRequestSignature | null {
  const match = HEADER_RE.exec(header);
  if (match === null) return null;
  const timestampSeconds = Number.parseInt(match[2]!, 10);
  // `\d{1,19}` admits values past `Number.MAX_SAFE_INTEGER`, where `parseInt` loses precision and
  // the integer test still passes — so the bound is checked against the safe range rather than
  // against the digit count. A timestamp that cannot round-trip cannot be compared.
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) return null;
  return { keyId: match[1]!, timestampSeconds, signatureHex: match[3]! };
}

/**
 * Why a request signature was not accepted.
 *
 * `malformed_header` and `timestamp_outside_tolerance` are separated from `signature_mismatch`
 * because each sends a *different* party to a different remedy: a malformed header is the client's
 * encoder, a stale timestamp is either side's clock, and a mismatch is the key or the canonicalised
 * facts. That is the opposite of `CURSOR_REFUSALS`' single `not_for_this_request`, and the
 * difference is which primitive decides: GCM fails identically for a tampered ciphertext, a wrong
 * tenant and a rotated key, so two reasons there would claim a distinction the primitive does not
 * make — while here the three are decided by three separate comparisons, each of which can be
 * reported honestly.
 *
 * What a *caller* is told is a separate decision and is not made here. `verifyRequestSignature`
 * answers a deployment-side reason; the gateway's 401 body is one sentence for every refusal, on
 * the bounce webhook's model (one opaque answer, a distinct reason logged), which the measurement
 * in ADR-0393 found to be the one of the two live HMAC paths that gets disclosure right.
 */
export const REQUEST_SIGNATURE_REFUSALS = [
  "malformed_header",
  "timestamp_outside_tolerance",
  "signature_mismatch",
] as const;
export type RequestSignatureRefusal = (typeof REQUEST_SIGNATURE_REFUSALS)[number];

export type RequestSignatureVerdict =
  | { readonly ok: true; readonly parsed: ParsedRequestSignature }
  | { readonly ok: false; readonly reason: RequestSignatureRefusal };

export interface RequestSignatureVerifyOptions {
  /**
   * The symmetric window, in seconds, around `nowSeconds`.
   *
   * **Symmetric over one parameter**, which is `verifyWebhookSignature`'s shape and deliberately
   * not `resolveAuth`'s: that one is asymmetric over two (`hmacSignatureMaxAgeSeconds` for the
   * past, `clockSkewSeconds` for the future) and compares milliseconds parsed out of an ISO string
   * where the wire format is integer seconds. Two shapes for one question is how the live verifier
   * and the written specification came to disagree; this takes the live one.
   */
  readonly toleranceSeconds: number;
  readonly nowSeconds: number;
}

/**
 * The default window, in seconds, either side of now.
 *
 * Here rather than in the gateway because it is the number that bounds *this* primitive, so the
 * mechanism and its default are one reading — and `RequestSignatureVerifyOptions.toleranceSeconds`
 * stays required, so a caller can only get this value by naming it.
 *
 * It is deliberately **not** a sixth spelling of the repo's other 300s (`WEBHOOK_REPLAY_WINDOW`,
 * the JWT `clockSkewSeconds`, `resolveAuth`'s pair): those bound different questions — how long a
 * *payload* stays acceptable, how far a *clock* may drift, how old a credential may be — and
 * collapsing them would make one deployment knob answer for three policies that are tuned against
 * three different threats. Five minutes matches the webhook window because the threat is the same
 * shape (a captured value replayed), and that is a reason to pick the same *number*, not to share
 * the same constant.
 */
export const DEFAULT_REQUEST_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a header against a resolved key and the facts the gateway holds.
 *
 * The **timestamp is checked before the signature**, and the order is not an optimisation: the
 * timestamp is inside the signed message, so a mismatch would also be reported for a stale
 * credential whose signature is perfectly good, and the operator reading that reason would go
 * looking for a key problem. Checking freshness first makes each reason the first true thing about
 * the request.
 */
export function verifyRequestSignature(
  keyBytes: Uint8Array,
  header: string,
  facts: Omit<RequestSignatureFacts, "keyId" | "timestampSeconds">,
  opts: RequestSignatureVerifyOptions,
): RequestSignatureVerdict {
  const parsed = parseRequestSignatureHeader(header);
  if (parsed === null) return { ok: false, reason: "malformed_header" };
  if (Math.abs(opts.nowSeconds - parsed.timestampSeconds) > opts.toleranceSeconds) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }
  const expected = hmacSha256Hex(
    keyBytes,
    canonicalRequestSignatureMessage({
      ...facts,
      keyId: parsed.keyId,
      timestampSeconds: parsed.timestampSeconds,
    }),
  );
  if (!constantTimeEqualHex(expected, parsed.signatureHex)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true, parsed };
}

/**
 * Compared in constant time, and the hex guard is what makes that true rather than decorative:
 * `Buffer.from(s, "hex")` stops at the first non-hex pair, so two values differing only past a
 * stray character would decode to equal buffers of equal length and `timingSafeEqual` would answer
 * true. `hmacSha256Hex` emits lower-case hex and `HEADER_RE` admits only lower-case, so a
 * mixed-case signature is refused at the parse rather than folded here.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!HEX64_RE.test(a) || !HEX64_RE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
