import { z } from "zod";
import { FieldSchema } from "./field.js";

export const BUILTIN_TRAITS = [
  "auditable",
  "soft_deletable",
  "versioned",
  "tenant_owned",
  "gxp_signed",
  "part_11_compliant",
] as const;

export type BuiltinTraitName = (typeof BUILTIN_TRAITS)[number];

export const BuiltinTraitNameSchema = z.enum(BUILTIN_TRAITS);

const TRAIT_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

export const TraitSchema = z.object({
  name: z.string().min(1).regex(TRAIT_NAME_REGEX, {
    message: "trait name must be snake_case starting with a lowercase letter",
  }),
  fields: z.array(FieldSchema),
});

export type Trait = z.infer<typeof TraitSchema>;

export function isBuiltinTrait(name: string): name is BuiltinTraitName {
  return (BUILTIN_TRAITS as readonly string[]).includes(name);
}
