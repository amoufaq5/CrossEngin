// M4.14.t — shared `--threshold-alert <field>:<op><value>` CI-gate
// infrastructure for housekeeping dashboards. Closes ADR-0263 Q4 +
// ADR-0264 Q4.
//
// Surface:
//   --threshold-alert wouldPruneCount:>1000000
//   --threshold-alert lastPrunedAt:>24h
//   --threshold-alert totalRowCount:>=500000000
//
// Repeatable; alerts compose ("fail if ANY tripped"). Exit code 3 on
// any tripped alert (matches ADR-0181's exit-3 convention for "completed
// successfully but a configurable gate failed"). Composes with --watch
// (first tick that trips an alert exits with code 3 — fail-fast for CI
// gates running inside a watch loop).

import type { IoStreams } from "./format.js";
import { printError } from "./format.js";

export type ThresholdOp = "GT" | "GTE" | "LT" | "LTE" | "EQ";

const OP_TOKENS: Record<string, ThresholdOp> = {
  ">=": "GTE",
  "<=": "LTE",
  ">": "GT",
  "<": "LT",
  "=": "EQ",
};

// Field types determine which value kinds are valid.
//   number          — non-null numeric only (e.g., totalRowCount).
//   number_nullable — numeric or null; null SKIPS evaluation (no alert).
//   timestamp_nullable — ISO 8601 string or null; supports both absolute
//                        timestamp values AND duration values
//                        (interpreted relative to the report's asOf).
//                        Null is treated as "infinitely old" (always
//                        trips `>` / `>=` duration checks).
export type AlertableFieldType = "number" | "number_nullable" | "timestamp_nullable";

export interface AlertableFieldSpec {
  readonly name: string;
  readonly type: AlertableFieldType;
}

export type ThresholdValue =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "duration"; readonly ms: number; readonly raw: string }
  | { readonly kind: "timestamp"; readonly iso: string };

// M4.14.n — compound alert support. A ThresholdAlertSpec now consists
// of N clauses combined by AND/OR (or SINGLE for the original single-
// clause case). Backward compat: field/op/value at the top level mirror
// `clauses[0]` for SINGLE alerts AND act as the first-clause convenience
// accessor for compound alerts. Consumers wanting all clauses iterate
// `clauses` directly.
export interface ThresholdAlertClause {
  readonly raw: string;
  readonly field: string;
  readonly op: ThresholdOp;
  readonly value: ThresholdValue;
}

export type ThresholdCombinator = "SINGLE" | "AND" | "OR";

export interface ThresholdAlertSpec {
  readonly raw: string;
  // M4.14.n — combinator + clauses describe the compound expression.
  // SINGLE: clauses.length === 1; field/op/value mirror clauses[0].
  // AND: all clauses must trip for the alert to trip.
  // OR: any clause tripping causes the alert to trip (equivalent to
  // running each clause as a separate alert; OR within a flag is a
  // syntactic convenience).
  readonly combinator: ThresholdCombinator;
  readonly clauses: ReadonlyArray<ThresholdAlertClause>;
  // Backward-compat convenience accessors (mirror clauses[0]).
  readonly field: string;
  readonly op: ThresholdOp;
  readonly value: ThresholdValue;
}

// M4.14.n — per-clause evaluation result. Mirrors what `evaluateAlertOnRow`
// used to return for the single-clause case; surfaces individually in the
// `TrippedAlert.trippedClauses` array.
export interface TrippedClause {
  readonly clauseRaw: string;
  readonly fieldName: string;
  readonly op: ThresholdOp;
  readonly thresholdRaw: string;
  readonly actual: number | string | null;
  readonly ageMs?: number;
}

export interface TrippedAlert {
  readonly spec: string; // operator's original input string (full compound expression)
  readonly tableName: string;
  // M4.14.n — combinator-aware tripping. For AND, every clause must trip
  // for the alert to be considered tripped (all entries in trippedClauses).
  // For OR/SINGLE, at least one clause tripped (the entries that did).
  readonly combinator: ThresholdCombinator;
  readonly trippedClauses: ReadonlyArray<TrippedClause>;
  // Backward-compat convenience: first tripped clause's data. Consumers
  // wanting all clauses iterate `trippedClauses`. For SINGLE alerts these
  // mirror the only tripped clause.
  readonly fieldName: string;
  readonly op: ThresholdOp;
  readonly thresholdRaw: string;
  readonly actual: number | string | null;
  readonly ageMs?: number;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
};

const DURATION_RE = /^(\d+)([smhdwy])$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
// ISO 8601 — we don't validate strictly; Date.parse is the canonical check.

export interface ParseThresholdAlertResult {
  readonly ok: boolean;
  readonly alert?: ThresholdAlertSpec;
  readonly error?: string;
}

export function parseThresholdAlert(raw: string): ParseThresholdAlertResult {
  // M4.14.n — compound expression support. Detect AND/OR keywords (case-
  // sensitive uppercase with surrounding spaces) to disambiguate from
  // values that might contain "and"/"or" substrings. Mixed AND+OR in one
  // flag is rejected to keep grammar unambiguous; operators wanting
  // mixed semantics use separate --threshold-alert flags (cross-flag is
  // implicit OR).
  const hasAnd = raw.includes(" AND ");
  const hasOr = raw.includes(" OR ");
  if (hasAnd && hasOr) {
    return {
      ok: false,
      error: `invalid threshold alert '${raw}' — mixed AND/OR in one --threshold-alert is not supported (use multiple flags for OR composition)`,
    };
  }
  if (hasAnd || hasOr) {
    const combinator: ThresholdCombinator = hasAnd ? "AND" : "OR";
    const separator = hasAnd ? " AND " : " OR ";
    const parts = raw.split(separator);
    const clauses: ThresholdAlertClause[] = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length === 0) {
        return {
          ok: false,
          error: `invalid threshold alert '${raw}' — empty clause around '${separator.trim()}'`,
        };
      }
      const clauseResult = parseSingleClause(trimmed);
      if (!clauseResult.ok || clauseResult.clause === undefined) {
        return { ok: false, error: clauseResult.error };
      }
      clauses.push(clauseResult.clause);
    }
    if (clauses.length < 2) {
      return {
        ok: false,
        error: `invalid threshold alert '${raw}' — compound expression must have at least 2 clauses`,
      };
    }
    const first = clauses[0]!;
    return {
      ok: true,
      alert: {
        raw,
        combinator,
        clauses,
        field: first.field,
        op: first.op,
        value: first.value,
      },
    };
  }

  // Single-clause path (existing behavior).
  const clauseResult = parseSingleClause(raw);
  if (!clauseResult.ok || clauseResult.clause === undefined) {
    return { ok: false, error: clauseResult.error };
  }
  const clause = clauseResult.clause;
  return {
    ok: true,
    alert: {
      raw,
      combinator: "SINGLE",
      clauses: [clause],
      field: clause.field,
      op: clause.op,
      value: clause.value,
    },
  };
}

interface ParseClauseResult {
  readonly ok: boolean;
  readonly clause?: ThresholdAlertClause;
  readonly error?: string;
}

// Parses a single `<field>:<op><value>` clause. Extracted from the
// pre-M4.14.n single-clause parser body verbatim so the compound parser
// reuses the same value-kind detection.
function parseSingleClause(raw: string): ParseClauseResult {
  const colonIdx = raw.indexOf(":");
  if (colonIdx < 1) {
    return {
      ok: false,
      error: `invalid threshold alert '${raw}' — expected '<field>:<op><value>' (missing ':')`,
    };
  }
  const field = raw.slice(0, colonIdx);
  const rest = raw.slice(colonIdx + 1);
  if (rest.length === 0) {
    return {
      ok: false,
      error: `invalid threshold alert '${raw}' — missing operator + value after ':'`,
    };
  }

  // Match the longest operator prefix (>=, <= before >, < before =).
  let op: ThresholdOp | undefined;
  let valueStr = "";
  for (const [token, mapped] of Object.entries(OP_TOKENS)) {
    if (rest.startsWith(token)) {
      op = mapped;
      valueStr = rest.slice(token.length);
      break;
    }
  }
  if (op === undefined) {
    return {
      ok: false,
      error: `invalid threshold alert '${raw}' — operator must be one of >, >=, <, <=, =`,
    };
  }
  if (valueStr.length === 0) {
    return {
      ok: false,
      error: `invalid threshold alert '${raw}' — missing value after operator`,
    };
  }

  // Try number first (most common case for housekeeping CI gates).
  if (NUMBER_RE.test(valueStr)) {
    const num = Number(valueStr);
    if (!Number.isFinite(num)) {
      return {
        ok: false,
        error: `invalid threshold alert '${raw}' — value '${valueStr}' is not finite`,
      };
    }
    return { ok: true, clause: { raw, field, op, value: { kind: "number", value: num } } };
  }

  // Duration: digits + unit letter.
  const durMatch = DURATION_RE.exec(valueStr);
  if (durMatch !== null) {
    const num = Number(durMatch[1]);
    const unit = durMatch[2]!;
    const unitMs = DURATION_UNITS[unit];
    if (unitMs === undefined) {
      return {
        ok: false,
        error: `invalid threshold alert '${raw}' — unknown duration unit '${unit}' (expected s/m/h/d/w/y)`,
      };
    }
    return {
      ok: true,
      clause: { raw, field, op, value: { kind: "duration", ms: num * unitMs, raw: valueStr } },
    };
  }

  // ISO 8601 timestamp — try Date.parse.
  const parsed = Date.parse(valueStr);
  if (Number.isFinite(parsed)) {
    return {
      ok: true,
      clause: { raw, field, op, value: { kind: "timestamp", iso: valueStr } },
    };
  }

  return {
    ok: false,
    error: `invalid threshold alert '${raw}' — value '${valueStr}' is not a number, duration (e.g. 24h, 7d), or ISO 8601 timestamp`,
  };
}

// M4.14.t / M4.14.n — value-kind validation. The signature accepts a
// ThresholdAlertSpec for backward compat with the M4.14.t API but
// validates the SPEC's first clause; consumers wanting per-clause
// validation on compound alerts use `validateClauseAgainstField`.
// `parseThresholdAlertFlags` iterates clauses and calls the per-clause
// variant for compound specs.
export function validateAlertAgainstField(
  alert: ThresholdAlertSpec,
  field: AlertableFieldSpec,
): { ok: true } | { ok: false; error: string } {
  return validateClauseAgainstField(alert.clauses[0] ?? alert, field);
}

export function validateClauseAgainstField(
  clause: ThresholdAlertClause | ThresholdAlertSpec,
  field: AlertableFieldSpec,
): { ok: true } | { ok: false; error: string } {
  const isNumberKind = clause.value.kind === "number";
  const isDurationKind = clause.value.kind === "duration";
  const isTimestampKind = clause.value.kind === "timestamp";

  if (field.type === "number" || field.type === "number_nullable") {
    if (!isNumberKind) {
      return {
        ok: false,
        error: `threshold alert '${clause.raw}' — field '${field.name}' is numeric; value must be a number (not a duration or timestamp)`,
      };
    }
    return { ok: true };
  }
  // timestamp_nullable
  if (!isDurationKind && !isTimestampKind) {
    return {
      ok: false,
      error: `threshold alert '${clause.raw}' — field '${field.name}' is a timestamp; value must be a duration (e.g. 24h) or an ISO 8601 timestamp`,
    };
  }
  return { ok: true };
}

// Per-row evaluator. Returns the tripped alert (with actual values
// populated) or null if the alert doesn't trip on this row.
//
// Row shape: a string-keyed object whose values are number | string | null
// at the alertable field positions. The caller wires it from their
// report's per-table record.
export function evaluateAlertOnRow(
  alert: ThresholdAlertSpec,
  tableName: string,
  fieldValue: number | string | null,
  fieldType: AlertableFieldType,
  asOfMs: number,
): TrippedAlert | null {
  // M4.14.t / M4.14.n — backward-compat single-clause path. Operates on
  // the spec's first clause (or only clause for SINGLE). For compound
  // AND/OR alerts use `evaluateAlertCompound` instead.
  const clause = alert.clauses[0] ?? {
    raw: alert.raw,
    field: alert.field,
    op: alert.op,
    value: alert.value,
  };
  const trippedClause = evaluateClauseOnRow(clause, fieldValue, fieldType, asOfMs);
  if (trippedClause === null) return null;
  return {
    spec: alert.raw,
    tableName,
    combinator: alert.combinator,
    trippedClauses: [trippedClause],
    fieldName: trippedClause.fieldName,
    op: trippedClause.op,
    thresholdRaw: trippedClause.thresholdRaw,
    actual: trippedClause.actual,
    ...(trippedClause.ageMs !== undefined ? { ageMs: trippedClause.ageMs } : {}),
  };
}

// M4.14.n — per-clause primitive used by both the backward-compat
// evaluateAlertOnRow and the new compound evaluateAlertCompound. Returns
// a TrippedClause if the clause trips on this row's field value, else
// null.
function evaluateClauseOnRow(
  clause: ThresholdAlertClause,
  fieldValue: number | string | null,
  fieldType: AlertableFieldType,
  asOfMs: number,
): TrippedClause | null {
  // number / number_nullable fields
  if (fieldType === "number" || fieldType === "number_nullable") {
    if (fieldValue === null) return null; // null skips numeric alerts
    if (typeof fieldValue !== "number") return null;
    if (clause.value.kind !== "number") return null;
    if (!compareNumeric(fieldValue, clause.op, clause.value.value)) return null;
    return {
      clauseRaw: clause.raw,
      fieldName: clause.field,
      op: clause.op,
      thresholdRaw: String(clause.value.value),
      actual: fieldValue,
    };
  }

  // timestamp_nullable fields
  if (fieldType === "timestamp_nullable") {
    if (clause.value.kind === "duration") {
      // Duration check: compare (asOf - fieldValue) against threshold.
      // For null fields, treat as "infinitely old" — trips for GT/GTE,
      // never trips for LT/LTE/EQ.
      if (fieldValue === null) {
        if (clause.op === "GT" || clause.op === "GTE") {
          return {
            clauseRaw: clause.raw,
            fieldName: clause.field,
            op: clause.op,
            thresholdRaw: clause.value.raw,
            actual: null,
          };
        }
        return null;
      }
      if (typeof fieldValue !== "string") return null;
      const fieldMs = Date.parse(fieldValue);
      if (!Number.isFinite(fieldMs)) return null;
      const ageMs = asOfMs - fieldMs;
      if (!compareNumeric(ageMs, clause.op, clause.value.ms)) return null;
      return {
        clauseRaw: clause.raw,
        fieldName: clause.field,
        op: clause.op,
        thresholdRaw: clause.value.raw,
        actual: fieldValue,
        ageMs,
      };
    }

    if (clause.value.kind === "timestamp") {
      if (fieldValue === null) return null;
      if (typeof fieldValue !== "string") return null;
      const fieldMs = Date.parse(fieldValue);
      const thresholdMs = Date.parse(clause.value.iso);
      if (!Number.isFinite(fieldMs) || !Number.isFinite(thresholdMs)) return null;
      if (!compareNumeric(fieldMs, clause.op, thresholdMs)) return null;
      return {
        clauseRaw: clause.raw,
        fieldName: clause.field,
        op: clause.op,
        thresholdRaw: clause.value.iso,
        actual: fieldValue,
      };
    }
  }

  return null;
}

// M4.14.n — compound-aware evaluator. Iterates each clause against the
// row (via the caller-supplied `readField` closure), then combines per
// the spec's combinator (AND requires every clause to trip; OR/SINGLE
// require at least one).
//
// The dispatcher calls this once per (table, alert) pair; the evaluator
// owns the per-clause iteration so the dispatcher doesn't need to know
// about compound semantics.
export function evaluateAlertCompound(
  alert: ThresholdAlertSpec,
  tableName: string,
  readField: (field: string) => number | string | null,
  fieldTypeOf: (field: string) => AlertableFieldType | undefined,
  asOfMs: number,
): TrippedAlert | null {
  const trippedClauses: TrippedClause[] = [];
  for (const clause of alert.clauses) {
    const fieldType = fieldTypeOf(clause.field);
    if (fieldType === undefined) continue;
    const fieldValue = readField(clause.field);
    const tripped = evaluateClauseOnRow(clause, fieldValue, fieldType, asOfMs);
    if (tripped !== null) trippedClauses.push(tripped);
  }
  // AND: every clause must trip.
  // OR / SINGLE: at least one clause tripping is enough.
  const trips =
    alert.combinator === "AND"
      ? trippedClauses.length === alert.clauses.length
      : trippedClauses.length > 0;
  if (!trips) return null;
  const first = trippedClauses[0]!;
  return {
    spec: alert.raw,
    tableName,
    combinator: alert.combinator,
    trippedClauses,
    fieldName: first.fieldName,
    op: first.op,
    thresholdRaw: first.thresholdRaw,
    actual: first.actual,
    ...(first.ageMs !== undefined ? { ageMs: first.ageMs } : {}),
  };
}

function compareNumeric(actual: number, op: ThresholdOp, threshold: number): boolean {
  switch (op) {
    case "GT":
      return actual > threshold;
    case "GTE":
      return actual >= threshold;
    case "LT":
      return actual < threshold;
    case "LTE":
      return actual <= threshold;
    case "EQ":
      return actual === threshold;
  }
}

export function opSymbol(op: ThresholdOp): string {
  switch (op) {
    case "GT":
      return ">";
    case "GTE":
      return ">=";
    case "LT":
      return "<";
    case "LTE":
      return "<=";
    case "EQ":
      return "=";
  }
}

// CLI-side parser that takes the raw `--threshold-alert` flag occurrences,
// validates each against the surface's field registry, and returns the
// parsed alerts. Returns an exit code (2) on validation failure; the error
// message is already written to io.stderr.
export function parseThresholdAlertFlags(
  raws: ReadonlyArray<string>,
  fields: ReadonlyArray<AlertableFieldSpec>,
  io: IoStreams,
  actionLabel: string,
): ReadonlyArray<ThresholdAlertSpec> | number {
  if (raws.length === 0) return [];
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const alerts: ThresholdAlertSpec[] = [];
  for (const raw of raws) {
    const parsed = parseThresholdAlert(raw);
    if (!parsed.ok || parsed.alert === undefined) {
      printError(io, `${actionLabel}: ${parsed.error ?? "invalid threshold alert"}`);
      return 2;
    }
    // M4.14.n — validate EACH clause's field + value-kind. First failing
    // clause exits 2 with its specific error (operators reading errors
    // know which clause in a compound expression is broken).
    for (const clause of parsed.alert.clauses) {
      const fieldSpec = fieldByName.get(clause.field);
      if (fieldSpec === undefined) {
        const allowed = fields.map((f) => f.name).join(", ");
        printError(
          io,
          `${actionLabel}: threshold alert '${raw}' — unknown field '${clause.field}' (expected one of: ${allowed})`,
        );
        return 2;
      }
      const valid = validateClauseAgainstField(clause, fieldSpec);
      if (!valid.ok) {
        printError(io, `${actionLabel}: ${valid.error}`);
        return 2;
      }
    }
    alerts.push(parsed.alert);
  }
  return alerts;
}

// Render a single tripped alert as a human-readable line (used in the
// "THRESHOLD ALERTS" section after the main report).
export function renderTrippedAlert(alert: TrippedAlert): string {
  // M4.14.n — compound alerts render the spec plus the per-clause "what
  // was actual" detail so operators can see exactly which clauses tripped
  // (AND tripping requires all clauses; OR/SINGLE may have fewer).
  if (alert.combinator !== "SINGLE" && alert.trippedClauses.length > 1) {
    const clauseLines = alert.trippedClauses
      .map((c) => {
        const actualStr =
          c.actual === null
            ? "null (never set)"
            : typeof c.actual === "number"
              ? c.actual.toLocaleString("en-US")
              : c.actual;
        const ageSuffix = c.ageMs !== undefined ? ` (age ${formatDurationMs(c.ageMs)})` : "";
        return `      - ${c.fieldName}=${actualStr}${ageSuffix} [${c.clauseRaw}]`;
      })
      .join("\n");
    return `  ! ${alert.tableName} trips compound threshold "${alert.spec}"\n${clauseLines}`;
  }
  // Single-clause / single-tripped-clause rendering (backward compat).
  const actualStr =
    alert.actual === null
      ? "null (never set)"
      : typeof alert.actual === "number"
        ? alert.actual.toLocaleString("en-US")
        : alert.actual;
  let suffix = "";
  if (alert.ageMs !== undefined) {
    suffix = ` (age ${formatDurationMs(alert.ageMs)})`;
  }
  return `  ! ${alert.tableName} ${alert.fieldName}=${actualStr} trips threshold "${alert.spec}"${suffix}`;
}

function formatDurationMs(ms: number): string {
  if (ms < 0) return `${(-ms / 1000).toFixed(1)}s in the future`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

// M4.15.z — gh-summary Markdown row for a single tripped alert.
// Returns one Markdown table row (matching the | Table | Field |
// Actual | Threshold | Age | header from formatTrippedAlertsGh
// SummaryTable). Compound alerts render the per-clause "what was
// actual" detail joined with `<br>` line breaks inside the cell —
// keeps the table shape (5 cols) consistent without forcing the
// renderer to handle row-spanning Markdown (which GitHub doesn't).
export function formatTrippedAlertGhSummaryRow(alert: TrippedAlert): string {
  if (alert.combinator !== "SINGLE" && alert.trippedClauses.length > 1) {
    const fieldList = alert.trippedClauses.map((c) => `\`${c.fieldName}\``).join("<br>");
    const actualList = alert.trippedClauses
      .map((c) => mdFormatAlertValue(c.actual, c.ageMs))
      .join("<br>");
    const escapedSpec = mdEscapeAlertCell(alert.spec);
    return `| \`${alert.tableName}\` | ${fieldList} | ${actualList} | \`${escapedSpec}\` _(compound)_ | — |`;
  }
  const escapedSpec = mdEscapeAlertCell(alert.spec);
  return `| \`${alert.tableName}\` | \`${alert.fieldName}\` | ${mdFormatAlertValue(alert.actual, undefined)} | \`${escapedSpec}\` | ${alert.ageMs !== undefined ? formatDurationMs(alert.ageMs) : "—"} |`;
}

// Markdown-safe rendering of an actual value: null sentinel,
// numbers with toLocaleString thousands separators, strings
// backtick-wrapped + pipe-escaped. ageMs (when set) appended as
// `(age 1.5h)` suffix.
function mdFormatAlertValue(actual: number | string | null, ageMs: number | undefined): string {
  const formatted =
    actual === null
      ? "`null` _(never set)_"
      : typeof actual === "number"
        ? `\`${actual.toLocaleString("en-US")}\``
        : `\`${mdEscapeAlertCell(actual)}\``;
  return ageMs !== undefined ? `${formatted} _(age ${formatDurationMs(ageMs)})_` : formatted;
}

function mdEscapeAlertCell(s: string): string {
  // Pipe-escape + backslash-escape for Markdown table cells.
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

// M4.15.z — multi-alert gh-summary table (header + N rows). Caller
// emits the section ## title separately; this helper produces the
// table block as a single string with trailing newline.
export function formatTrippedAlertsGhSummaryTable(tripped: ReadonlyArray<TrippedAlert>): string {
  if (tripped.length === 0) return "";
  const lines: string[] = [];
  lines.push(`| Table | Field | Actual | Threshold | Age |`);
  lines.push(`|-------|-------|--------|-----------|-----|`);
  for (const alert of tripped) {
    lines.push(formatTrippedAlertGhSummaryRow(alert));
  }
  return lines.join("\n") + "\n";
}
