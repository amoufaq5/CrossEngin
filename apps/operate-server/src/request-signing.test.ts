import type { IncomingRequest } from "@crossengin/api-gateway";
import { deriveRequestSigningKey, parseRequestSigningSecret } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { parseHmacKeySpec } from "./principals.js";
import {
  REQUEST_SIGNING_ABSENCES,
  REQUEST_SIGNING_ABSENCE_REFUSES_BOOT,
  REQUEST_SIGNING_SECRET_VAR,
  formatRequestSigningSurvey,
  resolveRequestSigning,
} from "./request-signing.js";

/** 32+ bytes with well over 16 distinct values, so `refuseWeakSecret` admits it. */
const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const SECRET = "req-sign-secret-with-plenty-of-entropy-0123456789";
const ENV_WITH_SECRET = { [REQUEST_SIGNING_SECRET_VAR]: SECRET } as NodeJS.ProcessEnv;

const REQUEST = {} as IncomingRequest;

describe("parseHmacKeySpec", () => {
  it("requires the principal id, where --api-key defaults it", () => {
    // A live run refuted the first design, which used the key id as the principal reference: a
    // correctly signed request answered **500** with `{"validation":"uuid","path":["principalId"]}`
    // from `ResolvedPrincipalSchema`. Deriving a UUID instead would have been worse than the
    // placeholder it was beating — ADR-0331/0335: a principal id naming no `meta.users` row breaks
    // every per-person surface, and N derived ids need N rows nobody knows to create.
    expect(parseHmacKeySpec(`k1:erp_admin:tenant-a:${P1}`)).toEqual({
      keyId: "k1",
      role: "erp_admin",
      tenantId: "tenant-a",
      principalId: P1,
    });
    expect(() => parseHmacKeySpec("k1:erp_admin:tenant-a")).toThrow(/principalId is required/);
    expect(() => parseHmacKeySpec("k1:erp_admin:tenant-a")).toThrow(/--hmac-key/);
  });

  it("two specs name two principals, with no shared placeholder to collide on", () => {
    // What this scheme really has over an api key: not that it can *default* an identity but that
    // it can **demand** one. An api-key spec must keep its three-field form working for every
    // existing deployment; `--hmac-key` is new, so requiring the fourth costs nobody anything.
    expect(parseHmacKeySpec(`k1:r:t:${P1}`).principalId).not.toBe(
      parseHmacKeySpec(`k2:r:t:${P2}`).principalId,
    );
  });

  it("shares the grammar with --api-key and names its own flag in every refusal", () => {
    for (const bad of ["k1:r", `k1:r:t:${P1}:extra`, `:r:t:${P1}`, `k1::t:${P1}`, `k1:r::${P1}`]) {
      expect(() => parseHmacKeySpec(bad)).toThrow(/--hmac-key/);
    }
    // The point of sharing: the arity and empty-field rules are one definition, so the two flags
    // cannot come to disagree about what a spec is — while each error names the flag an operator
    // typed, which is what a shared message would get wrong.
    expect(() => parseHmacKeySpec("k1:r")).toThrow(/keyId:role:tenant/);
    expect(() => parseHmacKeySpec("k1:r")).not.toThrow(/--api-key/);
    // An empty fourth field is the *required*-principal refusal and not the empty-field one, which
    // is the split worth pinning: `k1:r:t:` and `k1:r:t` are the same omission said two ways.
    expect(() => parseHmacKeySpec("k1:r:t:")).toThrow(/principalId is required/);
  });
});

describe("resolveRequestSigning", () => {
  it("no keys declared is an absence that does not refuse the boot", () => {
    const r = resolveRequestSigning([], ENV_WITH_SECRET);
    expect(r.kind).toBe("absent");
    if (r.kind !== "absent") throw new Error("unreachable");
    expect(r.absence).toBe("no_keys");
    expect(REQUEST_SIGNING_ABSENCE_REFUSES_BOOT[r.absence]).toBe(false);
    // The detail names the flag, not the variable: an operator here set the secret already, so
    // sending them to look at it would be the remedy that cannot work.
    expect(r.detail).toContain("--hmac-key");
    expect(r.detail).not.toContain(REQUEST_SIGNING_SECRET_VAR);
  });

  it("keys declared with no secret refuses the boot and names the variable", () => {
    const r = resolveRequestSigning([parseHmacKeySpec(`k1:r:t:${P1}`)], {} as NodeJS.ProcessEnv);
    expect(r.kind).toBe("absent");
    if (r.kind !== "absent") throw new Error("unreachable");
    expect(r.absence).toBe("secret_absent");
    expect(REQUEST_SIGNING_ABSENCE_REFUSES_BOOT[r.absence]).toBe(true);
    expect(r.detail).toContain(REQUEST_SIGNING_SECRET_VAR);
  });

  it("a whitespace-only secret is absent rather than refused", () => {
    // ADR-0365's rule one variable over: an unset field serialises as empty, so blank is nothing
    // supplied. Refusing it as *weak* would name an entropy floor for a value nobody set.
    const r = resolveRequestSigning([parseHmacKeySpec(`k1:r:t:${P1}`)], {
      [REQUEST_SIGNING_SECRET_VAR]: "   ",
    } as NodeJS.ProcessEnv);
    if (r.kind !== "absent") throw new Error("unreachable");
    expect(r.absence).toBe("secret_absent");
  });

  it("a weak secret is its own absence, carrying the floor and never the value", () => {
    const weak = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const r = resolveRequestSigning([parseHmacKeySpec(`k1:r:t:${P1}`)], {
      [REQUEST_SIGNING_SECRET_VAR]: weak,
    } as NodeJS.ProcessEnv);
    if (r.kind !== "absent") throw new Error("unreachable");
    expect(r.absence).toBe("secret_refused");
    expect(REQUEST_SIGNING_ABSENCE_REFUSES_BOOT[r.absence]).toBe(true);
    expect(r.detail).toContain(REQUEST_SIGNING_SECRET_VAR);
    expect(r.detail).not.toContain(weak);
  });

  it("every absence is reachable and the map is total over them", () => {
    // The converse of the usual totality check: a modelled absence with no producer is a value the
    // boot line can never say, which is the shape this repo keeps finding.
    expect(Object.keys(REQUEST_SIGNING_ABSENCE_REFUSES_BOOT).sort()).toEqual(
      [...REQUEST_SIGNING_ABSENCES].sort(),
    );
    const produced = new Set<string>();
    for (const [specs, env] of [
      [[], ENV_WITH_SECRET],
      [[parseHmacKeySpec(`k1:r:t:${P1}`)], {}],
      [[parseHmacKeySpec(`k1:r:t:${P1}`)], { [REQUEST_SIGNING_SECRET_VAR]: "a".repeat(40) }],
    ] as const) {
      const r = resolveRequestSigning(specs, env as NodeJS.ProcessEnv);
      if (r.kind === "absent") produced.add(r.absence);
    }
    expect([...produced].sort()).toEqual([...REQUEST_SIGNING_ABSENCES].sort());
  });

  it("derives one key per id, and the derivation is the real one", async () => {
    const specs = [`k1:erp_admin:tenant-a:${P1}`, `k2:ap_clerk:tenant-b:${P1}`].map(parseHmacKeySpec);
    const r = resolveRequestSigning(specs, ENV_WITH_SECRET);
    expect(r.kind).toBe("configured");
    if (r.kind !== "configured") throw new Error("unreachable");
    expect(r.keyIds).toEqual(["k1", "k2"]);

    const secret = parseRequestSigningSecret(SECRET);
    const k1 = await r.lookup.lookup(REQUEST, "k1");
    expect(k1).not.toBeNull();
    // Asserted against `deriveRequestSigningKey` rather than a pinned hex literal: the vector is
    // pinned in `packages/crypto`, and what this file is about is that the lookup uses the real
    // derivation rather than a fixed buffer.
    expect(k1?.keyBytes).toEqual(deriveRequestSigningKey(secret, "k1"));
    // The **principal** the spec names, not the key id — which is the live 500 this increment
    // found: `ResolvedPrincipalSchema.principalId` is a uuid, so a key id is not a legal value.
    expect(k1?.principalRef).toBe(P1);
    expect(k1?.scopes).toEqual(["erp_admin"]);
    expect(k1?.tenantId).toBe("tenant-a");

    // Two ids under one secret yield two keys — the salt is the key id, so a shared secret does not
    // mean a shared key.
    const k2 = await r.lookup.lookup(REQUEST, "k2");
    expect(k2?.keyBytes).not.toEqual(k1?.keyBytes);
    expect(k2?.tenantId).toBe("tenant-b");
  });

  it("answers null for an id no spec declared", async () => {
    const r = resolveRequestSigning([parseHmacKeySpec(`k1:r:t:${P1}`)], ENV_WITH_SECRET);
    if (r.kind !== "configured") throw new Error("unreachable");
    expect(await r.lookup.lookup(REQUEST, "k2")).toBeNull();
    expect(await r.lookup.lookup(REQUEST, "")).toBeNull();
    // Not case-folded: a key id is compared exactly, as `HEADER_RE` admits it.
    expect(await r.lookup.lookup(REQUEST, "K1")).toBeNull();
  });

  it("the key ids are sorted, so a boot line does not depend on argv order", () => {
    const a = resolveRequestSigning([`z:r:t:${P1}`, `a:r:t:${P1}`].map(parseHmacKeySpec), ENV_WITH_SECRET);
    const b = resolveRequestSigning([`a:r:t:${P1}`, `z:r:t:${P1}`].map(parseHmacKeySpec), ENV_WITH_SECRET);
    if (a.kind !== "configured" || b.kind !== "configured") throw new Error("unreachable");
    expect(a.keyIds).toEqual(b.keyIds);
    expect(a.keyIds).toEqual(["a", "z"]);
  });

  it("a repeated key id is one key and the last spec wins", () => {
    // A `Map` keyed on the id, so this is last-write-wins rather than a refusal — stated here
    // because the alternative (refusing a duplicate, as `--abac-policy` does) is a real option and
    // the difference matters: there two policies for one key make the authorization answer depend on
    // argv order, and here two specs for one id differ only in which role it holds, which the boot
    // line reports as one id either way. This is the weaker choice and is pinned so it is a decision
    // rather than an accident.
    const r = resolveRequestSigning([`k1:r1:t1:${P1}`, `k1:r2:t2:${P1}`].map(parseHmacKeySpec), ENV_WITH_SECRET);
    if (r.kind !== "configured") throw new Error("unreachable");
    expect(r.keyIds).toEqual(["k1"]);
  });
});

describe("formatRequestSigningSurvey", () => {
  it("names the key ids when configured, because a key id is not a secret", () => {
    const r = resolveRequestSigning([`k1:r:t:${P1}`, `k2:r:t:${P1}`].map(parseHmacKeySpec), ENV_WITH_SECRET);
    const line = formatRequestSigningSurvey(r);
    expect(line).toContain("verifying 2 key id(s)");
    expect(line).toContain("k1, k2");
  });

  it("never names a derived key", () => {
    const r = resolveRequestSigning([parseHmacKeySpec(`k1:r:t:${P1}`)], ENV_WITH_SECRET);
    if (r.kind !== "configured") throw new Error("unreachable");
    const line = formatRequestSigningSurvey(r);
    const keyHex = Buffer.from(
      deriveRequestSigningKey(parseRequestSigningSecret(SECRET), "k1"),
    ).toString("hex");
    expect(line).not.toContain(keyHex);
    expect(line).not.toContain(SECRET);
  });

  it("says so either way, including when nothing is configured", () => {
    // ADR-0376's rule: the thing to confirm here is that a signed request will be *accepted*, which
    // is harder to confirm by trying it than a refusal is — before this scheme, trying it answered
    // 201 as the anonymous principal.
    for (const r of [
      resolveRequestSigning([], ENV_WITH_SECRET),
      resolveRequestSigning([parseHmacKeySpec(`k1:r:t:${P1}`)], {} as NodeJS.ProcessEnv),
      resolveRequestSigning([parseHmacKeySpec(`k1:r:t:${P1}`)], ENV_WITH_SECRET),
    ]) {
      expect(formatRequestSigningSurvey(r)).toMatch(/^request signatures: /);
      expect(formatRequestSigningSurvey(r).length).toBeGreaterThan(30);
    }
    expect(formatRequestSigningSurvey(resolveRequestSigning([], ENV_WITH_SECRET))).toContain(
      "not verified",
    );
  });
});
