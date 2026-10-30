import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import {
  API_KEY_HEADER,
  AUTH_SCHEMES,
  AUTH_SCHEME_SECURITY_DOC,
  AUTH_SCHEME_SUPPORT,
  SERVED_AUTH_SCHEMES,
  securityDocMatchesTreatment,
  type AuthScheme,
  type AuthSchemeTreatment,
  type SecuritySchemeDoc,
} from "./auth-resolution.js";

/**
 * OpenAPI's five Security Scheme Object types, and **`object` is not one of them** — which is the
 * defect this block exists to keep closed, because a `securitySchemes` entry carrying an invalid
 * `type` is rejected by every generator and validator that reads the document, so the one artifact
 * whose purpose is to be machine-readable would be unreadable.
 */
const OPENAPI_SECURITY_SCHEME_TYPES = [
  "apiKey",
  "http",
  "mutualTLS",
  "oauth2",
  "openIdConnect",
] as const;
type OpenApiSecuritySchemeType = (typeof OPENAPI_SECURITY_SCHEME_TYPES)[number];

/** Every field OpenAPI 3.1 defines on a Security Scheme Object. */
const OPENAPI_SECURITY_SCHEME_FIELDS = [
  "type",
  "description",
  "name",
  "in",
  "scheme",
  "bearerFormat",
  "flows",
  "openIdConnectUrl",
] as const;

/**
 * Which of those fields each `type` requires and which it merely permits, as a **total map** over
 * the five types — so the three this build does not yet emit (`mutualTLS`, `oauth2`,
 * `openIdConnect`) already carry their rule, and a doc added for one of them is adjudicated rather
 * than waved through. The third bucket, *forbidden*, is **derived** as the complement rather than
 * listed, so the three buckets cannot overlap or leave a field unaccounted for — a partition a test
 * below asserts, because a hand-written forbidden list is the shape ADR-0288's maintained list was.
 */
const SECURITY_SCHEME_FIELD_RULES: Readonly<
  Record<
    OpenApiSecuritySchemeType,
    {
      readonly required: readonly (typeof OPENAPI_SECURITY_SCHEME_FIELDS)[number][];
      readonly optional: readonly (typeof OPENAPI_SECURITY_SCHEME_FIELDS)[number][];
    }
  >
> = Object.freeze({
  apiKey: { required: ["type", "name", "in"], optional: ["description"] },
  http: { required: ["type", "scheme"], optional: ["description", "bearerFormat"] },
  mutualTLS: { required: ["type"], optional: ["description"] },
  oauth2: { required: ["type", "flows"], optional: ["description"] },
  openIdConnect: { required: ["type", "openIdConnectUrl"], optional: ["description"] },
});

const isOpenApiType = (v: unknown): v is OpenApiSecuritySchemeType =>
  (OPENAPI_SECURITY_SCHEME_TYPES as readonly unknown[]).includes(v);

/**
 * Why a doc is not a valid Security Scheme Object, or `[]` — the shape `securityDocMatchesTreatment`
 * uses, and for its stated reason: the value is what a test asserts, so a defect in a *constant*
 * must not be a throw at module load.
 *
 * `key` is skipped here because it is the `components.securitySchemes` key a `security` requirement
 * names rather than a field of the emitted object; that it is the *only* such field is asserted
 * separately, in both directions.
 */
function securitySchemeObjectDefects(doc: SecuritySchemeDoc): readonly string[] {
  const defects: string[] = [];
  if (!isOpenApiType(doc.type)) {
    return [`type_not_an_openapi_security_scheme_type:${String(doc.type)}`];
  }
  const rule = SECURITY_SCHEME_FIELD_RULES[doc.type];
  const permitted = new Set<string>([...rule.required, ...rule.optional]);
  // Through `Object.entries` rather than indexing the typed doc, so a field is *absent* when it is
  // missing **or** explicitly `undefined` — `SecuritySchemeDoc`'s optional fields admit the second,
  // and a presence test over `Object.keys` alone would read `{in: undefined}` as supplied.
  const values = new Map<string, unknown>(Object.entries(doc));
  for (const field of rule.required) {
    if (values.get(field) === undefined) defects.push(`required_field_absent:${field}`);
  }
  for (const [field, value] of values) {
    if (field === "key" || value === undefined) continue;
    if (!permitted.has(field)) defects.push(`field_not_permitted_for_${doc.type}:${field}`);
  }
  if (typeof doc.description !== "string" || doc.description.trim() === "") {
    defects.push("description_absent_or_empty");
  }
  return defects;
}

const nonNullDocs = (): ReadonlyArray<readonly [AuthScheme, SecuritySchemeDoc]> =>
  AUTH_SCHEMES.flatMap((s) => {
    const doc = AUTH_SCHEME_SECURITY_DOC[s];
    return doc === null ? [] : [[s, doc] as const];
  });

/**
 * A generalisation of the shipped `securityDocMatchesTreatment` over *supplied* maps, so the fence
 * can be shown to fire — the shipped one closes over module constants and both are frozen, so there
 * is no input to vary.
 *
 * Its faithfulness is established two ways, because the obvious one is weak on its own: agreeing
 * with the shipped function on the shipped maps is agreement between two empty arrays, which a
 * wrong generalisation also satisfies. So the shipped predicate's *comparison* is pinned as text
 * below. Without that second tie this would be ADR-0362's retired test — a rule compared against a
 * derivation of itself written in the test, calling the single disagreement a property.
 */
const disagreementsOver = (
  doc: Readonly<Record<AuthScheme, SecuritySchemeDoc | null>>,
  support: Readonly<Record<AuthScheme, { readonly treatment: AuthSchemeTreatment }>>,
): readonly AuthScheme[] =>
  AUTH_SCHEMES.filter((s) => (doc[s] !== null) !== (support[s].treatment === "served"));

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(HERE, "..", "..");
const RUNTIME_AUTH = join(PACKAGES_DIR, "api-gateway-runtime", "src", "auth.ts");
const RESOLUTION = join(HERE, "auth-resolution.ts");
const TENANT_GATEWAY_CACHE = join(
  PACKAGES_DIR,
  "..",
  "apps",
  "operate-server",
  "src",
  "tenant-gateway-cache.ts",
);

function readSource(path: string): string {
  const text = readFileSync(path, "utf8");
  // Loud rather than vacuous: a moved or renamed file would otherwise make every `not.toContain`
  // below pass over an empty string.
  if (text.length < 500) throw new Error(`${path} is implausibly short (${text.length} bytes)`);
  return text;
}

const walkTs = (dir: string): readonly string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walkTs(p);
    return e.isFile() && p.endsWith(".ts") ? [p] : [];
  });

const collapseWhitespace = (s: string): string => s.replace(/\s+/g, " ");

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("securityDocMatchesTreatment", () => {
  it("is empty: every served scheme has a doc and no unserved scheme does", () => {
    expect(securityDocMatchesTreatment()).toEqual([]);
  });

  // The weak half of the tie, and labelled as such: both sides are `[]`, so this says the
  // generalisation is not *obviously* wrong and nothing more. The text pin below is what makes it
  // faithful.
  it("the generalisation agrees with the shipped predicate on the shipped maps", () => {
    expect(disagreementsOver(AUTH_SCHEME_SECURITY_DOC, AUTH_SCHEME_SUPPORT)).toEqual(
      securityDocMatchesTreatment(),
    );
  });

  /**
   * The strong half: the shipped predicate's comparison, read out of its own source with comments
   * stripped and whitespace collapsed, is the comparison the generalisation performs. A rewrite of
   * `securityDocMatchesTreatment` into some other rule fails here rather than leaving the variant
   * tests below demonstrating a fence that is no longer the shipped one.
   */
  it("the shipped predicate is that comparison and exactly one spelling of it", () => {
    const code = collapseWhitespace(stripComments(readSource(RESOLUTION)));
    const comparison =
      '(AUTH_SCHEME_SECURITY_DOC[s] !== null) !== (AUTH_SCHEME_SUPPORT[s].treatment === "served")';
    expect(code).toContain(comparison);
    expect(countOccurrences(code, comparison)).toBe(1);
    // Non-vacuity for the strip: the file's real code survived it.
    expect(code).toContain("export const securityDocMatchesTreatment");
    expect(code).toContain("export const AUTH_SCHEME_SECURITY_DOC");
  });

  // Direction one — a *served* scheme whose doc is removed. The cheaper failure of the two: a
  // credential the API accepts that no client is told about.
  it("fires when a served scheme loses its doc", () => {
    for (const served of SERVED_AUTH_SCHEMES) {
      const variant = { ...AUTH_SCHEME_SECURITY_DOC, [served]: null };
      expect(disagreementsOver(variant, AUTH_SCHEME_SUPPORT)).toEqual([served]);
    }
    expect(SERVED_AUTH_SCHEMES.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * Direction two — an *unserved* scheme that gains one, which is the worse direction: a
   * `securitySchemes` entry is a **definition**, so a generator reads it as supported and emits a
   * client method for it, inviting precisely the request `api_key_query` is refused for.
   *
   * Driven over every unserved scheme rather than one, so all three non-served treatments
   * (`refused`, `indistinguishable`, `not_a_credential`) are shown to fire — "served" is the only
   * treatment that admits a doc, and a fence demonstrated on `refused` alone would say nothing
   * about the other two.
   */
  it("fires when any unserved scheme gains a doc, for all three non-served treatments", () => {
    const unserved = AUTH_SCHEMES.filter((s) => AUTH_SCHEME_SECURITY_DOC[s] === null);
    const treatments = new Set(unserved.map((s) => AUTH_SCHEME_SUPPORT[s].treatment));
    expect(treatments).toEqual(new Set(["refused", "indistinguishable", "not_a_credential"]));
    expect(unserved.length).toBe(6);
    for (const scheme of unserved) {
      const variant = {
        ...AUTH_SCHEME_SECURITY_DOC,
        [scheme]: {
          key: "invented",
          type: "http",
          scheme: "bearer",
          description: "a scheme this build does not serve",
        } satisfies SecuritySchemeDoc,
      };
      expect(disagreementsOver(variant, AUTH_SCHEME_SUPPORT)).toEqual([scheme]);
    }
  });

  // Both directions at once, so the predicate is not merely order-sensitive: a swap reports both.
  it("reports both schemes when a doc moves from a served to an unserved scheme", () => {
    const variant = {
      ...AUTH_SCHEME_SECURITY_DOC,
      bearer_jwt: null,
      basic: AUTH_SCHEME_SECURITY_DOC.bearer_jwt,
    };
    expect(disagreementsOver(variant, AUTH_SCHEME_SUPPORT)).toEqual(["bearer_jwt", "basic"]);
  });

  // The other operand: the *treatment* moving rather than the doc. A scheme reclassified away from
  // `served` while its doc stays is the same disagreement reached from the support map.
  it("fires when a documented scheme stops being served", () => {
    const variant = {
      ...AUTH_SCHEME_SUPPORT,
      api_key_header: { ...AUTH_SCHEME_SUPPORT.api_key_header, treatment: "refused" as const },
    };
    expect(disagreementsOver(AUTH_SCHEME_SECURITY_DOC, variant)).toEqual(["api_key_header"]);
  });
});

describe("AUTH_SCHEME_SECURITY_DOC is a valid OpenAPI Security Scheme Object", () => {
  it("is total over AUTH_SCHEMES", () => {
    expect(Object.keys(AUTH_SCHEME_SECURITY_DOC).sort()).toEqual([...AUTH_SCHEMES].sort());
  });

  it("every non-null doc has no defects", () => {
    const docs = nonNullDocs();
    // Floor: a pass over zero docs would be the vacuity this whole block is about.
    expect(docs.length).toBe(2);
    for (const [scheme, doc] of docs) {
      expect(securitySchemeObjectDefects(doc), `${scheme}: ${doc.key}`).toEqual([]);
    }
  });

  it("every type is one of OpenAPI's five, and `object` is not among them", () => {
    for (const [, doc] of nonNullDocs()) {
      expect(OPENAPI_SECURITY_SCHEME_TYPES).toContain(doc.type);
    }
    expect(OPENAPI_SECURITY_SCHEME_TYPES).not.toContain("object" as never);
    // The two types this build emits, pinned as a literal so adding a third is a visible change
    // here rather than an untested arm of `SECURITY_SCHEME_FIELD_RULES`.
    expect([...new Set(nonNullDocs().map(([, d]) => d.type))].sort()).toEqual(["apiKey", "http"]);
  });

  it("an apiKey doc carries `in` and `name` and no `scheme` or `bearerFormat`", () => {
    const apiKeys = nonNullDocs().filter(([, d]) => d.type === "apiKey");
    expect(apiKeys.length).toBe(1);
    for (const [, doc] of apiKeys) {
      expect(doc.in).toBe("header");
      expect(doc.name).toBe(API_KEY_HEADER);
      expect(doc.scheme).toBeUndefined();
      expect(doc.bearerFormat).toBeUndefined();
    }
  });

  it("an http doc carries `scheme` and no `in` or `name`", () => {
    const https = nonNullDocs().filter(([, d]) => d.type === "http");
    expect(https.length).toBe(1);
    for (const [, doc] of https) {
      expect(doc.scheme).toBe("bearer");
      expect(doc.bearerFormat).toBe("JWT");
      expect(doc.in).toBeUndefined();
      expect(doc.name).toBeUndefined();
    }
  });

  // `description` is OPTIONAL in OpenAPI and REQUIRED by `SecuritySchemeDoc`, deliberately: an
  // entry with none is a credential a client is told about and not told how to obtain.
  it("every doc carries a non-empty description", () => {
    for (const [, doc] of nonNullDocs()) {
      expect(doc.description.trim().length).toBeGreaterThan(20);
    }
  });

  it("the field rules partition every OpenAPI field for every type", () => {
    expect(Object.keys(SECURITY_SCHEME_FIELD_RULES).sort()).toEqual(
      [...OPENAPI_SECURITY_SCHEME_TYPES].sort(),
    );
    for (const type of OPENAPI_SECURITY_SCHEME_TYPES) {
      const { required, optional } = SECURITY_SCHEME_FIELD_RULES[type];
      // Disjoint, and both subsets of the vocabulary — so the derived *forbidden* complement is
      // exactly what is left and cannot silently include a field a type needs.
      expect(required.filter((f) => optional.includes(f))).toEqual([]);
      for (const f of [...required, ...optional]) {
        expect(OPENAPI_SECURITY_SCHEME_FIELDS).toContain(f);
      }
      expect(required).toContain("type");
    }
  });
});

describe("securitySchemeObjectDefects fires", () => {
  const bearer = AUTH_SCHEME_SECURITY_DOC.bearer_jwt as SecuritySchemeDoc;
  const apiKey = AUTH_SCHEME_SECURITY_DOC.api_key_header as SecuritySchemeDoc;

  // The validator is itself a fence, so it is mutation-checked rather than asserted to pass. Each
  // of these was reachable before this block existed.
  it("reports a type OpenAPI does not define", () => {
    const defects = securitySchemeObjectDefects({
      ...bearer,
      type: "object" as never,
    });
    expect(defects).toEqual(["type_not_an_openapi_security_scheme_type:object"]);
  });

  it("reports an apiKey doc missing `in`", () => {
    const { in: _dropped, ...rest } = apiKey;
    expect(securitySchemeObjectDefects(rest as SecuritySchemeDoc)).toEqual([
      "required_field_absent:in",
    ]);
  });

  it("reports an apiKey doc missing `name`", () => {
    const { name: _dropped, ...rest } = apiKey;
    expect(securitySchemeObjectDefects(rest as SecuritySchemeDoc)).toEqual([
      "required_field_absent:name",
    ]);
  });

  it("reports an http doc missing `scheme`", () => {
    const { scheme: _dropped, ...rest } = bearer;
    expect(securitySchemeObjectDefects(rest as SecuritySchemeDoc)).toEqual([
      "required_field_absent:scheme",
    ]);
  });

  it("reports an apiKey doc carrying a field only `http` permits", () => {
    expect(securitySchemeObjectDefects({ ...apiKey, scheme: "bearer" })).toEqual([
      "field_not_permitted_for_apiKey:scheme",
    ]);
  });

  it("reports an http doc carrying a field only `apiKey` permits", () => {
    expect(
      securitySchemeObjectDefects({ ...bearer, in: "header", name: API_KEY_HEADER }),
    ).toEqual(["field_not_permitted_for_http:in", "field_not_permitted_for_http:name"]);
  });

  it("reports an empty description", () => {
    expect(securitySchemeObjectDefects({ ...bearer, description: "   " })).toEqual([
      "description_absent_or_empty",
    ]);
  });
});

describe("the `key` field", () => {
  it("is unique across the map", () => {
    const keys = nonNullDocs().map(([, d]) => d.key);
    expect(keys.length).toBe(2);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(["apiKeyAuth", "bearerAuth"]);
  });

  it("is a legal components.securitySchemes key", () => {
    for (const [, doc] of nonNullDocs()) {
      // OpenAPI constrains a Components key to `^[a-zA-Z0-9\.\-_]+$`, and a `security` requirement
      // names it verbatim, so a key outside that is a document no tool will resolve.
      expect(doc.key).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(doc.key.length).toBeGreaterThan(0);
    }
  });

  it("is the only field that is not part of the emitted object", () => {
    // Forwards: nothing but `key` is outside OpenAPI's vocabulary, so an emitter can copy every
    // other field rather than translating it.
    for (const [scheme, doc] of nonNullDocs()) {
      const extra = Object.keys(doc).filter(
        (k) => k !== "key" && !(OPENAPI_SECURITY_SCHEME_FIELDS as readonly string[]).includes(k),
      );
      expect(extra, `${scheme} carries non-OpenAPI fields`).toEqual([]);
    }
    // Backwards: and `key` really is outside it, which is what makes the claim non-trivial — were
    // `key` an OpenAPI field name, the forwards assertion would hold while the sentence was false.
    expect(OPENAPI_SECURITY_SCHEME_FIELDS).not.toContain("key" as never);
  });

  it("every doc carries it", () => {
    for (const [, doc] of nonNullDocs()) {
      expect(typeof doc.key).toBe("string");
    }
  });
});

describe("API_KEY_HEADER has one spelling", () => {
  const LITERAL = "x-api-key";

  it("is the header the api_key_header doc names", () => {
    expect(API_KEY_HEADER).toBe(LITERAL);
    expect(AUTH_SCHEME_SECURITY_DOC.api_key_header?.name).toBe(API_KEY_HEADER);
  });

  /**
   * The request path reads the constant, which is the increment's claim and is checkable only
   * against the *code*: `auth.ts` mentions the header three times in **prose**, so a bare
   * `not.toContain` over the raw file fails and would send the next reader to "fix" a comment.
   *
   * Read as text rather than imported, because the question is which spelling the **downstream**
   * package uses and `api-gateway` must not depend on `api-gateway-runtime` to ask it — the
   * dependency runs the other way. Nothing in the type system can ask it either: a literal and a
   * constant of the same value are the same type.
   */
  it("api-gateway-runtime's auth.ts carries no literal spelling in its code", () => {
    const raw = readSource(RUNTIME_AUTH);
    const code = stripComments(raw);
    expect(code).not.toContain(LITERAL);
    // Non-vacuity in both directions. The strip preserved real code...
    expect(code).toContain("API_KEY_HEADER");
    expect(code).toContain("export function parseAuthHeader");
    expect(code).toContain("request.headers[API_KEY_HEADER]");
    // ...and it is doing real work rather than the file simply never mentioning the header: the raw
    // source carries it three times, all in comments, which is why this test strips.
    expect(countOccurrences(raw, LITERAL)).toBe(3);
    expect(countOccurrences(code, LITERAL)).toBe(0);
  });

  /**
   * The second request-path reader, and the one the first draft of this fence did not cover.
   *
   * `tenant-gateway-cache.ts`'s `requestToken()` hardcoded the literal, and that site decides
   * **which tenant's gateway serves the request** — so the increment's claim that "the request path
   * reads the constant" was true of `api-gateway-runtime` and false of `operate-server`. Found by
   * a workspace-wide count rather than by this file, which is why the file now carries the site:
   * **a fence that found a defect and does not cover it will not find the next one.**
   *
   * Reading an app's source from a package test is sound here precisely because it is *text*: it
   * creates no dependency edge, and the edge it would need runs the wrong way (`api-gateway` must
   * not depend on `operate-server`).
   */
  it("operate-server's tenant-gateway-cache.ts carries no literal spelling in its code", () => {
    const raw = readSource(TENANT_GATEWAY_CACHE);
    const code = stripComments(raw);
    expect(code).not.toContain(LITERAL);
    // Non-vacuity: the strip preserved the read this is about, and the import that feeds it.
    expect(code).toContain("headerValue(raw.headers, API_KEY_HEADER)");
    expect(code).toContain('import { API_KEY_HEADER } from "@crossengin/api-gateway"');
  });

  it("the two prose fields in AUTH_SCHEME_SUPPORT interpolate it rather than spelling it", () => {
    // They say it...
    expect(AUTH_SCHEME_SUPPORT.api_key_header.recognisedFrom).toContain(API_KEY_HEADER);
    expect(AUTH_SCHEME_SUPPORT.api_key_query.reason).toContain(API_KEY_HEADER);
    // ...and both are template literals naming the constant, which is the half a value comparison
    // cannot see: a hand-spelled `"an x-api-key header"` satisfies the two assertions above.
    const code = stripComments(readSource(RESOLUTION));
    expect(code).toContain("`an ${API_KEY_HEADER} header`");
    expect(code).toContain("present the key in ${API_KEY_HEADER} instead");
    // So the only line of this file whose code spells the header is the declaration.
    const spelling = code
      .split("\n")
      .filter((l) => l.includes(LITERAL))
      .map((l) => l.trim());
    expect(spelling).toEqual([`export const API_KEY_HEADER = "${LITERAL}";`]);
  });

  /**
   * The census, over both packages' non-test sources: the literal occurs in **code** exactly once,
   * and that once is the declaration. Measured on the committed tree — 1 in
   * `api-gateway/src/auth-resolution.ts` and 0 in `api-gateway-runtime/src/{auth,runtime}.ts`,
   * whose 3 + 1 raw occurrences are all prose — so a second spelling anywhere in either package
   * fails here rather than being found by a reader.
   *
   * Non-test, because a fixture *must* spell the header: a test asserting the parser reads it would
   * be testing itself if it built the request with the constant. The filter's own floor is asserted
   * below, so "no test files were found" cannot be how this passes.
   */
  it("occurs once in the code of both packages' non-test sources", () => {
    const roots = [
      join(PACKAGES_DIR, "api-gateway", "src"),
      join(PACKAGES_DIR, "api-gateway-runtime", "src"),
    ];
    const files = roots.flatMap((r) => walkTs(r));
    expect(files.length).toBeGreaterThanOrEqual(20);

    const tests = files.filter((f) => f.endsWith(".test.ts"));
    const sources = files.filter((f) => !f.endsWith(".test.ts"));
    // The filter does something: this very file is excluded, and it spells the header.
    expect(tests.map((f) => relative(PACKAGES_DIR, f))).toContain(
      join("api-gateway", "src", "auth-security-doc.test.ts"),
    );
    expect(tests.length).toBeGreaterThanOrEqual(10);
    expect(sources.length).toBeGreaterThanOrEqual(10);

    const inCode = sources
      .map((f) => [f, countOccurrences(stripComments(readFileSync(f, "utf8")), LITERAL)] as const)
      .filter(([, n]) => n > 0)
      .map(([f, n]) => [relative(PACKAGES_DIR, f), n] as const);
    expect(inCode).toEqual([[join("api-gateway", "src", "auth-resolution.ts"), 1]]);
  });
});

describe("the served set and the doc set agree", () => {
  it("SERVED_AUTH_SCHEMES is exactly the schemes with a non-null doc", () => {
    const documented = AUTH_SCHEMES.filter((s) => AUTH_SCHEME_SECURITY_DOC[s] !== null);
    expect([...SERVED_AUTH_SCHEMES].sort()).toEqual([...documented].sort());
    // Literal pin, the idiom `auth-resolution.test.ts` uses for `AUTH_OUTCOMES`' length: widening
    // what this binary serves is then a visible change here, beside the doc it owes.
    expect([...SERVED_AUTH_SCHEMES].sort()).toEqual(["api_key_header", "bearer_jwt"]);
  });

  it("and every served scheme's doc names a recognising position", () => {
    for (const scheme of SERVED_AUTH_SCHEMES) {
      // `recognisedFrom` is `null` iff the treatment is `indistinguishable`, so a served scheme
      // always has one — and a doc describes that same position in OpenAPI's vocabulary, which is
      // the reason the two constants sit beside each other.
      expect(AUTH_SCHEME_SUPPORT[scheme].recognisedFrom).not.toBeNull();
      expect(AUTH_SCHEME_SECURITY_DOC[scheme]).not.toBeNull();
    }
  });
});
