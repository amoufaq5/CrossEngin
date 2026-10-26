import {
  AUTH_SCHEMES,
  AUTH_SCHEME_SUPPORT,
  type AuthScheme,
  type AuthSchemeTreatment,
} from "@crossengin/api-gateway";

/**
 * The two configuration facts that narrow `SERVED_AUTH_SCHEMES` to what a *deployment* can actually
 * authenticate.
 *
 * Both are read off a live `GatewayRuntime` through its `authSchemeServing` getter rather than
 * re-derived by the caller, which is the whole reason the getter exists: a boot line computed from
 * the same two booleans the options were built from is a second derivation of one fact, and
 * ADR-0361's finding is that two readers agreeing is not evidence either is right — there, one
 * narrow read was duplicated across eight call sites and three of them were wrong.
 */
export interface AuthSchemeServingInput {
  /** A JWKS provider reaches the runtime, so `bearer_jwt` can be verified. */
  readonly jwtVerifierConfigured: boolean;
  /** An opaque-token lookup reaches the runtime, so `api_key_header` can be resolved. */
  readonly opaqueLookupConfigured: boolean;
}

/**
 * Which served scheme each configuration fact gates, as a total map over the served schemes.
 *
 * A map rather than two `if`s because the question "is this scheme reachable in this deployment" has
 * to stay answerable for every member of `SERVED_AUTH_SCHEMES`: a third served scheme added to
 * `AUTH_SCHEME_SUPPORT` and not here is a scheme the survey silently reports as served whatever the
 * configuration says, which is the shape of defect this increment is about.
 */
const SERVED_SCHEME_GATE: Readonly<
  Record<"bearer_jwt" | "api_key_header", keyof AuthSchemeServingInput>
> = Object.freeze({
  bearer_jwt: "jwtVerifierConfigured",
  api_key_header: "opaqueLookupConfigured",
});

const isGatedScheme = (scheme: AuthScheme): scheme is keyof typeof SERVED_SCHEME_GATE =>
  Object.hasOwn(SERVED_SCHEME_GATE, scheme);

/** The schemes this deployment can authenticate: served by the binary **and** configured here. */
export function servedAuthSchemesFor(
  input: AuthSchemeServingInput,
): readonly AuthScheme[] {
  return AUTH_SCHEMES.filter((scheme) => {
    if (AUTH_SCHEME_SUPPORT[scheme].treatment !== "served") return false;
    // A served scheme with no gate is unreachable today and reads as *configured* if it ever
    // arrives, which is the permissive direction — so the companion test asserts the gate map
    // covers every served scheme rather than relying on this branch.
    if (!isGatedScheme(scheme)) return true;
    return input[SERVED_SCHEME_GATE[scheme]];
  });
}

/** The schemes carrying a given treatment, in `AUTH_SCHEMES` order. */
export function authSchemesByTreatment(
  treatment: AuthSchemeTreatment,
): readonly AuthScheme[] {
  return AUTH_SCHEMES.filter((s) => AUTH_SCHEME_SUPPORT[s].treatment === treatment);
}

/** `a`, `a and b`, `a, b and c` — the repo's boot lines read as sentences, not as arrays. */
function joinNames(names: readonly string[]): string {
  if (names.length === 0) return "none";
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] as string}`;
}

/**
 * The boot line.
 *
 * ADR-0376's rule: a capability an operator cannot confirm from the log is the one they disbelieve
 * — and here the thing to confirm is a *refusal*, which is harder to confirm by trying it than a
 * capability is, because before this increment trying it answered 200.
 *
 * There is deliberately **no level**: every other survey in `operate-server` that warns does so for
 * a condition that deployment can reach, and the only condition worth warning about here — this
 * deployment serves no scheme at all — is unreachable from it, because `server.ts` passes
 * `wiring.opaqueTokenLookup` unconditionally and `principals.ts` always builds one, so
 * `api_key_header` is always configured there. A `warn` arm describing a state the caller cannot
 * produce is ADR-0381's own finding one file over, and the fix for that was to delete the arm.
 */
export function formatAuthSchemeSurvey(input: AuthSchemeServingInput): string {
  const served = servedAuthSchemesFor(input);
  const refused = authSchemesByTreatment("refused");
  const indistinguishable = authSchemesByTreatment("indistinguishable");
  const unconfigured = AUTH_SCHEMES.filter(
    (s) => AUTH_SCHEME_SUPPORT[s].treatment === "served" && !served.includes(s),
  );
  const sentences = [
    `auth schemes: serving ${joinNames([...served])}`,
    ...(unconfigured.length > 0
      ? [`${joinNames([...unconfigured])} is served by this binary and has no verifier configured`]
      : []),
    `refusing ${joinNames([...refused])} by name`,
    `${joinNames([...indistinguishable])} name no position on the wire, so a request in either is` +
      ` refused as an unrecognized credential rather than by scheme`,
  ];
  return sentences.join("; ");
}
