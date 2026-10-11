import { describe, expect, it } from "vitest";

import {
  API_KEY_SPEC_SOURCES,
  API_KEY_SPECS_VAR,
  ApiKeySpecResolutionSchema,
  formatApiKeySpecSource,
  resolveApiKeySpecs,
  SOURCE_EXPOSES_ARGV,
  type ApiKeySpecSource,
} from "./api-key-source.js";

const SPEC = "tok_abc:platform-admin:11111111-1111-7111-8111-111111111111";
const OTHER = "tok_def:erp_viewer:22222222-2222-7222-8222-222222222222";

describe("the vocabulary", () => {
  it("names the variable after what it holds, not after a token", () => {
    // `deploy/` already carries OPERATE_ADMIN_API_KEY and OPERATE_WEB_API_KEY, which hold bare
    // tokens a *client* sends. A reader who confused the two would hand the server a token with no
    // role and no tenant, so the name says `SPECS`.
    expect(API_KEY_SPECS_VAR).toBe("OPERATE_API_KEY_SPECS");
    expect(API_KEY_SPECS_VAR).not.toMatch(/_API_KEY$/);
  });

  it("says which sources put a credential on the command line, as a total map", () => {
    expect(Object.keys(SOURCE_EXPOSES_ARGV).sort()).toEqual([...API_KEY_SPEC_SOURCES].sort());
    const exposing = [...API_KEY_SPEC_SOURCES].filter((s) => SOURCE_EXPOSES_ARGV[s]);
    expect(exposing).toEqual(["argv_only", "both"]);
  });

  it("refuses a resolution whose counts are not counts", () => {
    const base = { specs: [SPEC], source: "argv_only", fromArgv: 1, fromEnv: 0 };
    expect(() => ApiKeySpecResolutionSchema.parse(base)).not.toThrow();
    expect(() => ApiKeySpecResolutionSchema.parse({ ...base, fromArgv: -1 })).toThrow();
    expect(() => ApiKeySpecResolutionSchema.parse({ ...base, fromArgv: 1.5 })).toThrow();
    expect(() => ApiKeySpecResolutionSchema.parse({ ...base, source: "nope" })).toThrow();
    expect(() => ApiKeySpecResolutionSchema.parse({ ...base, specs: [""] })).toThrow();
  });
});

describe("resolveApiKeySpecs", () => {
  it("reads nothing when neither source declares one", () => {
    const r = resolveApiKeySpecs([], {});
    expect(r).toMatchObject({ specs: [], source: "none", fromArgv: 0, fromEnv: 0 });
  });

  it("takes argv alone, and reports it as the exposing source", () => {
    const r = resolveApiKeySpecs([SPEC], {});
    expect(r).toMatchObject({ specs: [SPEC], source: "argv_only", fromArgv: 1, fromEnv: 0 });
    expect(SOURCE_EXPOSES_ARGV[r.source]).toBe(true);
  });

  it("takes the environment alone, which is the route ADR-0301 asks for", () => {
    const r = resolveApiKeySpecs([], { [API_KEY_SPECS_VAR]: SPEC });
    expect(r).toMatchObject({ specs: [SPEC], source: "env_only", fromArgv: 0, fromEnv: 1 });
    expect(SOURCE_EXPOSES_ARGV[r.source]).toBe(false);
  });

  it("concatenates both rather than letting one win", () => {
    // Precedence would mean a deployment that set the variable and forgot the flag silently served
    // one set, and which set depends on a rule nobody reads.
    const r = resolveApiKeySpecs([SPEC], { [API_KEY_SPECS_VAR]: OTHER });
    expect(r.specs).toEqual([SPEC, OTHER]);
    expect(r.source).toBe("both");
    expect(r).toMatchObject({ fromArgv: 1, fromEnv: 1 });
  });

  it("puts argv first, so a caller's order is preserved within each source", () => {
    const r = resolveApiKeySpecs([SPEC, OTHER], { [API_KEY_SPECS_VAR]: "tok_ghi:r:t" });
    expect(r.specs).toEqual([SPEC, OTHER, "tok_ghi:r:t"]);
  });

  it("splits on newline, which is what a compose environment block takes cleanly", () => {
    const r = resolveApiKeySpecs([], { [API_KEY_SPECS_VAR]: `${SPEC}\n${OTHER}` });
    expect(r.specs).toEqual([SPEC, OTHER]);
    expect(r.fromEnv).toBe(2);
  });

  it("splits on comma, which is what a .env file takes cleanly", () => {
    const r = resolveApiKeySpecs([], { [API_KEY_SPECS_VAR]: `${SPEC},${OTHER}` });
    expect(r.specs).toEqual([SPEC, OTHER]);
  });

  it("keeps a spec's own colons intact — the separator is never a colon", () => {
    // The spec is `token:role:tenant[:principal]`, so splitting on a colon would shred it.
    const withPrincipal = `${SPEC}:33333333-3333-7333-8333-333333333333`;
    const r = resolveApiKeySpecs([], { [API_KEY_SPECS_VAR]: withPrincipal });
    expect(r.specs).toEqual([withPrincipal]);
    expect(r.specs[0]?.split(":")).toHaveLength(4);
  });

  it("trims and drops blanks, so a trailing separator is not a spec", () => {
    const r = resolveApiKeySpecs([], { [API_KEY_SPECS_VAR]: `  ${SPEC}  ,\n\n, ${OTHER},` });
    expect(r.specs).toEqual([SPEC, OTHER]);
  });

  it("treats an empty or whitespace variable as absent rather than as one blank spec", () => {
    expect(resolveApiKeySpecs([], { [API_KEY_SPECS_VAR]: "" }).source).toBe("none");
    expect(resolveApiKeySpecs([], { [API_KEY_SPECS_VAR]: "   \n  " }).source).toBe("none");
  });

  it("ignores every other variable, including the token-shaped ones deploy/ already sets", () => {
    const r = resolveApiKeySpecs([], {
      OPERATE_ADMIN_API_KEY: "tok_admin",
      OPERATE_WEB_API_KEY: "tok_web",
      OPERATE_API_KEY: "tok_plain",
    });
    expect(r.source).toBe("none");
    expect(r.specs).toEqual([]);
  });
});

describe("formatApiKeySpecSource", () => {
  it("says nothing was declared", () => {
    expect(formatApiKeySpecSource(resolveApiKeySpecs([], {}))).toContain("none declared");
  });

  it("is affirmative when the credentials are off the command line", () => {
    // "we checked and found nothing" cannot be claimed from the absence of a log line.
    const line = formatApiKeySpecSource(resolveApiKeySpecs([], { [API_KEY_SPECS_VAR]: SPEC }));
    expect(line).toContain("none on the command line");
    expect(line).not.toMatch(/ps`/);
  });

  it("names the variable and the reason when a spec is on argv", () => {
    for (const r of [
      resolveApiKeySpecs([SPEC], {}),
      resolveApiKeySpecs([SPEC], { [API_KEY_SPECS_VAR]: OTHER }),
    ]) {
      const line = formatApiKeySpecSource(r);
      expect(line).toContain(API_KEY_SPECS_VAR);
      expect(line).toContain("ps");
      expect(line).toContain("credential");
    }
  });

  it("never prints a spec, because the token is the credential", () => {
    const line = formatApiKeySpecSource(
      resolveApiKeySpecs([SPEC], { [API_KEY_SPECS_VAR]: OTHER }),
    );
    expect(line).not.toContain("tok_abc");
    expect(line).not.toContain("tok_def");
  });

  it("reports both counts so a half-migrated deployment can see which half moved", () => {
    const line = formatApiKeySpecSource(
      resolveApiKeySpecs([SPEC], { [API_KEY_SPECS_VAR]: `${OTHER}\ntok_ghi:r:t` }),
    );
    expect(line).toContain("1 from argv");
    expect(line).toContain(`2 from ${API_KEY_SPECS_VAR}`);
  });

  it("covers every source, so a fifth cannot land without a line", () => {
    const sources = new Set<ApiKeySpecSource>();
    for (const r of [
      resolveApiKeySpecs([], {}),
      resolveApiKeySpecs([SPEC], {}),
      resolveApiKeySpecs([], { [API_KEY_SPECS_VAR]: SPEC }),
      resolveApiKeySpecs([SPEC], { [API_KEY_SPECS_VAR]: OTHER }),
    ]) {
      sources.add(r.source);
      expect(formatApiKeySpecSource(r).length).toBeGreaterThan(20);
    }
    expect([...sources].sort()).toEqual([...API_KEY_SPEC_SOURCES].sort());
  });
});
