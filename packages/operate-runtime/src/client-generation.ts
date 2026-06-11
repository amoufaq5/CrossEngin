import { sha256 } from "@crossengin/crypto";
import {
  GenerationRunSchema,
  defaultConfigFor,
  type GenerationRun,
  type GeneratorConfig,
  type SpecSource,
  type TargetLanguage,
} from "@crossengin/sdk-clients";

import { emitOperateGoClient } from "./openapi-codegen-go.js";
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
export type SupportedClientLanguage = "typescript" | "python" | "go";

/** The built-in emitters keyed by sdk-clients `TargetLanguage`. */
const EMITTERS: Readonly<Record<SupportedClientLanguage, (doc: OpenApiDocument, name?: string) => string>> = {
  typescript: (doc, name) => emitOperateClientModule(doc, name !== undefined ? { clientName: name } : {}),
  python: (doc, name) => emitOperatePythonClient(doc, name !== undefined ? { className: name } : {}),
  go: (doc, name) => emitOperateGoClient(doc, name !== undefined ? { packageName: name } : {}),
};

/** The languages with a built-in emitter. */
export const SUPPORTED_CLIENT_LANGUAGES: readonly SupportedClientLanguage[] = ["typescript", "python", "go"];

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
