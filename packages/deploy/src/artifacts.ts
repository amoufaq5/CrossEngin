import { z } from "zod";

const SHA_REGEX = /^[0-9a-f]{40}$/;
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const Iso8601 = z.string().datetime({ offset: true });

export const ARTIFACT_KINDS = [
  "vercel_build",
  "docker_image",
  "helm_chart",
  "ios_ipa",
  "android_aab",
  "source_map_bundle",
  "documentation_site",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const VercelArtifactSchema = z.object({
  kind: z.literal("vercel_build"),
  deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
  productionUrl: z.string().url().optional(),
  buildCacheHitRate: z.number().min(0).max(1).optional(),
});

const DockerArtifactSchema = z.object({
  kind: z.literal("docker_image"),
  registry: z.string().regex(/^(?:ghcr\.io|[a-z0-9.-]+)\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/i),
  tag: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  platforms: z.array(z.enum(["linux/amd64", "linux/arm64"])).min(1),
  signedBy: z.string().min(1).optional(),
});

const HelmChartArtifactSchema = z.object({
  kind: z.literal("helm_chart"),
  chartName: z.string().regex(/^[a-z][a-z0-9-]*$/),
  chartVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  registry: z.string().regex(/^oci:\/\/[a-z0-9.-]+\/[a-z0-9._/-]+$/),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

const IosArtifactSchema = z.object({
  kind: z.literal("ios_ipa"),
  bundleId: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/),
  buildNumber: z.number().int().positive(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  ipaSha256: z.string().regex(SHA256_REGEX),
  signedWith: z.string().min(1),
});

const AndroidArtifactSchema = z.object({
  kind: z.literal("android_aab"),
  applicationId: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/),
  versionCode: z.number().int().positive(),
  versionName: z.string().regex(/^\d+\.\d+\.\d+$/),
  aabSha256: z.string().regex(SHA256_REGEX),
  signedWith: z.string().min(1),
});

const SourceMapArtifactSchema = z.object({
  kind: z.literal("source_map_bundle"),
  appName: z.string().min(1),
  uploadedToSentry: z.boolean(),
  releaseId: z.string().min(1),
  bundleSha256: z.string().regex(SHA256_REGEX),
});

const DocumentationArtifactSchema = z.object({
  kind: z.literal("documentation_site"),
  buildUrl: z.string().url(),
  manifestSha256: z.string().regex(SHA256_REGEX),
});

export const BuildArtifactSchema = z
  .discriminatedUnion("kind", [
    VercelArtifactSchema,
    DockerArtifactSchema,
    HelmChartArtifactSchema,
    IosArtifactSchema,
    AndroidArtifactSchema,
    SourceMapArtifactSchema,
    DocumentationArtifactSchema,
  ])
  .superRefine((v, ctx) => {
    if (v.kind === "docker_image" && v.tag === "latest") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tag"],
        message: "'latest' tag is forbidden; use immutable semver or commit-sha tags",
      });
    }
    if (v.kind === "ios_ipa" && v.bundleId.split(".").length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bundleId"],
        message: "iOS bundle id should have at least three reverse-DNS segments",
      });
    }
  });
export type BuildArtifact = z.infer<typeof BuildArtifactSchema>;

export const ArtifactMetadataSchema = z.object({
  id: z.string().min(1),
  artifact: BuildArtifactSchema,
  builtAt: Iso8601,
  builtBy: z.string().min(1),
  commitSha: z.string().regex(SHA_REGEX),
  branch: z.string().min(1),
  ciRunId: z.string().min(1).optional(),
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

export function artifactDigest(artifact: BuildArtifact): string | null {
  switch (artifact.kind) {
    case "docker_image":
    case "helm_chart":
      return artifact.digest;
    case "ios_ipa":
      return artifact.ipaSha256;
    case "android_aab":
      return artifact.aabSha256;
    case "source_map_bundle":
      return artifact.bundleSha256;
    case "documentation_site":
      return artifact.manifestSha256;
    case "vercel_build":
      return null;
    default:
      return null;
  }
}

export function isReleasable(artifact: BuildArtifact): boolean {
  if (artifact.kind === "docker_image") return artifact.tag !== "latest";
  return true;
}
