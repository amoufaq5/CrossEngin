import type { InstallationStatus, PackInstallation, UpdatePolicy } from "@crossengin/marketplace";

import { beginInstall, completeInstall, completeUninstall, newInstallationRequest, requestUninstall } from "./engine.js";

export type MarketplaceCommand = "list" | "verify" | "install" | "uninstall";
export type OutputFormat = "human" | "json";

export interface MarketplaceCliOptions {
  readonly command: MarketplaceCommand;
  readonly tenant: string | null;
  readonly pack: string | null;
  readonly version: string | null;
  readonly by: string | null;
  readonly updatePolicy: UpdatePolicy | null;
  readonly status: InstallationStatus | null;
  readonly limit: number | null;
  readonly format: OutputFormat;
  readonly help: boolean;
}

/**
 * The structural read+write surface the runner needs — satisfied by
 * `PostgresPackInstallationStore`. Both reads are bounded + tenant-scoped.
 */
export interface MarketplaceSource {
  listForTenant(
    tenantId: string,
    query: { readonly status?: InstallationStatus; readonly limit?: number },
  ): Promise<readonly PackInstallation[]>;
  activeForPack(tenantId: string, packId: string): Promise<PackInstallation | null>;
  record(installation: PackInstallation): Promise<void>;
}

/** Injected clock + id generator so the runner stays pure/testable. */
export interface MarketplaceRunDeps {
  readonly now: () => Date;
  readonly newId: () => string;
}

export type InstallLedgerIssueKind = "duplicate_active_install";

export interface InstallLedgerIssue {
  readonly kind: InstallLedgerIssueKind;
  readonly packId: string;
  readonly detail: string;
}

const TERMINAL: ReadonlySet<InstallationStatus> = new Set(["uninstalled", "failed"]);

/**
 * Pure ledger consistency check (not schema-enforceable per-row): a tenant must
 * have at most one **active** (non-terminal) installation per pack. Two would mean
 * a botched install/uninstall race.
 */
export function verifyInstallations(installations: readonly PackInstallation[]): readonly InstallLedgerIssue[] {
  const activeByPack = new Map<string, number>();
  for (const inst of installations) {
    if (TERMINAL.has(inst.status)) continue;
    activeByPack.set(inst.packId, (activeByPack.get(inst.packId) ?? 0) + 1);
  }
  const issues: InstallLedgerIssue[] = [];
  for (const [packId, count] of activeByPack) {
    if (count > 1) {
      issues.push({ kind: "duplicate_active_install", packId, detail: `${count} active installations of ${packId}` });
    }
  }
  return issues;
}

export function formatInstallationList(installs: readonly PackInstallation[], heading: string): string {
  if (installs.length === 0) return `${heading}\n  (none)`;
  const lines = installs.map(
    (i) => `  ${i.packId} [${i.status}] version=${i.installedVersion ?? "-"} policy=${i.updatePolicy} requested=${i.requestedAt}`,
  );
  return `${heading}\n${lines.join("\n")}`;
}

export function formatVerify(issues: readonly InstallLedgerIssue[], count: number): string {
  if (issues.length === 0) return `install ledger: no drift (${count} installations)`;
  return `install ledger drift (${issues.length}):\n${issues.map((i) => `  [${i.kind}] ${i.detail}`).join("\n")}`;
}

export interface RunMarketplaceResult {
  readonly exitCode: number;
}

/**
 * Executes a parsed `marketplace` command against an install source. `list`/`verify`
 * are reads (verify exits 1 on drift); `install`/`uninstall` drive the engine
 * (`newInstallationRequest` → `beginInstall` → `completeInstall` /
 * `requestUninstall` → `completeUninstall`) and persist the resulting record.
 */
export async function runMarketplace(
  options: MarketplaceCliOptions,
  source: MarketplaceSource,
  out: (line: string) => void,
  deps: MarketplaceRunDeps,
): Promise<RunMarketplaceResult> {
  const json = options.format === "json";
  const tenant = options.tenant!;
  const limit = options.limit ?? undefined;

  if (options.command === "list") {
    const installs = await source.listForTenant(tenant, {
      ...(options.status !== null ? { status: options.status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    out(json ? JSON.stringify(installs, null, 2) : formatInstallationList(installs, `installations (${installs.length})`));
    return { exitCode: 0 };
  }

  if (options.command === "verify") {
    const installs = await source.listForTenant(tenant, limit !== undefined ? { limit } : {});
    const issues = verifyInstallations(installs);
    out(json ? JSON.stringify(issues, null, 2) : formatVerify(issues, installs.length));
    return { exitCode: issues.length > 0 ? 1 : 0 };
  }

  const iso = deps.now().toISOString();

  if (options.command === "install") {
    const existing = await source.activeForPack(tenant, options.pack!);
    if (existing !== null) {
      out(`refused: ${options.pack} already has an active installation (${existing.status})`);
      return { exitCode: 1 };
    }
    const requested = newInstallationRequest({
      id: deps.newId(),
      tenantId: tenant,
      packId: options.pack!,
      requestedBy: options.by!,
      requestedAt: iso,
      ...(options.updatePolicy !== null ? { updatePolicy: options.updatePolicy } : {}),
    });
    const installed = completeInstall(beginInstall(requested), { version: options.version!, installedBy: options.by!, at: iso });
    await source.record(installed);
    out(json ? JSON.stringify(installed, null, 2) : `installed ${options.pack} ${options.version} (${installed.id})`);
    return { exitCode: 0 };
  }

  // uninstall
  const active = await source.activeForPack(tenant, options.pack!);
  if (active === null || active.status !== "installed") {
    out(`refused: ${options.pack} is not installed`);
    return { exitCode: 1 };
  }
  const uninstalled = completeUninstall(requestUninstall(active), { uninstalledBy: options.by!, at: iso });
  await source.record(uninstalled);
  out(json ? JSON.stringify(uninstalled, null, 2) : `uninstalled ${options.pack} (${uninstalled.id})`);
  return { exitCode: 0 };
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

const STATUSES = new Set([
  "requested",
  "permission_pending",
  "installing",
  "installed",
  "updating",
  "failed",
  "uninstalling",
  "uninstalled",
]);
const POLICIES = new Set(["manual", "patch_auto", "minor_auto", "track_latest"]);

/** Parses `marketplace <list|verify|install|uninstall> [flags]` (argv[0] is the command). */
export function parseMarketplaceArgs(argv: readonly string[]): MarketplaceCliOptions {
  const base: MarketplaceCliOptions = {
    command: "list",
    tenant: null,
    pack: null,
    version: null,
    by: null,
    updatePolicy: null,
    status: null,
    limit: null,
    format: "human",
    help: true,
  };
  const command = argv[0];
  if (command === "--help" || command === "-h" || command === undefined) return base;
  if (command !== "list" && command !== "verify" && command !== "install" && command !== "uninstall") {
    throw new CliUsageError(`unknown marketplace command: ${command} (list|verify|install|uninstall)`);
  }
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) return { ...base, command };

  const tenant = flagValue(rest, "tenant");
  if (tenant === null) throw new CliUsageError(`--tenant <uuid> is required`);
  const status = flagValue(rest, "status");
  if (status !== null && !STATUSES.has(status)) throw new CliUsageError(`invalid --status: ${status}`);
  const updatePolicy = flagValue(rest, "update-policy");
  if (updatePolicy !== null && !POLICIES.has(updatePolicy)) throw new CliUsageError(`invalid --update-policy: ${updatePolicy}`);
  const formatRaw = flagValue(rest, "format") ?? "human";
  if (formatRaw !== "human" && formatRaw !== "json") throw new CliUsageError(`--format must be human|json`);
  const limitRaw = flagValue(rest, "limit");
  let limit: number | null = null;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) throw new CliUsageError(`--limit must be a positive integer`);
    limit = n;
  }
  const pack = flagValue(rest, "pack");
  const version = flagValue(rest, "version");
  const by = flagValue(rest, "by");

  if (command === "install" && (pack === null || version === null || by === null)) {
    throw new CliUsageError(`install requires --pack <id> --version <semver> --by <uuid>`);
  }
  if (command === "uninstall" && (pack === null || by === null)) {
    throw new CliUsageError(`uninstall requires --pack <id> --by <uuid>`);
  }

  return {
    command,
    tenant,
    pack,
    version,
    by,
    updatePolicy: updatePolicy as UpdatePolicy | null,
    status: status as InstallationStatus | null,
    limit,
    format: formatRaw,
    help: false,
  };
}

export const marketplaceHelpText = `operate-server marketplace — install + query the per-tenant pack ledger

Usage:
  operate-server marketplace list      --tenant <uuid> [--status <s>] [--limit N] [--format human|json]
  operate-server marketplace verify    --tenant <uuid> [--limit N] [--format human|json]   (exits 1 on drift)
  operate-server marketplace install   --tenant <uuid> --pack <id> --version <semver> --by <uuid> [--update-policy <p>]
  operate-server marketplace uninstall --tenant <uuid> --pack <id> --by <uuid>
`;
