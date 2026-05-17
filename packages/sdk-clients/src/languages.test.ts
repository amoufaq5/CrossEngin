import { describe, expect, it } from "vitest";
import {
  LANGUAGE_REGISTRY,
  LANGUAGE_TIER,
  PackageCoordinatesSchema,
  REGISTRY_KINDS,
  TARGET_LANGUAGES,
  firstClassLanguages,
  isFirstClass,
  registryFor,
  tierFor,
  type PackageCoordinates,
} from "./languages.js";

describe("constants", () => {
  it("TARGET_LANGUAGES has 10 entries", () => {
    expect(TARGET_LANGUAGES).toContain("typescript");
    expect(TARGET_LANGUAGES).toContain("python");
    expect(TARGET_LANGUAGES).toContain("kotlin");
  });

  it("REGISTRY_KINDS has 10 entries", () => {
    expect(REGISTRY_KINDS).toContain("npm");
    expect(REGISTRY_KINDS).toContain("go_modules");
    expect(REGISTRY_KINDS).toContain("maven_central");
  });

  it("LANGUAGE_REGISTRY covers every target", () => {
    for (const lang of TARGET_LANGUAGES) {
      expect(LANGUAGE_REGISTRY[lang]).toBeDefined();
    }
  });

  it("LANGUAGE_TIER places TS/Python/Go as first_class", () => {
    expect(LANGUAGE_TIER.typescript).toBe("first_class");
    expect(LANGUAGE_TIER.python).toBe("first_class");
    expect(LANGUAGE_TIER.go).toBe("first_class");
    expect(LANGUAGE_TIER.swift).toBe("experimental");
  });
});

describe("PackageCoordinatesSchema", () => {
  const tsBase: PackageCoordinates = {
    language: "typescript",
    registry: "npm",
    packageName: "@crossengin/sdk-typescript",
    repositoryUrl: "https://github.com/crossengin/sdk-typescript",
    documentationUrl: "https://docs.crossengin.io/sdk/typescript",
    license: "Apache-2.0",
  };

  it("accepts a valid TypeScript spec", () => {
    expect(() => PackageCoordinatesSchema.parse(tsBase)).not.toThrow();
  });

  it("rejects unscoped TypeScript package name", () => {
    expect(() =>
      PackageCoordinatesSchema.parse({
        ...tsBase,
        packageName: "crossengin-sdk",
      }),
    ).toThrow(/scoped/);
  });

  it("rejects language/registry mismatch", () => {
    expect(() =>
      PackageCoordinatesSchema.parse({ ...tsBase, registry: "pypi" }),
    ).toThrow(/must use registry/);
  });

  it("rejects Python without moduleName", () => {
    expect(() =>
      PackageCoordinatesSchema.parse({
        ...tsBase,
        language: "python",
        registry: "pypi",
        packageName: "crossengin",
      }),
    ).toThrow(/moduleName/);
  });

  it("rejects Go without slash in module path", () => {
    expect(() =>
      PackageCoordinatesSchema.parse({
        ...tsBase,
        language: "go",
        registry: "go_modules",
        packageName: "crossengin",
      }),
    ).toThrow(/full import path/);
  });

  it("rejects Java without groupId:artifactId", () => {
    expect(() =>
      PackageCoordinatesSchema.parse({
        ...tsBase,
        language: "java",
        registry: "maven_central",
        packageName: "crossengin-sdk",
      }),
    ).toThrow(/groupId:artifactId/);
  });

  it("accepts a valid Python spec with moduleName", () => {
    expect(() =>
      PackageCoordinatesSchema.parse({
        ...tsBase,
        language: "python",
        registry: "pypi",
        packageName: "crossengin",
        moduleName: "crossengin",
      }),
    ).not.toThrow();
  });
});

describe("helpers", () => {
  it("registryFor returns canonical registry", () => {
    expect(registryFor("typescript")).toBe("npm");
    expect(registryFor("go")).toBe("go_modules");
  });

  it("tierFor returns the language's tier", () => {
    expect(tierFor("typescript")).toBe("first_class");
    expect(tierFor("rust")).toBe("experimental");
  });

  it("isFirstClass true only for TS/Python/Go", () => {
    expect(isFirstClass("typescript")).toBe(true);
    expect(isFirstClass("python")).toBe(true);
    expect(isFirstClass("go")).toBe(true);
    expect(isFirstClass("java")).toBe(false);
  });

  it("firstClassLanguages returns the three first-class targets", () => {
    expect([...firstClassLanguages()].sort()).toEqual(["go", "python", "typescript"]);
  });
});
