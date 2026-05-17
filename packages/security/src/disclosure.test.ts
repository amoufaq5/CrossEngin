import { describe, expect, it } from "vitest";
import { DisclosurePolicySchema, emitSecurityMd } from "./disclosure.js";

describe("DisclosurePolicySchema", () => {
  it("applies defaults", () => {
    const p = DisclosurePolicySchema.parse({
      contact: { email: "security@example.com" },
    });
    expect(p.defaultDisclosureTimelineDays).toBe(90);
    expect(p.bugBountyProgram.kind).toBe("none");
    expect(p.contact.preferredLanguages).toEqual(["en"]);
  });

  it("rejects an invalid email", () => {
    expect(() =>
      DisclosurePolicySchema.parse({ contact: { email: "not-an-email" } }),
    ).toThrow();
  });

  it("accepts a PGP key + url + safe harbor", () => {
    const p = DisclosurePolicySchema.parse({
      contact: {
        email: "security@example.com",
        pgpKeyId: "ABCD1234",
        pgpKeyUrl: "https://example.com/pgp.asc",
      },
      safeHarborStatement: "Good-faith research is protected.",
    });
    expect(p.contact.pgpKeyId).toBe("ABCD1234");
  });
});

describe("emitSecurityMd", () => {
  it("includes the email and disclosure window", () => {
    const p = DisclosurePolicySchema.parse({
      contact: { email: "security@example.com" },
    });
    const md = emitSecurityMd(p);
    expect(md).toContain("security@example.com");
    expect(md).toContain("90 days");
  });

  it("renders the supported-versions table when present", () => {
    const p = DisclosurePolicySchema.parse({
      contact: { email: "x@y.com" },
      supportedVersions: [
        { version: "2.1", supported: true },
        { version: "1.x", supported: false },
      ],
    });
    const md = emitSecurityMd(p);
    expect(md).toContain("| 2.1 | Yes |");
    expect(md).toContain("| 1.x | No |");
  });

  it("renders the safe-harbor section when set", () => {
    const p = DisclosurePolicySchema.parse({
      contact: { email: "x@y.com" },
      safeHarborStatement: "We will not pursue research conducted in good faith.",
    });
    const md = emitSecurityMd(p);
    expect(md).toContain("## Safe Harbor");
    expect(md).toContain("good faith");
  });

  it("reflects the bug bounty program kind", () => {
    const none = emitSecurityMd(
      DisclosurePolicySchema.parse({ contact: { email: "x@y.com" } }),
    );
    expect(none).toContain("No public bug bounty");

    const priv = emitSecurityMd(
      DisclosurePolicySchema.parse({
        contact: { email: "x@y.com" },
        bugBountyProgram: { kind: "private_engagement" },
      }),
    );
    expect(priv).toContain("Private engagement");

    const pub = emitSecurityMd(
      DisclosurePolicySchema.parse({
        contact: { email: "x@y.com" },
        bugBountyProgram: { kind: "public", url: "https://example.com/bounty" },
      }),
    );
    expect(pub).toContain("https://example.com/bounty");
  });
});
