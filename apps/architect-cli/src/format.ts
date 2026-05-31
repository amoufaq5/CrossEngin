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
export function printStructured(io: IoStreams, format: string, value: unknown): void {
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

export function escapeCsvCellWithSep(value: unknown, separator: string): string {
  if (value === null || value === undefined) return "";
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else if (typeof value === "object") {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  const sepEscape = separator === "\\" ? "\\\\" : separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`["\\n\\r${sepEscape}]`);
  if (pattern.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export interface CsvOpts {
  // M4.15.p — when true, skip the header row. For per-tenant CSV
  // fetches that append onto bulk-list output (e.g., `tenants get
  // <slug> --format csv-full --no-header >> all.csv`) the leading
  // header would otherwise produce a duplicate header line each
  // call. Default: false (header included; backward-compatible).
  readonly noHeader?: boolean;
}

// M4.15.q — `applyColumnsFilter` narrows a CSV (headers, rows) pair to
// the operator-specified subset. Caller pre-parses `--columns
// col1,col2` into a string[] and passes it here along with the full
// column set; we validate every requested column exists, then
// project each row onto the requested column indices.
//
// Returns either { ok: true, headers, rows } with the filtered shape,
// or { ok: false, error } describing what went wrong (unknown column,
// empty filter, duplicate). The caller surfaces the error via
// `printError` with command-specific framing (e.g., "tenants list:").
export type ApplyColumnsFilterResult =
  | {
      readonly ok: true;
      readonly headers: ReadonlyArray<string>;
      readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
    }
  | { readonly ok: false; readonly error: string };

export function applyColumnsFilter(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  columns: ReadonlyArray<string>,
): ApplyColumnsFilterResult {
  if (columns.length === 0) {
    return {
      ok: false,
      error: `--columns requires at least one column name (got empty list)`,
    };
  }
  const seen = new Set<string>();
  const indices: number[] = [];
  for (const col of columns) {
    if (seen.has(col)) {
      return {
        ok: false,
        error: `--columns has duplicate column '${col}'`,
      };
    }
    seen.add(col);
    const idx = headers.indexOf(col);
    if (idx === -1) {
      return {
        ok: false,
        error: `--columns includes unknown column '${col}' (valid: ${headers.join(", ")})`,
      };
    }
    indices.push(idx);
  }
  const filteredHeaders = indices.map((i) => headers[i]!);
  const filteredRows = rows.map((r) => indices.map((i) => r[i]));
  return { ok: true, headers: filteredHeaders, rows: filteredRows };
}

// Helper: parse `--columns "a,b,c"` into ["a","b","c"], trimming
// whitespace and dropping empty segments (from trailing commas etc).
// Returns null if the flag is unset (caller skips filter entirely).
export function parseColumnsFlag(raw: string | null): ReadonlyArray<string> | null {
  if (raw === null) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function formatCsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  separator: string = ",",
  opts: CsvOpts = {},
): string {
  const escape =
    separator === "," ? escapeCsvCell : (value: unknown) => escapeCsvCellWithSep(value, separator);
  const lines: string[] = [];
  if (opts.noHeader !== true) {
    lines.push(headers.map(escape).join(separator));
  }
  for (const row of rows) {
    lines.push(row.map(escape).join(separator));
  }
  // Empty output (no header + no rows) renders as bare newline; the
  // caller's stdout still terminates with newline so a redirected
  // `>> all.csv` doesn't lose the preceding line's terminator.
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

export function printCsv(
  io: IoStreams,
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  separator: string = ",",
  opts: CsvOpts = {},
): void {
  io.stdout.write(formatCsv(headers, rows, separator, opts));
}

export function formatTsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  opts: CsvOpts = {},
): string {
  return formatCsv(headers, rows, "\t", opts);
}

export function printTsv(
  io: IoStreams,
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  opts: CsvOpts = {},
): void {
  io.stdout.write(formatTsv(headers, rows, opts));
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
      lines.push(`  ${name}: +${added.toString()} -${removed.toString()} ~${modified.toString()}`);
    }
  }
  if (!anyChange) {
    lines.push("  (no changes)");
  }
  return lines.join("\n");
}
