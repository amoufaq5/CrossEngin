import { z } from "zod";

export const TARGET_LANGUAGES = [
  "typescript",
  "python",
  "go",
  "java",
  "csharp",
  "ruby",
  "rust",
  "php",
  "swift",
  "kotlin",
] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];
export const TargetLanguageSchema = z.enum(TARGET_LANGUAGES);

export const REGISTRY_KINDS = [
  "npm",
  "pypi",
  "go_modules",
  "maven_central",
  "nuget",
  "rubygems",
  "crates_io",
  "packagist",
  "swift_package_index",
  "github_releases",
] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];
export const RegistryKindSchema = z.enum(REGISTRY_KINDS);

export const LANGUAGE_TIERS = ["first_class", "community", "experimental"] as const;
export type LanguageTier = (typeof LANGUAGE_TIERS)[number];

export const LANGUAGE_REGISTRY: Readonly<Record<TargetLanguage, RegistryKind>> = Object.freeze({
  typescript: "npm",
  python: "pypi",
  go: "go_modules",
  java: "maven_central",
  csharp: "nuget",
  ruby: "rubygems",
  rust: "crates_io",
  php: "packagist",
  swift: "swift_package_index",
  kotlin: "maven_central",
});

export const LANGUAGE_TIER: Readonly<Record<TargetLanguage, LanguageTier>> = Object.freeze({
  typescript: "first_class",
  python: "first_class",
  go: "first_class",
  java: "community",
  csharp: "community",
  ruby: "community",
  rust: "experimental",
  php: "experimental",
  swift: "experimental",
  kotlin: "experimental",
});

export const PackageCoordinatesSchema = z
  .object({
    language: TargetLanguageSchema,
    registry: RegistryKindSchema,
    packageName: z.string().min(1),
    moduleName: z.string().min(1).optional(),
    repositoryUrl: z.string().url(),
    documentationUrl: z.string().url(),
    homepageUrl: z.string().url().optional(),
    license: z.enum(["MIT", "Apache-2.0", "BSD-3-Clause", "proprietary"]),
  })
  .superRefine((v, ctx) => {
    const expected = LANGUAGE_REGISTRY[v.language];
    if (expected !== v.registry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["registry"],
        message: `language '${v.language}' must use registry '${expected}', not '${v.registry}' (Kotlin uses maven_central too)`,
      });
    }
    if (v.language === "typescript") {
      if (!v.packageName.startsWith("@")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packageName"],
          message: "TypeScript package names must be scoped (start with '@')",
        });
      }
    }
    if (v.language === "go") {
      if (!v.packageName.includes("/")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packageName"],
          message:
            "Go module paths must be a full import path (e.g., 'github.com/crossengin/crossengin-go')",
        });
      }
    }
    if (v.language === "python" && v.moduleName === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["moduleName"],
        message:
          "Python clients must declare moduleName (the importable identifier, distinct from the PyPI package name)",
      });
    }
    if (v.language === "java" || v.language === "kotlin") {
      if (!v.packageName.includes(":")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packageName"],
          message: `${v.language} packages must use 'groupId:artifactId' format`,
        });
      }
    }
  });
export type PackageCoordinates = z.infer<typeof PackageCoordinatesSchema>;

export function registryFor(language: TargetLanguage): RegistryKind {
  return LANGUAGE_REGISTRY[language];
}

export function tierFor(language: TargetLanguage): LanguageTier {
  return LANGUAGE_TIER[language];
}

export function isFirstClass(language: TargetLanguage): boolean {
  return LANGUAGE_TIER[language] === "first_class";
}

export function firstClassLanguages(): readonly TargetLanguage[] {
  return TARGET_LANGUAGES.filter((l) => LANGUAGE_TIER[l] === "first_class");
}
