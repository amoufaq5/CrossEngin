/**
 * Where an enrolled client certificate comes from, and why this credential has no secret to protect.
 *
 * `request-signing.ts`' shape with its hardest problem removed. That module exists largely to
 * explain how a per-key secret is derived and stored nowhere; here there is **no secret at any
 * point**. A client proves possession of its private key to the *edge*, in the TLS handshake, and
 * what reaches this process is the sha256 of the certificate — a value derived from material the
 * client presents to everyone it connects to. So `--mtls-client` carries nothing an operator could
 * leak, there is no environment variable, no derivation, and no `secret_absent` absence to report.
 * ADR-0301 is satisfied by the flag being secretless rather than by moving something off it.
 *
 * What replaces the secret is a **trust declaration**, and that is the whole security story of the
 * scheme: `--trusted-edge-client-cert` says that this deployment's edge performs mutual TLS and
 * **overwrites** `CrossEngin-Client-Cert-Sha256`, so the fingerprint on a request is the edge's
 * assertion and not a caller's claim. Without it `buildIncomingRequest` drops the header and no
 * request can carry an mtls credential at all. The registry below only answers *which principal an
 * enrolled certificate is*; it answers nothing about whether the certificate was really presented.
 *
 * The cost is stated rather than discovered, and it is `request-signing.ts`' cost one credential
 * over: **a certificate cannot be revoked without a restart**, because the enrolment set is the flag
 * set. Revoking one means removing its `--mtls-client` and restarting. A per-certificate revocation
 * surface needs a store, which is the open end rather than this module's omission — and unlike the
 * hmac case there is no second lever (no shared secret to rotate), so the restart is the only
 * mechanism there is.
 */
import type { IncomingRequest } from "@crossengin/api-gateway";
import type { MtlsClientLookup, MtlsClientLookupResult } from "@crossengin/api-gateway-runtime";

import type { MtlsClientSpec } from "./principals.js";

/**
 * Why this deployment is not serving mtls, when it is not.
 *
 * **Two states where `request-signing.ts` has three**, and the missing one is the measurement worth
 * recording: that module's `secret_absent` and `secret_refused` both describe a secret, and this
 * credential has none, so the only absences left are *no enrolment declared* and *no trusted edge*.
 * Keeping them apart follows that module's own rule — two absences stay apart when their remedies
 * differ — and here they differ in which flag an operator adds.
 *
 * `edge_untrusted` is reachable only from a direct caller of `resolveMtlsClients`, because the CLI
 * refuses `--mtls-client` without `--trusted-edge-client-cert` at parse. It is kept rather than
 * asserted away for the reason ADR-0375 deleted a judgement that had no case left: this one does
 * have a case (a programmatic caller building a server without the CLI), and a function that
 * silently served mtls for an untrusted edge would be the one defect this increment exists to
 * prevent, reintroduced through the library door.
 */
export const MTLS_CLIENT_ABSENCES = ["no_clients", "edge_untrusted"] as const;
export type MtlsClientAbsence = (typeof MTLS_CLIENT_ABSENCES)[number];

export type MtlsClientResolution =
  | {
      readonly kind: "configured";
      readonly lookup: MtlsClientLookup;
      readonly fingerprints: readonly string[];
    }
  | { readonly kind: "absent"; readonly absence: MtlsClientAbsence; readonly detail: string };

/**
 * Builds the registry lookup, or says why it could not.
 *
 * Returns an absence rather than throwing, on `resolveRequestSigning`'s stated split: a deployment
 * that declared no `--mtls-client` has not asked for this scheme, so refusing its boot would refuse
 * a deployment that works (ADR-0338's premise read the other way). `node.ts` decides what to do with
 * an absence, because only it knows whether anything else is wrong too.
 *
 * A **duplicate fingerprint is refused** rather than last-wins, which is `--rate-limit-policy`'s
 * rule and matters more here: two enrolments for one certificate are two different principals for
 * one credential, so argv order would decide who a request authenticates as. That is a question an
 * operator cannot have meant to leave open, and silently answering it is how a certificate retired
 * from one tenant comes back as another's.
 */
export function resolveMtlsClients(
  specs: readonly MtlsClientSpec[],
  edgeTrusted: boolean,
): MtlsClientResolution {
  if (specs.length === 0) {
    return {
      kind: "absent",
      absence: "no_clients",
      detail: "no --mtls-client was declared, so no certificate fingerprint can be resolved",
    };
  }
  if (!edgeTrusted) {
    return {
      kind: "absent",
      absence: "edge_untrusted",
      detail:
        "--trusted-edge-client-cert was not declared, so a forwarded client-certificate " +
        "fingerprint is dropped before it reaches a request and no enrolment could ever match",
    };
  }
  const byFingerprint = new Map<string, MtlsClientLookupResult>();
  for (const spec of specs) {
    if (byFingerprint.has(spec.fingerprint)) {
      throw new Error(
        `duplicate --mtls-client fingerprint ${spec.fingerprint}: two enrolments for one certificate would make argv order decide which principal it authenticates as`,
      );
    }
    byFingerprint.set(spec.fingerprint, {
      principalRef: spec.principalId,
      scopes: [spec.role],
      tenantId: spec.tenantId,
    });
  }
  const lookup: MtlsClientLookup = {
    // The request is in the signature and deliberately unread, matching
    // `resolveRequestSigning`'s lookup: the seam offers per-host or per-path scoping and this
    // deployment's registry is flat, so reading it would be inventing a policy the flag cannot
    // express. `async` with no `await` because the seam is a promise for a store-backed registry;
    // this one is a Map.
    lookup: async (_request: IncomingRequest, fingerprint: string) =>
      byFingerprint.get(fingerprint) ?? null,
  };
  return {
    kind: "configured",
    lookup,
    fingerprints: [...byFingerprint.keys()],
  };
}

/**
 * The boot line, said whether or not anything is declared.
 *
 * It names the **trust declaration first and the registry second**, because that is the order the
 * facts depend on and the order an operator meets them: without the declaration the registry cannot
 * fire, and the declaration is useful on its own (it governs `x-forwarded-for`, `x-forwarded-proto`,
 * `x-forwarded-host` and the TLS version, not only the certificate). A line naming only the scheme
 * would leave the broader fact — *this deployment believes/does not believe its forwarded
 * headers* — reported nowhere, which is what it was before.
 *
 * The **fingerprints are not printed**, only counted. They are not secrets, so this is not a
 * disclosure rule: a 64-character hex string per enrolled certificate makes a boot line unreadable,
 * and the one on the record when a certificate fails to resolve is the one an operator needs
 * (`mtls_certificate_not_enrolled_<fingerprint>`, on the stage result). The count is what confirms
 * the flags were parsed.
 */
export function formatEdgeTrustSurvey(
  edgeTrusted: boolean,
  clients: MtlsClientResolution,
): string {
  const trust = edgeTrusted
    ? "edge trust: trusted — this deployment believes the forwarded client certificate, TLS version" +
      " and x-forwarded-* headers, which is sound only while its edge overwrites them"
    : "edge trust: untrusted — forwarded client certificate, TLS version and x-forwarded-* headers" +
      " are dropped, because a caller can set any of them";
  const registry =
    clients.kind === "configured"
      ? `mtls: serving ${clients.fingerprints.length} enrolled certificate(s)`
      : `mtls: not served (${clients.detail})`;
  return `${trust}; ${registry}`;
}
