import { z } from "zod";

export const NAME_ID_FORMATS = [
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:entity",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:kerberos",
] as const;
export type NameIdFormat = (typeof NAME_ID_FORMATS)[number];

export const SAML_BINDINGS = [
  "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
  "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
  "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Artifact",
] as const;
export type SamlBinding = (typeof SAML_BINDINGS)[number];

export const SIGNATURE_ALGORITHMS = [
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
] as const;
export type SignatureAlgorithm = (typeof SIGNATURE_ALGORITHMS)[number];

export const DIGEST_ALGORITHMS = [
  "http://www.w3.org/2000/09/xmldsig#sha1",
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512",
] as const;
export type DigestAlgorithm = (typeof DIGEST_ALGORITHMS)[number];

export const WEAK_SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set([
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
]);

export const WEAK_DIGEST_ALGORITHMS: ReadonlySet<string> = new Set([
  "http://www.w3.org/2000/09/xmldsig#sha1",
]);

export const AUTHN_CONTEXT_CLASSES = [
  "urn:oasis:names:tc:SAML:2.0:ac:classes:Password",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:Kerberos",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:X509",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract",
] as const;
export type AuthnContextClass = (typeof AUTHN_CONTEXT_CLASSES)[number];

export const SamlSpMetadataSchema = z.object({
  entityId: z.string().min(1),
  acsBindings: z
    .array(
      z.object({
        binding: z.enum(SAML_BINDINGS),
        location: z.string().url(),
        index: z.number().int().nonnegative(),
        isDefault: z.boolean().default(false),
      }),
    )
    .min(1),
  sloBindings: z
    .array(
      z.object({
        binding: z.enum(SAML_BINDINGS),
        location: z.string().url(),
        responseLocation: z.string().url().optional(),
      }),
    )
    .default([]),
  signingCertificate: z.string().min(1),
  encryptionCertificate: z.string().min(1).optional(),
  wantAssertionsSigned: z.boolean(),
  authnRequestsSigned: z.boolean(),
});
export type SamlSpMetadata = z.infer<typeof SamlSpMetadataSchema>;

export const SamlAuthnRequestSchema = z.object({
  id: z.string().regex(/^_[a-zA-Z0-9-]{8,128}$/),
  issueInstant: z.string().datetime({ offset: true }),
  issuer: z.string().min(1),
  destination: z.string().url(),
  protocolBinding: z.enum(SAML_BINDINGS),
  assertionConsumerServiceUrl: z.string().url(),
  nameIdPolicy: z
    .object({
      format: z.enum(NAME_ID_FORMATS),
      allowCreate: z.boolean(),
    })
    .optional(),
  requestedAuthnContext: z
    .object({
      classes: z.array(z.enum(AUTHN_CONTEXT_CLASSES)).min(1),
      comparison: z.enum(["exact", "minimum", "maximum", "better"]),
    })
    .optional(),
  forceAuthn: z.boolean().default(false),
  isPassive: z.boolean().default(false),
  relayState: z.string().max(80).optional(),
});
export type SamlAuthnRequest = z.infer<typeof SamlAuthnRequestSchema>;

export const SamlAssertionSchema = z
  .object({
    id: z.string().regex(/^_[a-zA-Z0-9-]{8,128}$/),
    issueInstant: z.string().datetime({ offset: true }),
    issuer: z.string().min(1),
    subject: z.object({
      nameId: z.string().min(1),
      nameIdFormat: z.enum(NAME_ID_FORMATS),
      subjectConfirmationMethod: z.string(),
      recipient: z.string().url(),
      notOnOrAfter: z.string().datetime({ offset: true }),
      inResponseTo: z.string().optional(),
    }),
    conditions: z.object({
      notBefore: z.string().datetime({ offset: true }),
      notOnOrAfter: z.string().datetime({ offset: true }),
      audiences: z.array(z.string().min(1)).min(1),
    }),
    authnStatement: z.object({
      authnInstant: z.string().datetime({ offset: true }),
      sessionIndex: z.string().optional(),
      authnContextClassRef: z.enum(AUTHN_CONTEXT_CLASSES),
    }),
    attributes: z.record(z.string(), z.array(z.string()).min(1)),
    signatureAlgorithm: z.enum(SIGNATURE_ALGORITHMS),
    digestAlgorithm: z.enum(DIGEST_ALGORITHMS),
  })
  .superRefine((a, ctx) => {
    const notBefore = Date.parse(a.conditions.notBefore);
    const notOnOrAfter = Date.parse(a.conditions.notOnOrAfter);
    if (notBefore >= notOnOrAfter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conditions", "notOnOrAfter"],
        message: "notOnOrAfter must be after notBefore",
      });
    }
  });
export type SamlAssertion = z.infer<typeof SamlAssertionSchema>;

export const isWeakSignatureAlgorithm = (algorithm: string): boolean =>
  WEAK_SIGNATURE_ALGORITHMS.has(algorithm);

export const isWeakDigestAlgorithm = (algorithm: string): boolean =>
  WEAK_DIGEST_ALGORITHMS.has(algorithm);

export const isAssertionTimeValid = (
  assertion: SamlAssertion,
  now: Date,
  clockSkewSeconds = 60,
): boolean => {
  const t = now.getTime();
  const skew = clockSkewSeconds * 1000;
  const notBefore = Date.parse(assertion.conditions.notBefore);
  const notOnOrAfter = Date.parse(assertion.conditions.notOnOrAfter);
  return t + skew >= notBefore && t - skew < notOnOrAfter;
};

export const isAudienceAccepted = (assertion: SamlAssertion, expectedAudience: string): boolean =>
  assertion.conditions.audiences.includes(expectedAudience);

export const isAllowedNameIdFormat = (format: string, allowedFormats: readonly string[]): boolean =>
  allowedFormats.includes(format);

export const requiresStrongAuthnContext = (classRef: AuthnContextClass): boolean =>
  classRef === "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor" ||
  classRef === "urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken" ||
  classRef === "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract";
