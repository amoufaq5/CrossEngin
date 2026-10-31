import {
  AUTH_SCHEMES,
  AUTH_SCHEME_SUPPORT,
  SERVED_AUTH_SCHEMES,
  type AuthScheme,
} from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import {
  authSchemesByTreatment,
  formatAuthSchemeSurvey,
  servedAuthSchemesFor,
  type AuthSchemeServingInput,
} from "./auth-scheme-survey.js";

// `ALL` rather than `ALL`: the input is three facts since `hmac_signature` became served, and
// the rename is deliberate so a fourth gate cannot land under a name that claims a count.
const ALL: AuthSchemeServingInput = {
  jwtVerifierConfigured: true,
  opaqueLookupConfigured: true,
  hmacKeyLookupConfigured: true,
  mtlsClientLookupConfigured: true,
};
const NEITHER: AuthSchemeServingInput = {
  jwtVerifierConfigured: false,
  opaqueLookupConfigured: false,
  hmacKeyLookupConfigured: false,
  mtlsClientLookupConfigured: false,
};
const API_KEY_ONLY: AuthSchemeServingInput = {
  jwtVerifierConfigured: false,
  opaqueLookupConfigured: true,
  hmacKeyLookupConfigured: false,
  mtlsClientLookupConfigured: false,
};
const SIGNATURE_ONLY: AuthSchemeServingInput = {
  jwtVerifierConfigured: false,
  opaqueLookupConfigured: false,
  hmacKeyLookupConfigured: true,
  mtlsClientLookupConfigured: false,
};

describe("servedAuthSchemesFor", () => {
  it("all configured serves every served scheme, in AUTH_SCHEMES order", () => {
    expect(servedAuthSchemesFor(ALL)).toEqual([
      "bearer_jwt",
      "api_key_header",
      "mtls",
      "hmac_signature",
    ]);
  });

  it("neither configured serves nothing", () => {
    expect(servedAuthSchemesFor(NEITHER)).toEqual([]);
  });

  it("an api-key-only deployment serves api_key_header alone", () => {
    expect(servedAuthSchemesFor(API_KEY_ONLY)).toEqual(["api_key_header"]);
  });

  it("a jwt-only deployment serves bearer_jwt alone", () => {
    expect(
      servedAuthSchemesFor({
        jwtVerifierConfigured: true,
        opaqueLookupConfigured: false,
        hmacKeyLookupConfigured: false,
        mtlsClientLookupConfigured: false,
      }),
    ).toEqual(["bearer_jwt"]);
  });

  it("a signature-only deployment serves hmac_signature alone", () => {
    // The gate is per scheme, so a deployment issuing signing keys and no api keys is expressible —
    // which is the state an unattended integration wants, and the state that would have read as
    // "served" whatever the configuration said had the gate map not gained a third entry.
    expect(servedAuthSchemesFor(SIGNATURE_ONLY)).toEqual(["hmac_signature"]);
  });

  it("never reports a scheme the binary does not serve, whatever the configuration", () => {
    for (const input of [ALL, NEITHER, API_KEY_ONLY, SIGNATURE_ONLY]) {
      for (const scheme of servedAuthSchemesFor(input)) {
        expect(AUTH_SCHEME_SUPPORT[scheme].treatment).toBe("served");
      }
    }
  });

  /**
   * The gate map must cover every served scheme. A third served scheme declared in
   * `AUTH_SCHEME_SUPPORT` and absent from `SERVED_SCHEME_GATE` falls through to the permissive
   * branch and is reported served whatever the configuration says — this increment's own class
   * inside its own survey — so the fence is here rather than in that branch.
   */
  it("every served scheme is gated by a configuration fact", () => {
    const gated = new Set<AuthScheme>();
    for (const scheme of SERVED_AUTH_SCHEMES) {
      const servedWithNeither = servedAuthSchemesFor(NEITHER).includes(scheme);
      if (!servedWithNeither) gated.add(scheme);
    }
    expect([...gated].sort()).toEqual([...SERVED_AUTH_SCHEMES].sort());
  });

  it("the answer is a subset of SERVED_AUTH_SCHEMES in every configuration", () => {
    for (const input of [ALL, NEITHER, API_KEY_ONLY, SIGNATURE_ONLY]) {
      for (const scheme of servedAuthSchemesFor(input)) {
        expect(SERVED_AUTH_SCHEMES).toContain(scheme);
      }
    }
  });
});

describe("authSchemesByTreatment", () => {
  it("partitions AUTH_SCHEMES exactly once over the four treatments", () => {
    const seen = [
      ...authSchemesByTreatment("served"),
      ...authSchemesByTreatment("refused"),
      ...authSchemesByTreatment("indistinguishable"),
      ...authSchemesByTreatment("not_a_credential"),
    ];
    expect(seen).toHaveLength(AUTH_SCHEMES.length);
    expect([...seen].sort()).toEqual([...AUTH_SCHEMES].sort());
  });

  it("preserves AUTH_SCHEMES order, so the boot line is stable across runs", () => {
    const refused = authSchemesByTreatment("refused");
    const positions = refused.map((s) => AUTH_SCHEMES.indexOf(s));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("formatAuthSchemeSurvey", () => {
  it("names the served schemes, the refusals and the indistinguishable one", () => {
    const line = formatAuthSchemeSurvey(ALL);
    expect(line).toContain("serving bearer_jwt, api_key_header, mtls and hmac_signature");
    expect(line).toContain("refusing");
    for (const scheme of authSchemesByTreatment("refused")) {
      expect(line).toContain(scheme);
    }
    expect(line).toContain("bearer_opaque");
    // `hmac_signature` is in the *served* clause now, not the indistinguishable one, so asserting
    // its mere presence anywhere in the line would pass whichever clause held it. The served clause
    // above names it positionally, and this is the complement: it must not be described as naming no
    // position on the wire, which is the sentence it carried before it had a header.
    expect(line).not.toContain("hmac_signature name");
    expect(line).not.toContain("and hmac_signature names no");
  });

  /**
   * The clause an operator needs and that no other boot line carries: a scheme the binary serves
   * and this deployment cannot. Before this survey the only evidence was a 401 at request time
   * recorded as `credential_not_found`.
   */
  it("names a served scheme whose verifier is not configured", () => {
    const line = formatAuthSchemeSurvey(API_KEY_ONLY);
    expect(line).toContain("bearer_jwt is served by this binary and has no JWKS verifier configured");
  });

  /**
   * Each unconfigured scheme names *its own* missing fact, which is what the single joined clause
   * could not do: `api_key_header` is gated on an opaque-token lookup, so reporting it as "no
   * verifier configured" would send an operator to look for a JWKS (ADR-0334).
   *
   * Unreachable from `operate-server` — `principals.ts` types `opaqueTokenLookup` non-optional and
   * `server.ts` passes it unconditionally, so `api_key_header` is always configured there — which
   * is exactly why it is asserted here: the one reachable state is the one where the wrong noun
   * happens to read correctly, so nothing else would ever have caught it.
   */
  it("names the right missing fact per scheme, with no plural-subject clause", () => {
    const line = formatAuthSchemeSurvey(NEITHER);
    expect(line).toContain("bearer_jwt is served by this binary and has no JWKS verifier configured");
    expect(line).toContain(
      "api_key_header is served by this binary and has no opaque-token lookup configured",
    );
    // The shape the joined clause produced, and the reason it is gone.
    expect(line).not.toContain("bearer_jwt and api_key_header is served");
  });

  it("omits the unconfigured clause when both verifiers are present", () => {
    expect(formatAuthSchemeSurvey(ALL)).not.toContain("is served by this binary and has");
  });

  it("says 'none' rather than an empty gap when nothing is served", () => {
    expect(formatAuthSchemeSurvey(NEITHER)).toContain("serving none");
  });

  // Said either way, including when there is nothing to warn about — ADR-0376's rule, which is why
  // the affirmative case is asserted rather than only the finding.
  it("is a non-empty sentence in every configuration", () => {
    for (const input of [ALL, NEITHER, API_KEY_ONLY, SIGNATURE_ONLY]) {
      const line = formatAuthSchemeSurvey(input);
      expect(line.length).toBeGreaterThan(60);
      expect(line.startsWith("auth schemes:")).toBe(true);
    }
  });

  it("never renders a scheme name twice in one clause", () => {
    const line = formatAuthSchemeSurvey(ALL);
    const occurrences = (line.match(/api_key_header/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  // A credential must not reach a log line, and the survey is the one place in this increment that
  // renders prose at boot: it reads the map and the two booleans and never a request.
  it("renders only declared names, never a token or a header value", () => {
    const line = formatAuthSchemeSurvey(ALL);
    for (const word of line.split(/[\s,;]+/)) {
      const bare = word.replace(/[^\w-]/g, "");
      if (bare.length === 0) continue;
      expect(bare).not.toMatch(/^ce_(live|test)_/);
    }
  });

  // The refusals render in `AUTH_SCHEMES` order (`api_key_query`, `basic`) and not alphabetically
  // or by treatment, which is what the order-preservation assertion above pins; this one pins the
  // conjunction, so a list rendered as `a, b, c` is a visible change.
  //
  // Serving `mtls` moved which clause exercises which arm, and the test is better for it: the
  // comma-list arm is now the **served** clause (four members) and the two-member arm is the
  // **refused** one, so both are asserted on the same line for one input instead of needing a
  // second deployment shape for the short form. `mtls` sits between `api_key_header` and
  // `hmac_signature` because that is its position in `AUTH_SCHEMES`, which is the order-preservation
  // property restated.
  it("uses 'and' for two and a comma list for more", () => {
    expect(formatAuthSchemeSurvey(ALL)).toContain(
      "bearer_jwt, api_key_header, mtls and hmac_signature",
    );
    expect(formatAuthSchemeSurvey(ALL)).toContain("api_key_query and basic");
    expect(
      formatAuthSchemeSurvey({
        jwtVerifierConfigured: true,
        opaqueLookupConfigured: true,
        hmacKeyLookupConfigured: false,
        mtlsClientLookupConfigured: false,
      }),
    ).toContain("serving bearer_jwt and api_key_header");
    // And the one-member form, which the indistinguishable clause is now the only user of.
    expect(formatAuthSchemeSurvey(ALL)).toContain("bearer_opaque names no position on the wire");
    expect(formatAuthSchemeSurvey(ALL)).toContain("a request in it is refused");
  });
});
