import type { ClientRelease, CompatibilityEntry, ReleaseChannel, ReleaseStatus, TargetLanguage } from "@crossengin/sdk-clients";

export type SdkReleasesCommand = "list" | "compat" | "verify";
export type OutputFormat = "human" | "json";

export interface SdkReleasesCliOptions {
  readonly command: SdkReleasesCommand;
  readonly language: TargetLanguage | null;
  readonly channel: ReleaseChannel | null;
  readonly status: ReleaseStatus | null;
  readonly apiVersion: string | null;
  readonly limit: number | null;
  readonly format: OutputFormat;
  readonly help: boolean;
}

/**
 * The structural read surface the runner needs — satisfied by the
 * `PostgresClientReleaseStore` + `PostgresSdkCompatibilityStore` pair (wrapped by
 * the operate-server adapter). Both reads are bounded.
 */
export interface SdkLedgerSource {
  listReleases(query: {
    readonly language?: TargetLanguage;
    readonly channel?: ReleaseChannel;
    readonly status?: ReleaseStatus;
    readonly limit?: number;
  }): Promise<readonly ClientRelease[]>;
  listCompatibility(query: { readonly apiVersion?: string; readonly limit?: number }): Promise<readonly CompatibilityEntry[]>;
}

export type SdkLedgerIssueKind =
  | "release_without_compatibility"
  | "compatibility_without_release"
  | "published_release_incompatible";

export interface SdkLedgerIssue {
  readonly kind: SdkLedgerIssueKind;
  readonly language: TargetLanguage;
  readonly version: string;
  readonly apiVersion: string | null;
  readonly detail: string;
}

/**
 * Pure cross-table consistency checks over the release ledger + compatibility
 * matrix (neither is schema-enforceable per-row): a **published** release must
 * have a matching compatibility entry at its API version; every compatibility
 * entry must correspond to a known release; a published release whose compatibility
 * is `unsupported`/`blocked` is a contradiction. Deterministic.
 */
export function verifySdkLedger(
  releases: readonly ClientRelease[],
  compat: readonly CompatibilityEntry[],
): readonly SdkLedgerIssue[] {
  const issues: SdkLedgerIssue[] = [];
  const compatByTriple = new Map<string, CompatibilityEntry>();
  for (const c of compat) compatByTriple.set(`${c.language}:${c.clientVersion}:${c.apiVersion}`, c);
  const releaseByPair = new Set(releases.map((r) => `${r.language}:${r.version}`));

  for (const r of releases) {
    if (r.status !== "published") continue;
    const entry = compatByTriple.get(`${r.language}:${r.version}:${r.apiVersion}`);
    if (entry === undefined) {
      issues.push({
        kind: "release_without_compatibility",
        language: r.language,
        version: r.version,
        apiVersion: r.apiVersion,
        detail: `published ${r.language} ${r.version} has no compatibility entry for API ${r.apiVersion}`,
      });
    } else if (entry.level === "unsupported" || entry.level === "blocked") {
      issues.push({
        kind: "published_release_incompatible",
        language: r.language,
        version: r.version,
        apiVersion: r.apiVersion,
        detail: `published ${r.language} ${r.version} is marked ${entry.level} against API ${r.apiVersion}`,
      });
    }
  }
  for (const c of compat) {
    if (!releaseByPair.has(`${c.language}:${c.clientVersion}`)) {
      issues.push({
        kind: "compatibility_without_release",
        language: c.language,
        version: c.clientVersion,
        apiVersion: c.apiVersion,
        detail: `compatibility entry for ${c.language} ${c.clientVersion} has no matching release`,
      });
    }
  }
  return issues;
}

export function formatReleaseList(releases: readonly ClientRelease[], heading: string): string {
  if (releases.length === 0) return `${heading}\n  (none)`;
  const lines = releases.map(
    (r) =>
      `  ${r.language} ${r.version} [${r.channel}/${r.status}] api=${r.apiVersion} sha=${r.artifactSha256.slice(0, 10)} run=${r.generationRunId}`,
  );
  return `${heading}\n${lines.join("\n")}`;
}

export function formatCompatList(compat: readonly CompatibilityEntry[], heading: string): string {
  if (compat.length === 0) return `${heading}\n  (none)`;
  const lines = compat.map(
    (c) => `  ${c.language} ${c.clientVersion} -> api ${c.apiVersion}: ${c.level}${c.warningCount > 0 ? ` (${c.warningCount} warnings)` : ""}`,
  );
  return `${heading}\n${lines.join("\n")}`;
}

export function formatVerify(issues: readonly SdkLedgerIssue[], releaseCount: number, compatCount: number): string {
  if (issues.length === 0) return `sdk ledger: no drift (${releaseCount} releases, ${compatCount} compatibility entries)`;
  const lines = issues.map((i) => `  [${i.kind}] ${i.detail}`);
  return `sdk ledger drift (${issues.length}):\n${lines.join("\n")}`;
}

export interface RunSdkReleasesResult {
  readonly exitCode: number;
}

/**
 * Executes a parsed `sdk-releases` command against a ledger source, writing the
 * formatted output via `out`. `verify` exits 1 on any drift (the CI-gate contract,
 * like `slo verify`); `list`/`compat` are reads (always exit 0).
 */
export async function runSdkReleases(
  options: SdkReleasesCliOptions,
  source: SdkLedgerSource,
  out: (line: string) => void,
): Promise<RunSdkReleasesResult> {
  const json = options.format === "json";
  const limit = options.limit ?? undefined;

  if (options.command === "list") {
    const releases = await source.listReleases({
      ...(options.language !== null ? { language: options.language } : {}),
      ...(options.channel !== null ? { channel: options.channel } : {}),
      ...(options.status !== null ? { status: options.status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    out(json ? JSON.stringify(releases, null, 2) : formatReleaseList(releases, `client releases (${releases.length})`));
    return { exitCode: 0 };
  }

  if (options.command === "compat") {
    const compat = await source.listCompatibility({
      ...(options.apiVersion !== null ? { apiVersion: options.apiVersion } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    out(json ? JSON.stringify(compat, null, 2) : formatCompatList(compat, `compatibility entries (${compat.length})`));
    return { exitCode: 0 };
  }

  const releases = await source.listReleases(limit !== undefined ? { limit } : {});
  const compat = await source.listCompatibility(limit !== undefined ? { limit } : {});
  const issues = verifySdkLedger(releases, compat);
  out(json ? JSON.stringify(issues, null, 2) : formatVerify(issues, releases.length, compat.length));
  return { exitCode: issues.length > 0 ? 1 : 0 };
}

export class CliUsageError extends Error {}

function flagValue(argv: readonly string[], name: string): string | null {
  const exact = `--${name}`;
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === exact) {
      const v = argv[i + 1];
      if (v === undefined) throw new CliUsageError(`--${name} requires a value`);
      return v;
    }
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

const LANGUAGES = new Set(["typescript", "python", "go", "java", "csharp", "ruby", "rust", "php", "swift", "kotlin"]);
const CHANNELS = new Set(["stable", "beta", "rc", "nightly"]);
const STATUSES = new Set(["draft", "in_review", "published", "deprecated", "yanked"]);

/** Parses `sdk-releases <list|compat|verify> [flags]` (argv[0] is the command). */
export function parseSdkReleasesArgs(argv: readonly string[]): SdkReleasesCliOptions {
  const command = argv[0];
  if (command === "--help" || command === "-h" || command === undefined) {
    return { command: "list", language: null, channel: null, status: null, apiVersion: null, limit: null, format: "human", help: true };
  }
  if (command !== "list" && command !== "compat" && command !== "verify") {
    throw new CliUsageError(`unknown sdk-releases command: ${command} (list|compat|verify)`);
  }
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    return { command, language: null, channel: null, status: null, apiVersion: null, limit: null, format: "human", help: true };
  }

  const language = flagValue(rest, "language");
  if (language !== null && !LANGUAGES.has(language)) throw new CliUsageError(`invalid --language: ${language}`);
  const channel = flagValue(rest, "channel");
  if (channel !== null && !CHANNELS.has(channel)) throw new CliUsageError(`invalid --channel: ${channel}`);
  const status = flagValue(rest, "status");
  if (status !== null && !STATUSES.has(status)) throw new CliUsageError(`invalid --status: ${status}`);
  const formatRaw = flagValue(rest, "format") ?? "human";
  if (formatRaw !== "human" && formatRaw !== "json") throw new CliUsageError(`--format must be human|json`);
  const limitRaw = flagValue(rest, "limit");
  let limit: number | null = null;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) throw new CliUsageError(`--limit must be a positive integer`);
    limit = n;
  }

  return {
    command,
    language: language as TargetLanguage | null,
    channel: channel as ReleaseChannel | null,
    status: status as ReleaseStatus | null,
    apiVersion: flagValue(rest, "api-version"),
    limit,
    format: formatRaw,
    help: false,
  };
}

export const sdkReleasesHelpText = `operate-server sdk-releases — query + verify the persisted SDK release ledger

Usage:
  operate-server sdk-releases list   [--language <l>] [--channel <c>] [--status <s>] [--limit N] [--format human|json]
  operate-server sdk-releases compat [--api-version <v>] [--limit N] [--format human|json]
  operate-server sdk-releases verify [--limit N] [--format human|json]   (exits 1 on ledger drift)
`;
