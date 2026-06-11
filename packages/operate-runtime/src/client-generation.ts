import { sha256 } from "@crossengin/crypto";
import {
  ClientReleaseSchema,
  CompatibilityEntrySchema,
  GenerationRunSchema,
  defaultConfigFor,
  type ClientRelease,
  type CompatibilityEntry,
  type GenerationRun,
  type GeneratorConfig,
  type ReleaseChannel,
  type SpecSource,
  type TargetLanguage,
} from "@crossengin/sdk-clients";

import { emitOperateGoClient } from "./openapi-codegen-go.js";
import { emitOperatePhpClient } from "./openapi-codegen-php.js";
import { emitOperateRubyClient } from "./openapi-codegen-rb.js";
import { emitOperatePythonClient } from "./openapi-codegen-py.js";
import { emitOperateClientModule } from "./openapi-codegen.js";
import type { OpenApiDocument } from "./openapi.js";

/**
 * Bridges the three built-in client emitters (P3.38 TS, P3.40 Python, P3.41 Go)
 * to the `@crossengin/sdk-clients` generation contract (P3.42). `generateClient`
 * runs the emitter for a `TargetLanguage` over a served `OpenApiDocument` and
 * returns a schema-valid `GenerationRun` (the contract's lifecycle record — a
 * `succeeded` run with the artifact's sha256 build-proof) plus the emitted source.
 * Languages without a built-in emitter yield a `failed` run (no source). Pure +
 * deterministic given a fixed `now`.
 */
export type SupportedClientLanguage = "typescript" | "python" | "go" | "php" | "ruby";

/** The built-in emitters keyed by sdk-clients `TargetLanguage`. */
const EMITTERS: Readonly<Record<SupportedClientLanguage, (doc: OpenApiDocument, name?: string) => string>> = {
  typescript: (doc, name) => emitOperateClientModule(doc, name !== undefined ? { clientName: name } : {}),
  python: (doc, name) => emitOperatePythonClient(doc, name !== undefined ? { className: name } : {}),
  go: (doc, name) => emitOperateGoClient(doc, name !== undefined ? { packageName: name } : {}),
  php: (doc, name) => emitOperatePhpClient(doc, name !== undefined ? { className: name } : {}),
  ruby: (doc, name) => emitOperateRubyClient(doc, name !== undefined ? { className: name } : {}),
};

/** The languages with a built-in emitter. */
export const SUPPORTED_CLIENT_LANGUAGES: readonly SupportedClientLanguage[] = ["typescript", "python", "go", "php", "ruby"];

/** Whether a `TargetLanguage` has a built-in emitter. */
export function clientLanguageSupported(language: TargetLanguage): language is SupportedClientLanguage {
  return language in EMITTERS;
}

export interface GenerateClientOptions {
  /** The actor/automation that triggered the run (audit). */
  readonly triggeredBy: string;
  /** Client factory (ts) / class (python) / package (go) name. */
  readonly clientName?: string;
  /** Fixed clock for deterministic runs (default `new Date()`). */
  readonly now?: Date;
  /** Stable run id (default derived from language + spec sha). */
  readonly runId?: string;
  /** Where the served OpenAPI document lives (default a synthetic local URL). */
  readonly specUrl?: string;
}

export interface ClientGenerationResult {
  readonly run: GenerationRun;
  /** The emitted client source; `null` for an unsupported language. */
  readonly source: string | null;
}

function specSourceFor(doc: OpenApiDocument, iso: string, specUrl: string): SpecSource {
  const json = JSON.stringify(doc);
  return {
    format: "openapi_3_1",
    sourceUrl: specUrl,
    sourceSha256: sha256(json),
    fetchedAt: iso,
    apiVersion: doc.info.version,
    sizeBytes: Math.max(1, Buffer.byteLength(json, "utf8")),
  };
}

/** Identifies the built-in emitter as the generator template for the run config. */
const TEMPLATE_PATH = "@crossengin/operate-runtime/openapi-codegen";

function configFor(language: TargetLanguage): GeneratorConfig {
  // The built-in emitters are hand-written templates, not openapi-generator.
  return { ...defaultConfigFor(language), tool: "custom_template", customTemplatePath: TEMPLATE_PATH };
}

/**
 * Runs the built-in emitter for `language` over `doc` and packages the result as
 * a sdk-clients `GenerationRun`. Supported languages → a `succeeded` run + source;
 * others → a `failed` run + `null` source.
 */
export function generateClient(
  doc: OpenApiDocument,
  language: TargetLanguage,
  options: GenerateClientOptions,
): ClientGenerationResult {
  const iso = (options.now ?? new Date()).toISOString();
  const specUrl = options.specUrl ?? "https://api.crossengin.local/v1/openapi.json";
  const config = configFor(language);
  const spec = specSourceFor(doc, iso, specUrl);

  if (!clientLanguageSupported(language)) {
    const run = GenerationRunSchema.parse({
      id: options.runId ?? `gen-${language}-${spec.sourceSha256.slice(0, 12)}`,
      language,
      config,
      spec,
      status: "failed",
      queuedAt: iso,
      startedAt: iso,
      completedAt: iso,
      durationSeconds: 0,
      triggeredBy: options.triggeredBy,
      failureReason: `no built-in emitter for ${language} (supported: ${SUPPORTED_CLIENT_LANGUAGES.join(", ")})`,
    });
    return { run, source: null };
  }

  const source = EMITTERS[language](doc, options.clientName);
  const artifactSha = sha256(source);
  const run = GenerationRunSchema.parse({
    id: options.runId ?? `gen-${language}-${artifactSha.slice(0, 12)}`,
    language,
    config,
    spec,
    status: "succeeded",
    queuedAt: iso,
    startedAt: iso,
    completedAt: iso,
    durationSeconds: 0,
    outputArtifactSha256: artifactSha,
    outputStorageUri: `mem://crossengin/clients/${language}/${artifactSha}`,
    triggeredBy: options.triggeredBy,
    testsPassed: 0,
    testsFailed: 0,
    lintWarnings: 0,
    lintErrors: 0,
  });
  return { run, source };
}

export interface PlanReleaseOptions {
  /** The release version (semver; stable channel forbids pre-release/build metadata). */
  readonly version: string;
  /** Release channel (default `stable`). */
  readonly channel?: ReleaseChannel;
  /** The package registry URL the artifact publishes to (a valid URL). */
  readonly registryPackageUri?: string;
  /** The changelog URL (a valid URL). */
  readonly changelogUrl?: string;
  /** When set, the release is `published` (stamps `publishedAt`/`publishedBy`); else a `draft`. */
  readonly publishedBy?: string;
  /** Marks the release as carrying breaking changes (gated on stable 0.x). */
  readonly breakingChanges?: boolean;
  /** Stable release id (default derived from language + version). */
  readonly id?: string;
  /** Fixed clock (default `new Date()`). */
  readonly now?: Date;
}

export interface ClientReleasePlan {
  readonly release: ClientRelease;
  readonly compatibility: CompatibilityEntry;
}

/**
 * Closes the publish pipeline (P3.43): turns a **succeeded** `ClientGenerationResult`
 * into a schema-valid `ClientRelease` (carrying the run's `artifactSha256`
 * build-proof + the artifact's byte size + a `generationRunId` back-link) plus a
 * `fully_compatible` `CompatibilityEntry` (the freshly-generated client tracks the
 * exact API version it was emitted from). Throws on a non-succeeded run.
 */
export function planClientRelease(result: ClientGenerationResult, options: PlanReleaseOptions): ClientReleasePlan {
  if (result.run.status !== "succeeded" || result.source === null || result.run.outputArtifactSha256 === null) {
    throw new Error(`cannot plan a release from a ${result.run.status} generation run`);
  }
  const { run } = result;
  const iso = (options.now ?? new Date()).toISOString();
  const channel: ReleaseChannel = options.channel ?? "stable";
  const published = options.publishedBy !== undefined;
  const language = run.language;
  const slug = language === "go" ? "go" : language;

  const release = ClientReleaseSchema.parse({
    id: options.id ?? `rel-${language}-${options.version}`,
    language,
    version: options.version,
    apiVersion: run.spec.apiVersion,
    channel,
    status: published ? "published" : "draft",
    artifactSha256: run.outputArtifactSha256,
    artifactSizeBytes: Math.max(1, Buffer.byteLength(result.source, "utf8")),
    registryPackageUri: options.registryPackageUri ?? `https://registry.crossengin.local/${slug}/operate-client`,
    generationRunId: run.id,
    changelogUrl: options.changelogUrl ?? "https://docs.crossengin.local/clients/changelog",
    breakingChanges: options.breakingChanges ?? false,
    ...(published ? { publishedAt: iso, publishedBy: options.publishedBy } : {}),
  });

  const compatibility = CompatibilityEntrySchema.parse({
    language,
    clientVersion: options.version,
    apiVersion: run.spec.apiVersion,
    level: "fully_compatible",
    warningCount: 0,
    determinedAt: iso,
  });

  return { release, compatibility };
}
