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
  /** An `array` field's element rule: each element is checked as a value of this kind. */
  readonly element?: FieldRule;
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

interface FieldTypeLike {
  readonly kind?: string;
  readonly values?: readonly string[];
  readonly maxLength?: number;
  readonly precision?: number;
  readonly scale?: number;
  /** An `array` field's element type. */
  readonly element?: FieldTypeLike;
}
interface FieldLike {
  readonly name: string;
  readonly required?: boolean;
  readonly type?: FieldTypeLike;
  readonly default?: { readonly kind?: string };
}
interface EntityLike {
  readonly name: string;
  readonly fields?: readonly FieldLike[];
}

/** One field's rule, as a plan holds it. */
function ruleOf(f: FieldLike): FieldRule {
  return {
    name: f.name,
    required: f.required === true,
    kind: f.type?.kind ?? "text",
    ...(f.type?.values !== undefined ? { enumValues: f.type.values } : {}),
    ...(f.type?.maxLength !== undefined ? { maxLength: f.type.maxLength } : {}),
    ...(f.type?.kind === "decimal" && f.type.precision !== undefined && f.type.scale !== undefined
      ? { decimal: { precision: f.type.precision, scale: f.type.scale } }
      : {}),
    ...(f.type?.kind === "array" && f.type.element !== undefined
      ? { element: ruleOf({ name: f.name, type: f.type.element }) }
      : {}),
    serverManaged: f.default?.kind === "sequence",
  };
}

/** Derives a per-entity validation plan from the manifest field schemas (keyed by entity name). */
export function buildValidationPlans(manifest: Manifest): ReadonlyMap<string, EntityValidationPlan> {
  const out = new Map<string, EntityValidationPlan>();
  for (const e of (manifest.entities ?? []) as ReadonlyArray<EntityLike>) {
    out.set(e.name, (e.fields ?? []).map(ruleOf));
  }
  return out;
}

/**
 * Whether a write would be allowed to store `value` in this field — the type check this module
 * applies to a present, non-empty value. A reader asking *can this field hold X* asks here rather
 * than inspecting the field's kind, so its answer cannot disagree with what a write accepts: an enum
 * holds only its values, a `text` field any string within its length, an `integer` no string at all.
 * Takes the field as the manifest declares it; the cast is the one `buildValidationPlans` makes.
 */
export function fieldAdmitsValue(field: { readonly name: string }, value: unknown): boolean {
  if (isEmpty(value)) return false;
  return checkType(ruleOf(field as FieldLike), value) === null;
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

/**
 * Membership, after `checkString` (the map wires it through `stringThen`): a non-string sent to an
 * enum field is a `type` error like one sent to a text field, where it used to answer `enum` — the
 * same JSON number got two codes depending on which kind of string field it hit (ADR-0443 Q6).
 */
const checkEnum: FieldCheck = (rule, value) =>
  rule.enumValues === undefined || (typeof value === "string" && rule.enumValues.includes(value))
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
 * A kind the API publishes as `type: "string"`. Before this a JSON number passed every one of them
 * (`checkTextLength` measures `String(value)`), and the two stores then disagreed about what was
 * stored: `--store pg` kept the JSON number `42` and handed it back as a number, while
 * `--store pg-columns` bound it into a `VARCHAR` and handed back `"42"`. Measured over `erp-core`'s
 * 427 own fields: 327 publish a string request schema and 197 of those accepted `42` (text 97,
 * reference 79, long_text 11, country_code 5, phone 4, url 1). The in-repo console never sends a
 * number to one — it posts a number only for an `integer` input — so the refusal breaks no client
 * that keeps to the published contract.
 */
const checkString: FieldCheck = (rule, value) =>
  typeof value === "string"
    ? null
    : { field: rule.name, code: "type", message: `${rule.name} must be a string` };

/** `checkString`, then `next` — for a string kind that also has a rule of its own. */
function stringThen(next: FieldCheck): FieldCheck {
  return (rule, value) => checkString(rule, value) ?? next(rule, value);
}

/**
 * The check for every field kind — a **total** map over `PrimitiveFieldType["kind"]`, so a
 * twenty-fourth kind is a compile error here rather than a field type that silently accepts
 * anything.
 *
 * It replaces a `switch` with `default: return null`, which is the shape that let the `datetime`
 * hole exist: **14 of the 23 kinds** reached that default, so "a client can store any string in a
 * `datetime` field" was not one oversight but one member of a class with fourteen members. Three
 * are closed here — `date`, `time`, `datetime`, the kinds whose values have an *order* a store
 * must agree about. Five more require a string and nothing further — `uuid`, `reference`,
 * `country_code`, `language_code`, `timezone` — because the response schema publishes them as one
 * (see `checkString`); their *format* is still a rule nobody has written. The six left `acceptAny`
 * — `json`, `file`, `currency_amount`, `geo_point`, `geo_polygon`, `duration` — are the kinds whose
 * published schema carries no `type` at all, so accepting any JSON there is the contract rather
 * than a gap in it.
 */
const FIELD_TYPE_CHECKS: { readonly [K in PrimitiveFieldType["kind"]]: FieldCheck } = {
  text: stringThen(checkTextLength),
  long_text: stringThen(checkTextLength),
  integer: checkNumber,
  decimal: checkNumber,
  boolean: checkBoolean,
  date: checkDate,
  time: checkTime,
  datetime: checkDatetime,
  duration: acceptAny,
  uuid: checkString,
  enum: stringThen(checkEnum),
  reference: checkString,
  json: acceptAny,
  file: acceptAny,
  email: checkEmail,
  phone: stringThen(checkTextLength),
  url: stringThen(checkTextLength),
  currency_amount: acceptAny,
  geo_point: acceptAny,
  geo_polygon: acceptAny,
  country_code: checkString,
  language_code: checkString,
  timezone: checkString,
};

/**
 * An `array<primitive>` field: the value must be an array and every element a legal value of the
 * element kind, by that kind's own check in `FIELD_TYPE_CHECKS` (ADR-0443 Q5). Before this an array
 * field took any JSON — a string, an object, `[1, {}]` into an `array<text>` — because `array` is not
 * a primitive kind and fell to the unnamed-kind arm below. A `null` element is refused as `type`:
 * an array of strings with a hole in it is not an array of strings. An element's error keeps its own
 * code (an element outside an enum is `enum`), and names its index so a caller can find it.
 */
function checkArray(rule: FieldRule, value: unknown): FieldError | null {
  if (!Array.isArray(value)) {
    return { field: rule.name, code: "type", message: `${rule.name} must be an array` };
  }
  const element = rule.element;
  if (element === undefined) return null;
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    const at = `${rule.name}[${i.toString()}]`;
    if (item === null || item === undefined) {
      return { field: rule.name, code: "type", message: `${at} must not be null` };
    }
    const err = checkType({ ...element, name: at }, item);
    if (err !== null) return { field: rule.name, code: err.code, message: err.message };
  }
  return null;
}

/**
 * The kind's check. `array` is answered by `checkArray`; a kind the map does not name — one a
 * manifest that never went through `validateManifest` might carry — is accepted, the only safe
 * answer for a kind with no rule.
 */
function checkType(rule: FieldRule, value: unknown): FieldError | null {
  if (rule.kind === "array") return checkArray(rule, value);
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
