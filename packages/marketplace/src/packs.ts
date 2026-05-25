import { z } from "zod";
import { ScopeKeySchema } from "@crossengin/sdk";

const PACK_ID_REGEX = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}$/;
const SEMVER_REGEX =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const Iso8601 = z.string().datetime({ offset: true });

export const PACK_KINDS = [
  "vertical_template",
  "integration_bundle",
  "ai_tool",
  "ui_extension",
  "workflow_pack",
  "compliance_addon",
  "data_connector",
  "theme",
] as const;
export type PackKind = (typeof PACK_KINDS)[number];
export const PackKindSchema = z.enum(PACK_KINDS);

export const PACK_AUTHOR_KINDS = [
  "crossengin_official",
  "certified_partner",
  "community",
  "private_tenant",
] as const;
export type PackAuthorKind = (typeof PACK_AUTHOR_KINDS)[number];
export const PackAuthorKindSchema = z.enum(PACK_AUTHOR_KINDS);

export const PackAuthorSchema = z
  .object({
    kind: PackAuthorKindSchema,
    name: z.string().min(1),
    email: z.string().email().optional(),
    homepageUrl: z.string().url().optional(),
    verifiedAt: Iso8601.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "certified_partner" && v.verifiedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifiedAt"],
        message: "certified_partner authors must have a verifiedAt timestamp",
      });
    }
    if (v.kind === "crossengin_official" && v.verifiedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifiedAt"],
        message: "crossengin_official authors must have a verifiedAt timestamp",
      });
    }
  });
export type PackAuthor = z.infer<typeof PackAuthorSchema>;

export const PackDependencySchema = z
  .object({
    packId: z.string().regex(PACK_ID_REGEX),
    versionRange: z.string().regex(/^[~^]?\d+\.\d+\.\d+$/, {
      message:
        "versionRange must be exact or ~/^ prefixed semver (e.g. '1.2.3', '^1.2.0', '~1.2.0')",
    }),
    optional: z.boolean().default(false),
  })
  .strict();
export type PackDependency = z.infer<typeof PackDependencySchema>;

export const PACK_LICENSES = [
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "proprietary",
  "crossengin-commercial",
] as const;
export type PackLicense = (typeof PACK_LICENSES)[number];

export const PackManifestSchema = z
  .object({
    id: z.string().regex(PACK_ID_REGEX, {
      message: "pack id must be reverse-DNS dotted lowercase (e.g. 'com.crossengin.pharmacy')",
    }),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    kind: PackKindSchema,
    author: PackAuthorSchema,
    license: z.enum(PACK_LICENSES),
    homepageUrl: z.string().url().optional(),
    repositoryUrl: z.string().url().optional(),
    iconUrl: z.string().url().optional(),
    keywords: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
    requiredScopes: z.array(ScopeKeySchema).default([]),
    optionalScopes: z.array(ScopeKeySchema).default([]),
    dependencies: z.array(PackDependencySchema).default([]),
    minPlatformVersion: z.string().regex(SEMVER_REGEX),
    maxPlatformVersion: z.string().regex(SEMVER_REGEX).optional(),
    requiresNetworkAccess: z.boolean().default(false),
    requiresPhiAccess: z.boolean().default(false),
    handlesUserData: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const requiredSet = new Set(v.requiredScopes);
    const optionalSet = new Set(v.optionalScopes);
    if (requiredSet.size !== v.requiredScopes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredScopes"],
        message: "requiredScopes must not contain duplicates",
      });
    }
    if (optionalSet.size !== v.optionalScopes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["optionalScopes"],
        message: "optionalScopes must not contain duplicates",
      });
    }
    for (const scope of v.optionalScopes) {
      if (requiredSet.has(scope)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["optionalScopes"],
          message: `scope '${scope}' cannot appear in both requiredScopes and optionalScopes`,
        });
      }
    }
    const deps = new Set<string>();
    v.dependencies.forEach((d, i) => {
      if (deps.has(d.packId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dependencies", i],
          message: `duplicate dependency on pack '${d.packId}'`,
        });
      }
      deps.add(d.packId);
      if (d.packId === v.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dependencies", i],
          message: "pack cannot depend on itself",
        });
      }
    });
    const kw = new Set<string>();
    v.keywords.forEach((k, i) => {
      if (kw.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["keywords", i],
          message: `duplicate keyword '${k}'`,
        });
      }
      kw.add(k);
    });
    if (v.requiresPhiAccess && !v.handlesUserData) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["handlesUserData"],
        message: "requiresPhiAccess=true implies handlesUserData=true",
      });
    }
    if (v.author.kind === "community" && v.requiresPhiAccess) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["author"],
        message:
          "community-authored packs cannot request PHI access (certified_partner or crossengin_official required)",
      });
    }
    if (
      v.maxPlatformVersion !== undefined &&
      compareSemver(v.maxPlatformVersion, v.minPlatformVersion) <= 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxPlatformVersion"],
        message: "maxPlatformVersion must be greater than minPlatformVersion",
      });
    }
  });
export type PackManifest = z.infer<typeof PackManifestSchema>;

function compareSemver(a: string, b: string): number {
  const parse = (s: string): readonly number[] =>
    s
      .replace(/^v/, "")
      .split("-")[0]
      ?.split(".")
      .map((p) => Number.parseInt(p, 10) || 0) ?? [];
  const aParts = parse(a);
  const bParts = parse(b);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function packAuthorTrusted(author: PackAuthor): boolean {
  return author.kind === "crossengin_official" || author.kind === "certified_partner";
}

export function requiresElevatedReview(pack: PackManifest): boolean {
  if (pack.requiresPhiAccess) return true;
  if (pack.requiredScopes.some((s) => s.endsWith(":admin"))) return true;
  if (!packAuthorTrusted(pack.author)) return true;
  return false;
}

export { compareSemver };
