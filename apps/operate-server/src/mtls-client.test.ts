import type { IncomingRequest } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import { parseMtlsClientSpec } from "./principals.js";
import {
  MTLS_CLIENT_ABSENCES,
  formatEdgeTrustSurvey,
  resolveMtlsClients,
} from "./mtls-client.js";

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const F1 = "a".repeat(64);
const F2 = "b".repeat(64);

const REQUEST = {} as IncomingRequest;

describe("parseMtlsClientSpec", () => {
  it("accepts a four-field spec and lower-cases the fingerprint", () => {
    expect(parseMtlsClientSpec(`${F1}:erp_admin:tenant-a:${P1}`)).toEqual({
      fingerprint: F1,
      role: "erp_admin",
      tenantId: "tenant-a",
      principalId: P1,
    });
    // An operator pasting `openssl`'s uppercase output names the same certificate, and the request
    // path folds before matching, so refusing it would refuse a correct enrolment over a
    // presentation detail.
    expect(parseMtlsClientSpec(`${"A".repeat(64)}:erp_admin:tenant-a:${P1}`).fingerprint).toBe(F1);
  });

  it("refuses a first field that is not a certificate sha256", () => {
    // The one check this parser adds over its two siblings, and it is not cosmetic: a value that is
    // not 64 hex characters can never match a fingerprint `buildIncomingRequest` produces, because
    // that function shape-checks before the value reaches a request. Accepting it would leave an
    // operator with a registry row that cannot fire and nothing saying why.
    for (const bad of ["notahex", "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}g`, ""]) {
      expect(() => parseMtlsClientSpec(`${bad}:erp_admin:tenant-a:${P1}`)).toThrow();
    }
    expect(() => parseMtlsClientSpec(`notahex:erp_admin:tenant-a:${P1}`)).toThrow(
      /64 hex characters/,
    );
    expect(() => parseMtlsClientSpec(`notahex:erp_admin:tenant-a:${P1}`)).toThrow(/--mtls-client/);
  });

  /**
   * The same refusal at the **enrolment** end, which is what makes it a refusal by *value*.
   *
   * It falls out of sharing `parseForwardedClientCertFingerprint` rather than being a second check:
   * an operator who sees `sha256("")` in a log from an edge in `client_auth mode request` cannot
   * enrol it, so the request path's refusal cannot be worked around by configuration.
   */
  it("refuses sha256(\"\") as an enrolment, so the value cannot be configured in", () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(() => parseMtlsClientSpec(`${empty}:erp_admin:tenant-a:${P1}`)).toThrow(
      /64 hex characters/,
    );
    // Non-vacuity: the identical spec with a different fingerprint parses, so the refusal is about
    // this value and not about the spec's shape.
    expect(() => parseMtlsClientSpec(`${F1}:erp_admin:tenant-a:${P1}`)).not.toThrow();
  });

  it("requires the principal id, for parseHmacKeySpec's measured reason", () => {
    // `ResolvedPrincipalSchema.principalId` is a uuid, so neither the fingerprint nor anything
    // derived from it is a legal value — and a derived id naming no `meta.users` row breaks every
    // per-person surface through a foreign key (ADR-0331, ADR-0335).
    expect(() => parseMtlsClientSpec(`${F1}:erp_admin:tenant-a`)).toThrow(
      /principalId is required/,
    );
  });

  it("names its own flag in every refusal", () => {
    // ADR-0334's remedy-that-cannot-work, in a parse error: `parseCredentialSpecFields` is shared
    // with `--api-key` and `--hmac-key`, so a message naming the wrong one would send an operator
    // to a flag they did not type. All four refusal paths are covered: arity, empty field,
    // fingerprint shape, absent principal.
    for (const bad of [
      `${F1}:erp_admin`,
      `${F1}:erp_admin:tenant-a:${P1}:extra`,
      `${F1}::tenant-a:${P1}`,
      `notahex:erp_admin:tenant-a:${P1}`,
      `${F1}:erp_admin:tenant-a`,
    ]) {
      expect(() => parseMtlsClientSpec(bad), bad).toThrow(/--mtls-client/);
    }
  });
});

describe("resolveMtlsClients", () => {
  const spec1 = parseMtlsClientSpec(`${F1}:erp_admin:tenant-a:${P1}`);
  const spec2 = parseMtlsClientSpec(`${F2}:hr_manager:tenant-b:${P2}`);

  it("is absent with no specs, and says which flag is missing", () => {
    const r = resolveMtlsClients([], true);
    expect(r.kind).toBe("absent");
    if (r.kind !== "absent") throw new Error("unreachable");
    expect(r.absence).toBe("no_clients");
    expect(r.detail).toContain("--mtls-client");
  });

  it("is absent with an untrusted edge, however many certificates are enrolled", () => {
    // Reachable only from a direct caller — the CLI refuses this combination at parse — and kept
    // rather than asserted away because that caller exists (a programmatic server build), and a
    // function that served mtls for an untrusted edge would be the one defect this closes,
    // reintroduced through the library door.
    const r = resolveMtlsClients([spec1, spec2], false);
    expect(r.kind).toBe("absent");
    if (r.kind !== "absent") throw new Error("unreachable");
    expect(r.absence).toBe("edge_untrusted");
    expect(r.detail).toContain("--trusted-edge-client-cert");
  });

  it("resolves an enrolled fingerprint to its principal, role and tenant", async () => {
    const r = resolveMtlsClients([spec1, spec2], true);
    expect(r.kind).toBe("configured");
    if (r.kind !== "configured") throw new Error("unreachable");
    expect([...r.fingerprints].sort()).toEqual([F1, F2].sort());
    await expect(r.lookup.lookup(REQUEST, F1)).resolves.toEqual({
      principalRef: P1,
      scopes: ["erp_admin"],
      tenantId: "tenant-a",
    });
    await expect(r.lookup.lookup(REQUEST, F2)).resolves.toEqual({
      principalRef: P2,
      scopes: ["hr_manager"],
      tenantId: "tenant-b",
    });
  });

  it("answers null for a fingerprint nobody enrolled", async () => {
    const r = resolveMtlsClients([spec1], true);
    if (r.kind !== "configured") throw new Error("unreachable");
    await expect(r.lookup.lookup(REQUEST, F2)).resolves.toBeNull();
    // Case matters at this boundary and must not: the request path folds before calling, so the
    // registry is keyed on the folded form and an unfolded probe is simply a miss. Asserted so the
    // normalisation stays where it is — in one place, before the lookup — rather than being
    // duplicated here.
    await expect(r.lookup.lookup(REQUEST, F1.toUpperCase())).resolves.toBeNull();
  });

  it("refuses a duplicate fingerprint rather than letting argv order decide", () => {
    // Two enrolments for one certificate are two principals for one credential, so last-wins would
    // make the authenticated identity a property of flag order — which is how a certificate retired
    // from one tenant comes back as another's.
    const other = parseMtlsClientSpec(`${F1}:hr_manager:tenant-b:${P2}`);
    expect(() => resolveMtlsClients([spec1, other], true)).toThrow(/duplicate --mtls-client/);
    expect(() => resolveMtlsClients([spec1, other], true)).toThrow(new RegExp(F1));
  });

  it("every declared absence has a producer", () => {
    // The converse of a totality check: an absence nothing can answer reads as coverage it does not
    // provide (ADR-0375's "a judgement with no case left is not a judgement").
    const produced = new Set<string>();
    for (const [specs, trusted] of [
      [[], true],
      [[spec1], false],
    ] as const) {
      const r = resolveMtlsClients(specs, trusted);
      if (r.kind === "absent") produced.add(r.absence);
    }
    expect([...produced].sort()).toEqual([...MTLS_CLIENT_ABSENCES].sort());
  });
});

describe("formatEdgeTrustSurvey", () => {
  const spec1 = parseMtlsClientSpec(`${F1}:erp_admin:tenant-a:${P1}`);

  it("says the trust state either way, including when nothing is declared", () => {
    // ADR-0376's rule: what wants confirming here is a *refusal*, which is harder to confirm by
    // trying it than a capability is. Before this increment the forwarded facts were derived
    // unconditionally and no line said so.
    const off = formatEdgeTrustSurvey(false, resolveMtlsClients([], false));
    expect(off).toContain("edge trust: untrusted");
    expect(off).toContain("dropped");
    expect(off).toContain("mtls: not served");

    const on = formatEdgeTrustSurvey(true, resolveMtlsClients([spec1], true));
    expect(on).toContain("edge trust: trusted");
    expect(on).toContain("mtls: serving 1 enrolled certificate(s)");
  });

  it("names the broader fact and not only the scheme", () => {
    // The declaration governs every forwarded fact, so a line naming only mtls would leave
    // *this deployment believes its forwarded headers* reported nowhere — which is what it was.
    for (const trusted of [true, false]) {
      const line = formatEdgeTrustSurvey(trusted, resolveMtlsClients([], trusted));
      expect(line).toContain("x-forwarded-*");
      expect(line).toContain("TLS version");
    }
  });

  it("counts the enrolled certificates and prints none of them", () => {
    // Not a disclosure rule — a fingerprint is public — but a readability one: 64 hex characters per
    // certificate makes a boot line unreadable, and the one an operator needs is on the stage
    // result when a certificate fails to resolve.
    const line = formatEdgeTrustSurvey(true, resolveMtlsClients([spec1], true));
    expect(line).not.toContain(F1);
    expect(line).toContain("1 enrolled");
  });

  it("is a non-empty sentence in every configuration", () => {
    for (const [trusted, specs] of [
      [false, []],
      [true, []],
      [true, [spec1]],
      [false, [spec1]],
    ] as const) {
      const line = formatEdgeTrustSurvey(trusted, resolveMtlsClients(specs, trusted));
      expect(line.length).toBeGreaterThan(60);
      expect(line.startsWith("edge trust:")).toBe(true);
    }
  });
});
