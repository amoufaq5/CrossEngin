import { describe, expect, it } from "vitest";
import {
  AUTHN_CONTEXT_CLASSES,
  NAME_ID_FORMATS,
  SAML_BINDINGS,
  SamlAssertionSchema,
  SamlAuthnRequestSchema,
  SIGNATURE_ALGORITHMS,
  isAllowedNameIdFormat,
  isAssertionTimeValid,
  isAudienceAccepted,
  isWeakDigestAlgorithm,
  isWeakSignatureAlgorithm,
  requiresStrongAuthnContext,
  type SamlAssertion,
} from "./saml.js";

const baseAssertion: SamlAssertion = {
  id: "_assertion-1234abcd",
  issueInstant: "2026-05-15T10:00:00.000Z",
  issuer: "https://okta.acme.com",
  subject: {
    nameId: "alice@acme.com",
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    subjectConfirmationMethod: "urn:oasis:names:tc:SAML:2.0:cm:bearer",
    recipient: "https://crossengin.io/sso/acme/acs",
    notOnOrAfter: "2026-05-15T10:05:00.000Z",
  },
  conditions: {
    notBefore: "2026-05-15T10:00:00.000Z",
    notOnOrAfter: "2026-05-15T10:10:00.000Z",
    audiences: ["https://crossengin.io/sp/acme"],
  },
  authnStatement: {
    authnInstant: "2026-05-15T09:59:30.000Z",
    sessionIndex: "_session-abc123",
    authnContextClassRef:
      "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
  },
  attributes: {
    email: ["alice@acme.com"],
    groups: ["Engineering", "Admins"],
  },
  signatureAlgorithm:
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
};

describe("constants", () => {
  it("has 6 NameID formats", () => {
    expect(NAME_ID_FORMATS).toHaveLength(6);
  });
  it("has 3 SAML bindings", () => {
    expect(SAML_BINDINGS).toHaveLength(3);
  });
  it("has signature algorithms including rsa-sha256 and rsa-sha512", () => {
    expect(SIGNATURE_ALGORITHMS).toContain(
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    );
    expect(SIGNATURE_ALGORITHMS).toContain(
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
    );
  });
  it("has 8 AuthnContext classes", () => {
    expect(AUTHN_CONTEXT_CLASSES).toHaveLength(8);
  });
});

describe("isWeakSignatureAlgorithm", () => {
  it("classifies rsa-sha1 as weak", () => {
    expect(
      isWeakSignatureAlgorithm("http://www.w3.org/2000/09/xmldsig#rsa-sha1"),
    ).toBe(true);
  });
  it("classifies rsa-sha256 as strong", () => {
    expect(
      isWeakSignatureAlgorithm(
        "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      ),
    ).toBe(false);
  });
});

describe("isWeakDigestAlgorithm", () => {
  it("classifies sha1 as weak", () => {
    expect(isWeakDigestAlgorithm("http://www.w3.org/2000/09/xmldsig#sha1")).toBe(
      true,
    );
  });
});

describe("SamlAssertionSchema", () => {
  it("accepts a valid assertion", () => {
    expect(() => SamlAssertionSchema.parse(baseAssertion)).not.toThrow();
  });

  it("rejects when notOnOrAfter is not after notBefore", () => {
    expect(() =>
      SamlAssertionSchema.parse({
        ...baseAssertion,
        conditions: {
          ...baseAssertion.conditions,
          notOnOrAfter: baseAssertion.conditions.notBefore,
        },
      }),
    ).toThrow(/notOnOrAfter must be after notBefore/);
  });

  it("rejects missing audiences", () => {
    expect(() =>
      SamlAssertionSchema.parse({
        ...baseAssertion,
        conditions: { ...baseAssertion.conditions, audiences: [] },
      }),
    ).toThrow();
  });
});

describe("SamlAuthnRequestSchema", () => {
  it("accepts a typical SP-initiated request", () => {
    expect(() =>
      SamlAuthnRequestSchema.parse({
        id: "_request-abc123",
        issueInstant: "2026-05-15T10:00:00.000Z",
        issuer: "https://crossengin.io/sp/acme",
        destination: "https://okta.acme.com/saml/sso",
        protocolBinding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
        assertionConsumerServiceUrl: "https://crossengin.io/sso/acme/acs",
        nameIdPolicy: {
          format: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
          allowCreate: true,
        },
        relayState: "/dashboard",
      }),
    ).not.toThrow();
  });
});

describe("isAssertionTimeValid", () => {
  it("accepts now within the validity window", () => {
    expect(
      isAssertionTimeValid(baseAssertion, new Date("2026-05-15T10:05:00Z")),
    ).toBe(true);
  });
  it("rejects now before notBefore (outside skew)", () => {
    expect(
      isAssertionTimeValid(
        baseAssertion,
        new Date("2026-05-15T09:55:00Z"),
        30,
      ),
    ).toBe(false);
  });
  it("rejects now after notOnOrAfter", () => {
    expect(
      isAssertionTimeValid(baseAssertion, new Date("2026-05-15T10:20:00Z")),
    ).toBe(false);
  });
});

describe("isAudienceAccepted", () => {
  it("returns true when expected audience matches", () => {
    expect(
      isAudienceAccepted(baseAssertion, "https://crossengin.io/sp/acme"),
    ).toBe(true);
  });
  it("returns false on mismatch", () => {
    expect(isAudienceAccepted(baseAssertion, "https://attacker.com")).toBe(
      false,
    );
  });
});

describe("isAllowedNameIdFormat", () => {
  it("returns true when format is allowed", () => {
    expect(
      isAllowedNameIdFormat(
        "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        ["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"],
      ),
    ).toBe(true);
  });
  it("returns false when not in allow-list", () => {
    expect(
      isAllowedNameIdFormat(
        "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        ["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"],
      ),
    ).toBe(false);
  });
});

describe("requiresStrongAuthnContext", () => {
  it("classifies MultiFactor as strong", () => {
    expect(
      requiresStrongAuthnContext(
        "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor",
      ),
    ).toBe(true);
  });
  it("classifies Password as not strong", () => {
    expect(
      requiresStrongAuthnContext(
        "urn:oasis:names:tc:SAML:2.0:ac:classes:Password",
      ),
    ).toBe(false);
  });
});
