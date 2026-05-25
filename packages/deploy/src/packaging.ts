import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const PACKAGING_EDITIONS = ["saas", "on_prem", "byoc"] as const;
export type PackagingEdition = (typeof PACKAGING_EDITIONS)[number];

export const HELM_CHART_DEPENDENCIES = [
  "postgresql",
  "inngest",
  "typesense",
  "minio",
  "llm_proxy",
  "redis",
] as const;
export type HelmDependency = (typeof HELM_CHART_DEPENDENCIES)[number];

export const HelmChartDeclarationSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(SEMVER),
    appVersion: z.string().regex(SEMVER),
    description: z.string().min(1),
    dependencies: z.array(z.enum(HELM_CHART_DEPENDENCIES)).default([]),
    valuesSchemaSha256: z.string().regex(/^[0-9a-f]{64}$/),
    requiresKubernetesVersion: z.string().regex(/^>=\d+\.\d+\.\d+$/),
    license: z.literal("crossengin-commercial"),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<HelmDependency>();
    v.dependencies.forEach((d, i) => {
      if (seen.has(d)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dependencies", i],
          message: `duplicate dependency '${d}'`,
        });
      }
      seen.add(d);
    });
  });
export type HelmChartDeclaration = z.infer<typeof HelmChartDeclarationSchema>;

export const TERRAFORM_PROVIDERS = ["aws", "gcp", "azure", "kubernetes"] as const;
export type TerraformProvider = (typeof TERRAFORM_PROVIDERS)[number];

export const TerraformModuleDeclarationSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    version: z.string().regex(SEMVER),
    edition: z.enum(PACKAGING_EDITIONS).refine((e) => e !== "saas", {
      message: "Terraform modules are for on_prem / byoc; SaaS uses managed providers",
    }),
    providers: z.array(z.enum(TERRAFORM_PROVIDERS)).min(1),
    inputs: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
    outputs: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
    requiresTerraformVersion: z.string().regex(/^>=\d+\.\d+\.\d+$/),
    publishedAt: Iso8601,
    registryUrl: z.string().url(),
  })
  .superRefine((v, ctx) => {
    const seenInputs = new Set<string>();
    v.inputs.forEach((input, i) => {
      if (seenInputs.has(input)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inputs", i],
          message: `duplicate input '${input}'`,
        });
      }
      seenInputs.add(input);
    });
    const seenOutputs = new Set<string>();
    v.outputs.forEach((output, i) => {
      if (seenOutputs.has(output)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputs", i],
          message: `duplicate output '${output}'`,
        });
      }
      seenOutputs.add(output);
    });
  });
export type TerraformModuleDeclaration = z.infer<typeof TerraformModuleDeclarationSchema>;

export const LicenseTermSchema = z
  .object({
    customerId: z.string().min(1),
    edition: z.enum(PACKAGING_EDITIONS),
    maxTenants: z.number().int().min(1),
    issuedAt: Iso8601,
    expiresAt: Iso8601,
    signedBy: z.string().min(1),
    signatureSha256: z.string().regex(/^[0-9a-f]{64}$/),
    revocationListUrl: z.string().url(),
  })
  .superRefine((v, ctx) => {
    if (new Date(v.expiresAt).getTime() <= new Date(v.issuedAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after issuedAt",
      });
    }
    if (v.edition === "saas") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edition"],
        message: "license terms apply only to on_prem and byoc editions",
      });
    }
  });
export type LicenseTerm = z.infer<typeof LicenseTermSchema>;

export function isLicenseValid(term: LicenseTerm, now: Date = new Date()): boolean {
  return new Date(term.expiresAt).getTime() > now.getTime();
}

export function daysUntilLicenseExpiry(term: LicenseTerm, now: Date = new Date()): number {
  const ms = new Date(term.expiresAt).getTime() - now.getTime();
  return Math.floor(ms / 86_400_000);
}

export function requiresLicense(edition: PackagingEdition): boolean {
  return edition !== "saas";
}
