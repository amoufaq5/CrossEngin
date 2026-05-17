import { z } from "zod";
import { DATA_CLASSES, type DataClass } from "@crossengin/jobs";

export { DATA_CLASSES };
export type { DataClass };

export const ENTITY_NAME_REGEX = /^[A-Z][A-Za-z0-9]*$/;
export const FIELD_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

export const FieldClassificationSchema = z.object({
  field: z.string().regex(FIELD_NAME_REGEX),
  dataClass: z.enum(DATA_CLASSES),
  rationale: z.string().optional(),
});
export type FieldClassification = z.infer<typeof FieldClassificationSchema>;

export const EntityClassificationSchema = z
  .object({
    entity: z.string().regex(ENTITY_NAME_REGEX),
    defaultDataClass: z.enum(DATA_CLASSES),
    fields: z.array(FieldClassificationSchema).default([]),
    notes: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.fields.forEach((f, i) => {
      if (seen.has(f.field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", i, "field"],
          message: `duplicate field classification '${f.field}'`,
        });
      }
      seen.add(f.field);
    });
  });
export type EntityClassification = z.infer<typeof EntityClassificationSchema>;

export interface ResolvedFieldClass {
  readonly field: string;
  readonly dataClass: DataClass;
  readonly inherited: boolean;
}

export function resolveFieldClass(
  classification: EntityClassification,
  fieldName: string,
): ResolvedFieldClass {
  const explicit = classification.fields.find((f) => f.field === fieldName);
  if (explicit !== undefined) {
    return { field: fieldName, dataClass: explicit.dataClass, inherited: false };
  }
  return {
    field: fieldName,
    dataClass: classification.defaultDataClass,
    inherited: true,
  };
}

export function fieldClassMap(
  classification: EntityClassification,
  fieldNames: readonly string[],
): Readonly<Record<string, DataClass>> {
  const out: Record<string, DataClass> = {};
  for (const name of fieldNames) {
    out[name] = resolveFieldClass(classification, name).dataClass;
  }
  return out;
}
