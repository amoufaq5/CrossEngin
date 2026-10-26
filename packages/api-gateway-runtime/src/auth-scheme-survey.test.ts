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

const BOTH: AuthSchemeServingInput = {
  jwtVerifierConfigured: true,
  opaqueLookupConfigured: true,
};
const NEITHER: AuthSchemeServingInput = {
  jwtVerifierConfigured: false,
  opaqueLookupConfigured: false,
};
const API_KEY_ONLY: AuthSchemeServingInput = {
  jwtVerifierConfigured: false,
  opaqueLookupConfigured: true,
};

describe("servedAuthSchemesFor", () => {
  it("both configured serves both", () => {
    expect(servedAuthSchemesFor(BOTH)).toEqual(["bearer_jwt", "api_key_header"]);
  });

  it("neither configured serves nothing", () => {
    expect(servedAuthSchemesFor(NEITHER)).toEqual([]);
  });

  it("an api-key-only deployment serves api_key_header alone", () => {
    expect(servedAuthSchemesFor(API_KEY_ONLY)).toEqual(["api_key_header"]);
  });

  it("a jwt-only deployment serves bearer_jwt alone", () => {
    expect(
      servedAuthSchemesFor({ jwtVerifierConfigured: true, opaqueLookupConfigured: false }),
    ).toEqual(["bearer_jwt"]);
  });

  it("never reports a scheme the binary does not serve, whatever the configuration", () => {
    for (const input of [BOTH, NEITHER, API_KEY_ONLY]) {
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
    for (const input of [BOTH, NEITHER, API_KEY_ONLY]) {
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
  it("names the served schemes, the refusals and the indistinguishable pair", () => {
    const line = formatAuthSchemeSurvey(BOTH);
    expect(line).toContain("serving bearer_jwt and api_key_header");
    expect(line).toContain("refusing");
    for (const scheme of authSchemesByTreatment("refused")) {
      expect(line).toContain(scheme);
    }
    expect(line).toContain("bearer_opaque");
    expect(line).toContain("hmac_signature");
  });

  /**
   * The clause an operator needs and that no other boot line carries: a scheme the binary serves
   * and this deployment cannot. Before this survey the only evidence was a 401 at request time
   * recorded as `credential_not_found`.
   */
  it("names a served scheme whose verifier is not configured", () => {
    const line = formatAuthSchemeSurvey(API_KEY_ONLY);
    expect(line).toContain("bearer_jwt is served by this binary and has no verifier configured");
  });

  it("omits the unconfigured clause when both verifiers are present", () => {
    expect(formatAuthSchemeSurvey(BOTH)).not.toContain("no verifier configured");
  });

  it("says 'none' rather than an empty gap when nothing is served", () => {
    expect(formatAuthSchemeSurvey(NEITHER)).toContain("serving none");
  });

  // Said either way, including when there is nothing to warn about — ADR-0376's rule, which is why
  // the affirmative case is asserted rather than only the finding.
  it("is a non-empty sentence in every configuration", () => {
    for (const input of [BOTH, NEITHER, API_KEY_ONLY]) {
      const line = formatAuthSchemeSurvey(input);
      expect(line.length).toBeGreaterThan(60);
      expect(line.startsWith("auth schemes:")).toBe(true);
    }
  });

  it("never renders a scheme name twice in one clause", () => {
    const line = formatAuthSchemeSurvey(BOTH);
    const occurrences = (line.match(/api_key_header/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  // A credential must not reach a log line, and the survey is the one place in this increment that
  // renders prose at boot: it reads the map and the two booleans and never a request.
  it("renders only declared names, never a token or a header value", () => {
    const line = formatAuthSchemeSurvey(BOTH);
    for (const word of line.split(/[\s,;]+/)) {
      const bare = word.replace(/[^\w-]/g, "");
      if (bare.length === 0) continue;
      expect(bare).not.toMatch(/^ce_(live|test)_/);
    }
  });

  // The three refusals render in `AUTH_SCHEMES` order (`api_key_query`, `basic`, `mtls`) and not
  // alphabetically or by treatment, which is what the order-preservation assertion above pins; this
  // one pins the conjunction, so a list rendered as `a, b, c` is a visible change.
  it("uses 'and' for two and a comma list for three", () => {
    expect(formatAuthSchemeSurvey(BOTH)).toContain("bearer_jwt and api_key_header");
    expect(formatAuthSchemeSurvey(BOTH)).toContain("api_key_query, basic and mtls");
  });
});
