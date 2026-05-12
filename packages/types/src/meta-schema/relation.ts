import { z } from "zod";

export const OnDeleteSchema = z.enum(["restrict", "cascade", "set_null"]);

export type OnDelete = z.infer<typeof OnDeleteSchema>;

const ManyToOneSchema = z.object({
  kind: z.literal("many_to_one"),
  from: z.string().min(1),
  field: z.string().min(1),
  to: z.string().min(1),
  onDelete: OnDeleteSchema.optional(),
});

const OneToManySchema = z.object({
  kind: z.literal("one_to_many"),
  from: z.string().min(1),
  field: z.string().min(1),
  to: z.string().min(1),
  onDelete: OnDeleteSchema.optional(),
});

const ManyToManySchema = z.object({
  kind: z.literal("many_to_many"),
  left: z.string().min(1),
  right: z.string().min(1),
});

export const RelationSchema = z.discriminatedUnion("kind", [
  ManyToOneSchema,
  OneToManySchema,
  ManyToManySchema,
]);

export type Relation = z.infer<typeof RelationSchema>;
