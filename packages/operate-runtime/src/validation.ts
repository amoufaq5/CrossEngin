import type { Manifest } from "@crossengin/kernel/manifest";

/** One field's validation rule, distilled from the manifest field schema. */
export interface FieldRule {
  readonly name: string;
  readonly required: boolean;
  readonly kind: string;
  readonly enumValues?: readonly string[];
  readonly maxLength?: number;
  /** Server-managed (e.g. a sequence default) — never client-validated. */
  readonly serverManaged: boolean;
}

export type EntityValidationPlan = readonly FieldRule[];

export type FieldErrorCode = "required" | "type" | "enum" | "maxLength";

export interface FieldError {
  readonly field: string;
  readonly code: FieldErrorCode;
  readonly message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldLike {
  readonly name: string;
  readonly required?: boolean;
  readonly type?: { readonly kind?: string; readonly values?: readonly string[]; readonly maxLength?: number };
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
      serverManaged: f.default?.kind === "sequence",
    }));
    out.set(e.name, rules);
  }
  return out;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function checkType(rule: FieldRule, value: unknown): FieldError | null {
  switch (rule.kind) {
    case "integer":
    case "decimal": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (!Number.isFinite(n)) return { field: rule.name, code: "type", message: `${rule.name} must be a number` };
      if (rule.kind === "integer" && !Number.isInteger(n)) {
        return { field: rule.name, code: "type", message: `${rule.name} must be a whole number` };
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean"
        ? null
        : { field: rule.name, code: "type", message: `${rule.name} must be true or false` };
    case "email":
      return typeof value === "string" && EMAIL_RE.test(value)
        ? null
        : { field: rule.name, code: "type", message: `${rule.name} must be a valid email address` };
    case "enum":
      return rule.enumValues === undefined || rule.enumValues.includes(String(value))
        ? null
        : { field: rule.name, code: "enum", message: `${rule.name} must be one of: ${rule.enumValues.join(", ")}` };
    case "text":
    case "long_text":
    case "url":
    case "phone":
      return rule.maxLength !== undefined && String(value).length > rule.maxLength
        ? { field: rule.name, code: "maxLength", message: `${rule.name} must be at most ${rule.maxLength} characters` }
        : null;
    default:
      return null;
  }
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
