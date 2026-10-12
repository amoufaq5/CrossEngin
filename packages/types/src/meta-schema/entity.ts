import { z } from "zod";
import { FieldSchema, type DataClassification, type Field } from "./field.js";
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
    /**
     * Declares that this entity deliberately replaces one of the same name inherited through
     * `meta.extends`. Resolution refuses an undeclared collision, so a pack cannot silently
     * destroy a parent's entity — and everything the parent hung off the replaced fields.
     */
    overrides: z.boolean().optional(),
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

/**
 * Which of the given fields carry a classification.
 *
 * It takes a **field list and not an `Entity`**, and that is the whole point of the signature. An
 * entity's own `fields` are not the fields its served table has: a trait contributes more, which is
 * why `resolvedFields` exists and why `validateManifest`, the column plan, the DDL emitter and
 * `listConfigForEntity` all read it rather than `entity.fields`. An entity-shaped signature here
 * made the narrow answer the easy one — three readers took it, two of them failing *open* — while
 * five call sites worked around it by passing `{...entity, fields: [...resolved]}`, a fabricated
 * entity whose only purpose was to widen the aperture of a function that should never have narrowed
 * it. A field list cannot be called wrongly: the caller must say which fields it means, and
 * `resolvedClassifiedFields` in `@crossengin/kernel/ddl` is the one answer for "as the served table
 * has them".
 */
export function classifiedFields(fields: readonly Field[]): readonly ClassifiedField[] {
  const out: ClassifiedField[] = [];
  for (const f of fields) {
    if (f.classification !== undefined) {
      out.push({ field: f.name, classification: f.classification });
    }
  }
  return out;
}
