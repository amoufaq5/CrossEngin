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
    /**
     * Declares that this entity deliberately replaces one of the same name inherited through
     * `meta.extends`. Resolution refuses an undeclared collision, so a pack cannot silently
     * destroy a parent's entity — and everything the parent hung off the replaced fields.
     */
    overrides: z.boolean().optional(),
    /**
     * Requires every generic `PATCH` of this entity to carry the `updated_at` it
     * last read, as a reserved `expectedUpdatedAt`. Absent, a write without one
     * is unconditional — which is how the guard shipped, and why it fenced
     * nothing in practice: a lost-update guard a client can decline is a guard
     * the client that forgets it does not have.
     *
     * Declared on the ENTITY, not configured per deployment, so a manifest cannot
     * serve the same records with the fence on in one environment and off in
     * another.
     */
    concurrency: z.enum(["optimistic"]).optional(),
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
