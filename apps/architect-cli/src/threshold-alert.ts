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

export interface ThresholdAlertSpec {
  readonly raw: string;
  readonly field: string;
  readonly op: ThresholdOp;
  readonly value: ThresholdValue;
}

export interface TrippedAlert {
  readonly spec: string; // operator's original input string
  readonly tableName: string;
  readonly fieldName: string;
  readonly op: ThresholdOp;
  readonly thresholdRaw: string; // human-readable threshold value
  // Actual field value at evaluation time. Numeric for number fields,
  // ISO 8601 for timestamps. `null` if the field was null AND null
  // triggers (timestamp + GT/GTE with duration).
  readonly actual: number | string | null;
  // For timestamp fields only — the computed "age" in milliseconds
  // (now - lastPrunedAt). Useful for human-readable rendering.
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
    return { ok: true, alert: { raw, field, op, value: { kind: "number", value: num } } };
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
      alert: { raw, field, op, value: { kind: "duration", ms: num * unitMs, raw: valueStr } },
    };
  }

  // ISO 8601 timestamp — try Date.parse.
  const parsed = Date.parse(valueStr);
  if (Number.isFinite(parsed)) {
    return {
      ok: true,
      alert: { raw, field, op, value: { kind: "timestamp", iso: valueStr } },
    };
  }

  return {
    ok: false,
    error: `invalid threshold alert '${raw}' — value '${valueStr}' is not a number, duration (e.g. 24h, 7d), or ISO 8601 timestamp`,
  };
}

export function validateAlertAgainstField(
  alert: ThresholdAlertSpec,
  field: AlertableFieldSpec,
): { ok: true } | { ok: false; error: string } {
  const isNumberKind = alert.value.kind === "number";
  const isDurationKind = alert.value.kind === "duration";
  const isTimestampKind = alert.value.kind === "timestamp";

  if (field.type === "number" || field.type === "number_nullable") {
    if (!isNumberKind) {
      return {
        ok: false,
        error: `threshold alert '${alert.raw}' — field '${field.name}' is numeric; value must be a number (not a duration or timestamp)`,
      };
    }
    return { ok: true };
  }
  // timestamp_nullable
  if (!isDurationKind && !isTimestampKind) {
    return {
      ok: false,
      error: `threshold alert '${alert.raw}' — field '${field.name}' is a timestamp; value must be a duration (e.g. 24h) or an ISO 8601 timestamp`,
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
  // number / number_nullable fields
  if (fieldType === "number" || fieldType === "number_nullable") {
    if (fieldValue === null) return null; // null skips numeric alerts
    if (typeof fieldValue !== "number") return null;
    if (alert.value.kind !== "number") return null;
    if (!compareNumeric(fieldValue, alert.op, alert.value.value)) return null;
    return {
      spec: alert.raw,
      tableName,
      fieldName: alert.field,
      op: alert.op,
      thresholdRaw: String(alert.value.value),
      actual: fieldValue,
    };
  }

  // timestamp_nullable fields
  if (fieldType === "timestamp_nullable") {
    if (alert.value.kind === "duration") {
      // Duration check: compare (asOf - fieldValue) against threshold.
      // For null fields, treat as "infinitely old" — trips for GT/GTE,
      // never trips for LT/LTE/EQ.
      if (fieldValue === null) {
        if (alert.op === "GT" || alert.op === "GTE") {
          return {
            spec: alert.raw,
            tableName,
            fieldName: alert.field,
            op: alert.op,
            thresholdRaw: alert.value.raw,
            actual: null,
          };
        }
        return null;
      }
      if (typeof fieldValue !== "string") return null;
      const fieldMs = Date.parse(fieldValue);
      if (!Number.isFinite(fieldMs)) return null;
      const ageMs = asOfMs - fieldMs;
      if (!compareNumeric(ageMs, alert.op, alert.value.ms)) return null;
      return {
        spec: alert.raw,
        tableName,
        fieldName: alert.field,
        op: alert.op,
        thresholdRaw: alert.value.raw,
        actual: fieldValue,
        ageMs,
      };
    }

    if (alert.value.kind === "timestamp") {
      // Absolute timestamp check — compare row's field timestamp against
      // the threshold instant.
      if (fieldValue === null) return null;
      if (typeof fieldValue !== "string") return null;
      const fieldMs = Date.parse(fieldValue);
      const thresholdMs = Date.parse(alert.value.iso);
      if (!Number.isFinite(fieldMs) || !Number.isFinite(thresholdMs)) return null;
      if (!compareNumeric(fieldMs, alert.op, thresholdMs)) return null;
      return {
        spec: alert.raw,
        tableName,
        fieldName: alert.field,
        op: alert.op,
        thresholdRaw: alert.value.iso,
        actual: fieldValue,
      };
    }
  }

  return null;
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
    const fieldSpec = fieldByName.get(parsed.alert.field);
    if (fieldSpec === undefined) {
      const allowed = fields.map((f) => f.name).join(", ");
      printError(
        io,
        `${actionLabel}: threshold alert '${raw}' — unknown field '${parsed.alert.field}' (expected one of: ${allowed})`,
      );
      return 2;
    }
    const valid = validateAlertAgainstField(parsed.alert, fieldSpec);
    if (!valid.ok) {
      printError(io, `${actionLabel}: ${valid.error}`);
      return 2;
    }
    alerts.push(parsed.alert);
  }
  return alerts;
}

// Render a single tripped alert as a human-readable line (used in the
// "THRESHOLD ALERTS" section after the main report).
export function renderTrippedAlert(alert: TrippedAlert): string {
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
