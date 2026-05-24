import type { ValidationError } from "@crossengin/kernel/manifest";

export interface IoStreams {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export function printJson(io: IoStreams, value: unknown): void {
  io.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  const str = String(value);
  const needsQuote =
    str === "" ||
    /^\s|\s$/.test(str) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(str) ||
    /:\s|\s#/.test(str) ||
    /[\n\t]/.test(str) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(str) ||
    /^[+-]?(\d|\.\d)/.test(str);
  if (needsQuote) {
    const escaped = str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return str;
}

function isContainer(v: unknown): boolean {
  return v !== null && typeof v === "object";
}

function isEmptyContainer(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (isContainer(v)) return Object.keys(v as object).length === 0;
  return false;
}

// Minimal YAML emitter (block style). Returns lines with NO leading
// indentation; the caller indents via indentYamlLines. Handles the
// scalar / array / object shapes the retention envelopes produce.
function yamlNode(value: unknown): string[] {
  if (!isContainer(value)) return [yamlScalar(value)];
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"];
    const out: string[] = [];
    for (const item of value) {
      const itemLines = yamlNode(item);
      out.push(`- ${itemLines[0] ?? ""}`);
      for (let i = 1; i < itemLines.length; i++) {
        out.push(`  ${itemLines[i]}`);
      }
    }
    return out;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return ["{}"];
  const out: string[] = [];
  for (const [k, v] of entries) {
    const key = yamlScalar(k);
    if (isContainer(v) && !isEmptyContainer(v)) {
      out.push(`${key}:`);
      out.push(...indentYamlLines(yamlNode(v), "  "));
    } else {
      out.push(`${key}: ${yamlNode(v)[0] ?? ""}`);
    }
  }
  return out;
}

function indentYamlLines(lines: string[], pad: string): string[] {
  return lines.map((l) => (l.length > 0 ? pad + l : l));
}

export function formatYaml(value: unknown): string {
  return yamlNode(value).join("\n") + "\n";
}

export function printYaml(io: IoStreams, value: unknown): void {
  io.stdout.write(formatYaml(value));
}

// Emit a structured envelope as JSON or YAML based on format. Used by
// retention surfaces where --format=json and --format=yaml share the
// same envelope shape.
export function printStructured(
  io: IoStreams,
  format: string,
  value: unknown,
): void {
  if (format === "yaml") {
    printYaml(io, value);
  } else {
    printJson(io, value);
  }
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

export function escapeCsvCellWithSep(
  value: unknown,
  separator: string,
): string {
  if (value === null || value === undefined) return "";
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else if (typeof value === "object") {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  const sepEscape =
    separator === "\\" ? "\\\\" : separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`["\\n\\r${sepEscape}]`);
  if (pattern.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatCsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  separator: string = ",",
): string {
  const escape = separator === ","
    ? escapeCsvCell
    : (value: unknown) => escapeCsvCellWithSep(value, separator);
  const lines: string[] = [headers.map(escape).join(separator)];
  for (const row of rows) {
    lines.push(row.map(escape).join(separator));
  }
  return lines.join("\n") + "\n";
}

export function printCsv(
  io: IoStreams,
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  separator: string = ",",
): void {
  io.stdout.write(formatCsv(headers, rows, separator));
}

export function formatTsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string {
  return formatCsv(headers, rows, "\t");
}

export function printTsv(
  io: IoStreams,
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): void {
  io.stdout.write(formatTsv(headers, rows));
}

export function formatNdjson(rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

export function printNdjson(io: IoStreams, rows: ReadonlyArray<unknown>): void {
  io.stdout.write(formatNdjson(rows));
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
