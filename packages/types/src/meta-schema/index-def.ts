import { z } from "zod";

export const IndexKindSchema = z.enum(["btree", "gin", "gist"]);

export type IndexKind = z.infer<typeof IndexKindSchema>;

export const IndexDefinitionSchema = z.object({
  fields: z.array(z.string().min(1)).min(1),
  kind: IndexKindSchema.optional(),
  unique: z.boolean().optional(),
});

export type IndexDefinition = z.infer<typeof IndexDefinitionSchema>;
