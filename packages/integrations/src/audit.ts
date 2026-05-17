import { z } from "zod";

export const DataClassSchema = z.enum([
  "public",
  "internal",
  "commercial_sensitive",
  "pii",
  "phi",
  "regulated",
]);
export type DataClass = z.infer<typeof DataClassSchema>;

export const IntegrationCallRecordSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  integrationId: z.string().min(1),
  operation: z.string().min(1),
  direction: z.enum(["inbound", "outbound"]),
  idempotencyKey: z.string().optional(),
  request: z.object({
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  }),
  response: z.object({
    status: z.number().int().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  }),
  latencyMs: z.number().nonnegative(),
  retries: z.number().int().nonnegative().optional(),
  ok: z.boolean(),
  errorMessage: z.string().optional(),
  dataClass: DataClassSchema.optional(),
  occurredAt: z.string(),
});
export type IntegrationCallRecord = z.infer<typeof IntegrationCallRecordSchema>;
