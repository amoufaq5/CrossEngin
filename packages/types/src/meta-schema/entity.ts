import { z } from "zod";
import { FieldSchema, type DataClassification } from "./field.js";
import { IndexDefinitionSchema } from "./index-def.js";

const ENTITY_NAME_REGEX = /^[A-Z][A-Za-z0-9]*$/;

export const EntityNameSchema = z.string().min(1).regex(ENTITY_NAME_REGEX, {
  message: "entity name must be PascalCase starting with an uppercase letter",
});

export const EntitySchema = z
  .object({
    name: EntityNameSchema,
    fields: z.array(FieldSchema).min(1),
    traits: z.array(z.string().min(1)).optional(),
    indexes: z.array(IndexDefinitionSchema).optional(),
    /** Functional department/module this entity belongs to (e.g. "Finance", "Human Resources"). UI grouping only. */
    module: z.string().min(1).optional(),
  })
  .refine(
    (v) => {
      const names = v.fields.map((f) => f.name);
      return new Set(names).size === names.length;
    },
    { message: "entity: field names must be unique" },
  )
  .refine(
    (v) => {
      if (!v.indexes) return true;
      const fieldNames = new Set(v.fields.map((f) => f.name));
      return v.indexes.every((idx) => idx.fields.every((f) => fieldNames.has(f)));
    },
    { message: "entity: index fields must reference fields declared on the entity" },
  );

export type Entity = z.infer<typeof EntitySchema>;

export interface ClassifiedField {
  readonly field: string;
  readonly classification: DataClassification;
}

export function entityClassifiedFields(entity: Entity): readonly ClassifiedField[] {
  const out: ClassifiedField[] = [];
  for (const f of entity.fields) {
    if (f.classification !== undefined) {
      out.push({ field: f.name, classification: f.classification });
    }
  }
  return out;
}
