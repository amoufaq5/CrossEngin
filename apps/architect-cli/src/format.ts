import type { ValidationError } from "@crossengin/kernel/manifest";

export interface IoStreams {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export function printJson(io: IoStreams, value: unknown): void {
  io.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function printSuccess(io: IoStreams, message: string): void {
  io.stdout.write(message + "\n");
}

export function printError(io: IoStreams, message: string): void {
  io.stderr.write(message + "\n");
}

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else if (typeof value === "object") {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatCsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string {
  const lines: string[] = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

export function printCsv(
  io: IoStreams,
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): void {
  io.stdout.write(formatCsv(headers, rows));
}

export function formatValidationErrors(errors: readonly ValidationError[]): string {
  if (errors.length === 0) return "no validation errors";
  const lines: string[] = [`${errors.length.toString()} validation error(s):`];
  for (const e of errors) {
    const codeSuffix = e.code !== undefined ? ` [${e.code}]` : "";
    lines.push(`  ${e.path}: ${e.message}${codeSuffix}`);
  }
  return lines.join("\n");
}

export interface SummaryCounts {
  readonly entities: number;
  readonly workflows: number;
  readonly views: number;
  readonly reports: number;
  readonly dashboards: number;
  readonly jobs: number;
  readonly integrations: number;
  readonly roles: number;
  readonly traits: number;
  readonly relations: number;
  readonly fileTypes: number;
  readonly customWidgets: number;
}

export interface ManifestSummary {
  readonly name: string;
  readonly slug: string;
  readonly version: string;
  readonly description: string | null;
  readonly extendsParents: number;
  readonly compliancePacks: number;
  readonly counts: SummaryCounts;
  readonly hash: string;
}

export function formatManifestSummary(summary: ManifestSummary): string {
  const lines: string[] = [];
  lines.push(`Manifest: ${summary.name}`);
  lines.push(`  slug:        ${summary.slug}`);
  lines.push(`  version:     ${summary.version}`);
  if (summary.description !== null) {
    lines.push(`  description: ${summary.description}`);
  }
  lines.push(`  hash:        ${summary.hash}`);
  if (summary.extendsParents > 0) {
    lines.push(`  extends:     ${summary.extendsParents.toString()} parent(s)`);
  }
  if (summary.compliancePacks > 0) {
    lines.push(`  packs:       ${summary.compliancePacks.toString()}`);
  }
  lines.push("");
  lines.push("  Counts:");
  lines.push(`    entities:        ${summary.counts.entities.toString()}`);
  lines.push(`    workflows:       ${summary.counts.workflows.toString()}`);
  lines.push(`    views:           ${summary.counts.views.toString()}`);
  lines.push(`    reports:         ${summary.counts.reports.toString()}`);
  lines.push(`    dashboards:      ${summary.counts.dashboards.toString()}`);
  lines.push(`    jobs:            ${summary.counts.jobs.toString()}`);
  lines.push(`    integrations:    ${summary.counts.integrations.toString()}`);
  lines.push(`    roles:           ${summary.counts.roles.toString()}`);
  lines.push(`    traits:          ${summary.counts.traits.toString()}`);
  lines.push(`    relations:       ${summary.counts.relations.toString()}`);
  lines.push(`    file types:      ${summary.counts.fileTypes.toString()}`);
  lines.push(`    custom widgets:  ${summary.counts.customWidgets.toString()}`);
  return lines.join("\n");
}

export interface DiffCounts {
  readonly entitiesAdded: number;
  readonly entitiesRemoved: number;
  readonly entitiesModified: number;
  readonly workflowsAdded: number;
  readonly workflowsRemoved: number;
  readonly workflowsModified: number;
}

export function formatDiff(counts: DiffCounts): string {
  const lines: string[] = ["Manifest diff:"];
  const sections: Array<readonly [string, number, number, number]> = [
    ["entities", counts.entitiesAdded, counts.entitiesRemoved, counts.entitiesModified],
    ["workflows", counts.workflowsAdded, counts.workflowsRemoved, counts.workflowsModified],
  ];
  let anyChange = false;
  for (const [name, added, removed, modified] of sections) {
    if (added + removed + modified > 0) {
      anyChange = true;
      lines.push(
        `  ${name}: +${added.toString()} -${removed.toString()} ~${modified.toString()}`,
      );
    }
  }
  if (!anyChange) {
    lines.push("  (no changes)");
  }
  return lines.join("\n");
}
