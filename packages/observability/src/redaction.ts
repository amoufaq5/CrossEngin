import { z } from "zod";
import { DATA_CLASSES, type DataClass } from "@crossengin/jobs";

export { DATA_CLASSES };
export type { DataClass };

export const REDACTION_DEFAULT_PLACEHOLDER = "[REDACTED]";

export const DATA_CLASS_ORDER: Readonly<Record<DataClass, number>> = Object.freeze({
  public: 0,
  internal: 1,
  commercial_sensitive: 2,
  pii: 3,
  phi: 4,
  regulated: 5,
});

export const RedactionPolicySchema = z.object({
  redactAt: z.enum(DATA_CLASSES),
  placeholder: z.string().min(1).default(REDACTION_DEFAULT_PLACEHOLDER),
  dropEntirely: z.boolean().default(false),
});
export type RedactionPolicy = z.infer<typeof RedactionPolicySchema>;

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  redactAt: "pii",
  placeholder: REDACTION_DEFAULT_PLACEHOLDER,
  dropEntirely: false,
};

export type FieldClassMap = Readonly<Record<string, DataClass>>;

export interface RedactInput {
  readonly payload: unknown;
  readonly fieldClasses: FieldClassMap;
  readonly policy?: RedactionPolicy;
}

export interface RedactResult {
  readonly value: unknown;
  readonly redactedPaths: readonly string[];
}

export function shouldRedact(fieldClass: DataClass, policy: RedactionPolicy): boolean {
  return DATA_CLASS_ORDER[fieldClass] >= DATA_CLASS_ORDER[policy.redactAt];
}

export function redact(input: RedactInput): RedactResult {
  const policy = input.policy ?? DEFAULT_REDACTION_POLICY;
  const redactedPaths: string[] = [];
  const value = redactNode(input.payload, "", input.fieldClasses, policy, redactedPaths);
  return { value, redactedPaths };
}

function redactNode(
  node: unknown,
  path: string,
  fieldClasses: FieldClassMap,
  policy: RedactionPolicy,
  redactedPaths: string[],
): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((item, i) =>
      redactNode(
        item,
        path === "" ? `[${i}]` : `${path}[${i}]`,
        fieldClasses,
        policy,
        redactedPaths,
      ),
    );
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    const fullPath = path === "" ? key : `${path}.${key}`;
    const cls = fieldClasses[fullPath] ?? fieldClasses[key];
    if (cls !== undefined && shouldRedact(cls, policy)) {
      if (!policy.dropEntirely) {
        out[key] = policy.placeholder;
      }
      redactedPaths.push(fullPath);
      continue;
    }
    out[key] = redactNode(val, fullPath, fieldClasses, policy, redactedPaths);
  }
  return out;
}
