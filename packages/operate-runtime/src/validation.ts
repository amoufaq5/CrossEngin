import type { Manifest } from "@crossengin/kernel/manifest";
import type { PrimitiveFieldType } from "@crossengin/types/meta-schema";

import {
  datetimeSubmillisecondExceeded,
  toDateWire,
  toDatetimeWire,
  toTimeWire,
} from "./datetime.js";
import {
  decimalPrecisionExceeded,
  decimalScaleExceeded,
  parseDecimal,
  type DecimalSpec,
  type ExactDecimal,
} from "./decimal.js";

/** One field's validation rule, distilled from the manifest field schema. */
export interface FieldRule {
  readonly name: string;
  readonly required: boolean;
  readonly kind: string;
  readonly enumValues?: readonly string[];
  readonly maxLength?: number;
  /** A `decimal` field's declared precision/scale, so an over-precise literal can be refused. */
  readonly decimal?: DecimalSpec;
  /** Server-managed (e.g. a sequence default) — never client-validated. */
  readonly serverManaged: boolean;
}

export type EntityValidationPlan = readonly FieldRule[];

export type FieldErrorCode = "required" | "type" | "enum" | "maxLength" | "precision";

export interface FieldError {
  readonly field: string;
  readonly code: FieldErrorCode;
  readonly message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldLike {
  readonly name: string;
  readonly required?: boolean;
  readonly type?: {
    readonly kind?: string;
    readonly values?: readonly string[];
    readonly maxLength?: number;
    readonly precision?: number;
    readonly scale?: number;
  };
  readonly default?: { readonly kind?: string };
}
interface EntityLike {
  readonly name: string;
  readonly fields?: readonly FieldLike[];
}

/** Derives a per-entity validation plan from the manifest field schemas (keyed by entity name). */
export function buildValidationPlans(manifest: Manifest): ReadonlyMap<string, EntityValidationPlan> {
  const out = new Map<string, EntityValidationPlan>();
  for (const e of (manifest.entities ?? []) as ReadonlyArray<EntityLike>) {
    const rules: FieldRule[] = (e.fields ?? []).map((f) => ({
      name: f.name,
      required: f.required === true,
      kind: f.type?.kind ?? "text",
      ...(f.type?.values !== undefined ? { enumValues: f.type.values } : {}),
      ...(f.type?.maxLength !== undefined ? { maxLength: f.type.maxLength } : {}),
      ...(f.type?.kind === "decimal" && f.type.precision !== undefined && f.type.scale !== undefined
        ? { decimal: { precision: f.type.precision, scale: f.type.scale } }
        : {}),
      serverManaged: f.default?.kind === "sequence",
    }));
    out.set(e.name, rules);
  }
  return out;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** One kind's check: a `FieldError` when `value` is not a legal value for `rule`, else null. */
type FieldCheck = (rule: FieldRule, value: unknown) => FieldError | null;

/** Whether a parsed decimal has no fractional part left — the `integer` test, done exactly. */
function isWholeNumber(parsed: ExactDecimal): boolean {
  return parsed.scale === 0 || parsed.units % 10n ** BigInt(parsed.scale) === 0n;
}

/**
 * `integer` and `decimal`.
 *
 * The parse goes through `parseDecimal` — **the same function that will later convert the value**
 * — and not through `Number`, which is what made `POST {"list_price": "0x10"}` a **500**:
 * `Number("0x10")` is 16, so validation admitted it, and `withDecimalWireType`'s literal grammar
 * has no hexadecimal form, so the decorator raised `not_a_decimal (inbound)` and the handler
 * mapped that to `write_failed`. The rule is ADR-0332's provenance split, which that violated in
 * its own direction: a client literal is a 422 at validation, where it can still be fixed, and the
 * store boundary is for values a computation produced. Testing with one function and converting
 * with another is two spellings of one grammar, which is ADR-0332's defect class.
 */
const checkNumber: FieldCheck = (rule, value) => {
  const parsed = parseDecimal(value);
  if (parsed === null) {
    return { field: rule.name, code: "type", message: `${rule.name} must be a number` };
  }
  if (rule.kind === "integer" && !isWholeNumber(parsed)) {
    return { field: rule.name, code: "type", message: `${rule.name} must be a whole number` };
  }
  // A client literal carrying more precision than the field holds is refused, not rounded.
  // `NUMERIC(16, 2)` silently rounds 12345.6789 to 12345.68 on the typed store while the
  // JSONB store kept all four digits, so the two stores disagreed about a value both had
  // accepted. Quantising at the store boundary makes them agree; refusing here is what keeps
  // the loss from being silent, because the client is the one who can still correct it.
  if (rule.decimal !== undefined) {
    if (decimalPrecisionExceeded(value, rule.decimal)) {
      const whole = rule.decimal.precision - rule.decimal.scale;
      return {
        field: rule.name,
        code: "precision",
        message: `${rule.name} must have at most ${whole} digit(s) before the decimal point`,
      };
    }
    if (decimalScaleExceeded(value, rule.decimal)) {
      return {
        field: rule.name,
        code: "precision",
        message: `${rule.name} must have at most ${rule.decimal.scale} decimal place(s)`,
      };
    }
  }
  return null;
};

const checkBoolean: FieldCheck = (rule, value) =>
  typeof value === "boolean"
    ? null
    : { field: rule.name, code: "type", message: `${rule.name} must be true or false` };

const checkEmail: FieldCheck = (rule, value) =>
  typeof value === "string" && EMAIL_RE.test(value)
    ? null
    : { field: rule.name, code: "type", message: `${rule.name} must be a valid email address` };

const checkEnum: FieldCheck = (rule, value) =>
  rule.enumValues === undefined || rule.enumValues.includes(String(value))
    ? null
    : {
        field: rule.name,
        code: "enum",
        message: `${rule.name} must be one of: ${rule.enumValues.join(", ")}`,
      };

const checkTextLength: FieldCheck = (rule, value) =>
  rule.maxLength !== undefined && String(value).length > rule.maxLength
    ? {
        field: rule.name,
        code: "maxLength",
        message: `${rule.name} must be at most ${rule.maxLength} characters`,
      }
    : null;

/**
 * `datetime`.
 *
 * This is the case whose absence made a `datetime`'s text ordering correct only by coincidence:
 * every server writer spells an instant `toISOString()`, whose byte order *is* chronological, and
 * nothing stopped a client from storing any other spelling. Four spellings of one instant then
 * sort into three positions straddling an instant an hour later.
 *
 * It refuses with the same test the converter applies, so nothing admitted here can raise at the
 * store boundary, and it refuses **one thing the converter accepts**: a sub-millisecond literal.
 * The canonical form holds three fraction digits, so `…10:00:00.123456Z` cannot round-trip —
 * ADR-0332's split again, a client literal whose precision the field cannot hold being a 422 while
 * a computed value is truncated past it.
 */
const checkDatetime: FieldCheck = (rule, value) => {
  if (!toDatetimeWire(value).ok) {
    return {
      field: rule.name,
      code: "type",
      message:
        `${rule.name} must be an ISO 8601 instant with a UTC "Z" or an explicit offset ` +
        `(e.g. 2026-01-31T10:00:00.000Z)`,
    };
  }
  if (datetimeSubmillisecondExceeded(value)) {
    return {
      field: rule.name,
      code: "precision",
      message: `${rule.name} must have at most 3 fractional second digits (milliseconds)`,
    };
  }
  return null;
};

const checkDate: FieldCheck = (rule, value) =>
  toDateWire(value).ok
    ? null
    : {
        field: rule.name,
        code: "type",
        message: `${rule.name} must be a calendar date of the form YYYY-MM-DD (e.g. 2026-01-31)`,
      };

const checkTime: FieldCheck = (rule, value) =>
  toTimeWire(value).ok
    ? null
    : {
        field: rule.name,
        code: "type",
        message: `${rule.name} must be a time of day of the form HH:MM[:SS[.fraction]]`,
      };

/**
 * A kind with no client-side rule yet. Named rather than reached through a `default`, so the map
 * below stays total and the gap is a line somebody can see.
 */
const acceptAny: FieldCheck = () => null;

/**
 * The check for every field kind — a **total** map over `PrimitiveFieldType["kind"]`, so a
 * twenty-fourth kind is a compile error here rather than a field type that silently accepts
 * anything.
 *
 * It replaces a `switch` with `default: return null`, which is the shape that let the `datetime`
 * hole exist: **14 of the 23 kinds** reached that default, so "a client can store any string in a
 * `datetime` field" was not one oversight but one member of a class with fourteen members. Three
 * are closed here — `date`, `time`, `datetime`, the kinds whose values have an *order* a store
 * must agree about. The other eleven are `acceptAny` on purpose and not by accident: a `uuid`, a
 * `reference`, a `json`, a `file`, a `currency_amount`, a `geo_point`, a `geo_polygon`, a
 * `country_code`, a `language_code`, a `timezone` and a `duration` are each a validation rule
 * nobody has written, and each narrows an input contract that is currently open. They are now
 * eleven visible lines rather than an invisible fall-through.
 */
const FIELD_TYPE_CHECKS: { readonly [K in PrimitiveFieldType["kind"]]: FieldCheck } = {
  text: checkTextLength,
  long_text: checkTextLength,
  integer: checkNumber,
  decimal: checkNumber,
  boolean: checkBoolean,
  date: checkDate,
  time: checkTime,
  datetime: checkDatetime,
  duration: acceptAny,
  uuid: acceptAny,
  enum: checkEnum,
  reference: acceptAny,
  json: acceptAny,
  file: acceptAny,
  email: checkEmail,
  phone: checkTextLength,
  url: checkTextLength,
  currency_amount: acceptAny,
  geo_point: acceptAny,
  geo_polygon: acceptAny,
  country_code: acceptAny,
  language_code: acceptAny,
  timezone: acceptAny,
};

/**
 * A kind the map does not name: an `array` field (whose `kind` is `array`, not a primitive), and
 * any kind a manifest that never went through `validateManifest` might carry. Accepting is correct
 * for the first — an array has no scalar rule — and is the only safe answer for the second.
 */
function checkType(rule: FieldRule, value: unknown): FieldError | null {
  const check = FIELD_TYPE_CHECKS[rule.kind as PrimitiveFieldType["kind"]] as FieldCheck | undefined;
  return check === undefined ? null : check(rule, value);
}

/**
 * Validates a write body against an entity's plan. On `create`, a required field must be present
 * and non-empty; on `update` (a partial patch), a required field only errors if it is explicitly
 * set empty — absent fields are left untouched. Present, non-empty values are type/enum/length
 * checked. Server-managed fields (sequence defaults) are skipped.
 */
export function validateBody(
  plan: EntityValidationPlan,
  body: Record<string, unknown>,
  mode: "create" | "update",
): readonly FieldError[] {
  const errors: FieldError[] = [];
  for (const rule of plan) {
    if (rule.serverManaged) continue;
    const present = Object.prototype.hasOwnProperty.call(body, rule.name);
    const value = body[rule.name];
    const empty = isEmpty(value);
    if (rule.required && ((mode === "create" && (!present || empty)) || (mode === "update" && present && empty))) {
      errors.push({ field: rule.name, code: "required", message: `${rule.name} is required` });
      continue;
    }
    if (!present || empty) continue;
    const err = checkType(rule, value);
    if (err !== null) errors.push(err);
  }
  return errors;
}
