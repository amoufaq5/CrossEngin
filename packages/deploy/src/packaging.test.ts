import { describe, expect, it } from "vitest";
import {
  HELM_CHART_DEPENDENCIES,
  HelmChartDeclarationSchema,
  LicenseTermSchema,
  PACKAGING_EDITIONS,
  TERRAFORM_PROVIDERS,
  TerraformModuleDeclarationSchema,
  daysUntilLicenseExpiry,
  isLicenseValid,
  requiresLicense,
  type LicenseTerm,
} from "./packaging.js";

const SHA256 = "a".repeat(64);

describe("constants", () => {
  it("PACKAGING_EDITIONS = saas|on_prem|byoc", () => {
    expect(PACKAGING_EDITIONS).toEqual(["saas", "on_prem", "byoc"]);
  });

  it("HELM_CHART_DEPENDENCIES has 6 entries", () => {
    expect(HELM_CHART_DEPENDENCIES).toContain("postgresql");
    expect(HELM_CHART_DEPENDENCIES).toContain("llm_proxy");
  });

  it("TERRAFORM_PROVIDERS has 4 entries", () => {
    expect(TERRAFORM_PROVIDERS).toEqual(["aws", "gcp", "azure", "kubernetes"]);
  });
});

describe("HelmChartDeclarationSchema", () => {
  const base = {
    name: "crossengin",
    version: "1.0.0",
    appVersion: "1.0.0",
    description: "CrossEngin Helm chart",
    dependencies: ["postgresql", "redis"] as const,
    valuesSchemaSha256: SHA256,
    requiresKubernetesVersion: ">=1.27.0",
    license: "crossengin-commercial" as const,
  };

  it("accepts a valid chart declaration", () => {
    expect(() => HelmChartDeclarationSchema.parse(base)).not.toThrow();
  });

  it("rejects duplicate dependencies", () => {
    expect(() =>
      HelmChartDeclarationSchema.parse({ ...base, dependencies: ["postgresql", "postgresql"] }),
    ).toThrow(/duplicate dependency/);
  });

  it("rejects a non-semver version", () => {
    expect(() => HelmChartDeclarationSchema.parse({ ...base, version: "1.0" })).toThrow();
  });

  it("rejects a license other than crossengin-commercial", () => {
    expect(() => HelmChartDeclarationSchema.parse({ ...base, license: "MIT" as never })).toThrow();
  });
});

describe("TerraformModuleDeclarationSchema", () => {
  const base = {
    name: "crossengin-aws",
    version: "1.0.0",
    edition: "on_prem" as const,
    providers: ["aws", "kubernetes"] as const,
    inputs: ["tenant_id", "region"],
    outputs: ["cluster_endpoint"],
    requiresTerraformVersion: ">=1.6.0",
    publishedAt: "2026-05-14T00:00:00Z",
    registryUrl: "https://registry.terraform.io/crossengin/aws",
  };

  it("accepts a valid module", () => {
    expect(() => TerraformModuleDeclarationSchema.parse(base)).not.toThrow();
  });

  it("rejects saas edition", () => {
    expect(() => TerraformModuleDeclarationSchema.parse({ ...base, edition: "saas" })).toThrow();
  });

  it("rejects duplicate inputs", () => {
    expect(() => TerraformModuleDeclarationSchema.parse({ ...base, inputs: ["x", "x"] })).toThrow(
      /duplicate input/,
    );
  });

  it("rejects duplicate outputs", () => {
    expect(() => TerraformModuleDeclarationSchema.parse({ ...base, outputs: ["y", "y"] })).toThrow(
      /duplicate output/,
    );
  });
});

describe("LicenseTermSchema", () => {
  const base: LicenseTerm = {
    customerId: "cust-1",
    edition: "on_prem",
    maxTenants: 10,
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-01-01T00:00:00Z",
    signedBy: "CrossEngin Inc",
    signatureSha256: SHA256,
    revocationListUrl: "https://crl.crossengin.io/v1",
  };

  it("accepts a valid license", () => {
    expect(() => LicenseTermSchema.parse(base)).not.toThrow();
  });

  it("rejects expiresAt <= issuedAt", () => {
    expect(() => LicenseTermSchema.parse({ ...base, expiresAt: "2026-01-01T00:00:00Z" })).toThrow(
      /expiresAt must be after issuedAt/,
    );
  });

  it("rejects saas edition (license applies only to on_prem/byoc)", () => {
    expect(() => LicenseTermSchema.parse({ ...base, edition: "saas" })).toThrow();
  });
});

describe("helpers", () => {
  const baseTerm: LicenseTerm = {
    customerId: "cust-1",
    edition: "on_prem",
    maxTenants: 10,
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-01-01T00:00:00Z",
    signedBy: "CrossEngin",
    signatureSha256: SHA256,
    revocationListUrl: "https://crl.crossengin.io/v1",
  };

  it("isLicenseValid is true before expiry", () => {
    expect(isLicenseValid(baseTerm, new Date("2026-06-01T00:00:00Z"))).toBe(true);
  });

  it("isLicenseValid is false after expiry", () => {
    expect(isLicenseValid(baseTerm, new Date("2027-06-01T00:00:00Z"))).toBe(false);
  });

  it("daysUntilLicenseExpiry counts down", () => {
    expect(daysUntilLicenseExpiry(baseTerm, new Date("2026-12-22T00:00:00Z"))).toBe(10);
  });

  it("requiresLicense returns true for on_prem and byoc, false for saas", () => {
    expect(requiresLicense("saas")).toBe(false);
    expect(requiresLicense("on_prem")).toBe(true);
    expect(requiresLicense("byoc")).toBe(true);
  });
});
