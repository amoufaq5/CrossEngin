import { z } from "zod";
import { DATA_CLASSES } from "@crossengin/jobs";

const Iso8601 = z.string().datetime({ offset: true });

export const FILE_OPERATIONS = [
  "upload_init",
  "upload_complete",
  "scan_clean",
  "scan_virus",
  "download",
  "regenerate",
  "lifecycle_archive",
  "lifecycle_cold",
  "delete_soft",
  "delete_hard",
  "quarantine_purge",
] as const;
export type FileOperation = (typeof FILE_OPERATIONS)[number];

export const FileAuditRecordSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  fileId: z.string().min(1),
  operation: z.enum(FILE_OPERATIONS),
  actor: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
    z.object({ kind: z.literal("system"), systemComponent: z.string().min(1) }),
    z.object({ kind: z.literal("ai_architect"), sessionId: z.string().min(1) }),
  ]),
  occurredAt: Iso8601,
  clientIp: z.string().min(1).nullable().default(null),
  userAgent: z.string().min(1).nullable().default(null),
  dataClass: z.enum(DATA_CLASSES),
  bytesTransferred: z.number().int().nonnegative().nullable().default(null),
  signedUrlOpaqueId: z.string().min(1).nullable().default(null),
  ok: z.boolean(),
  errorMessage: z.string().min(1).nullable().default(null),
});
export type FileAuditRecord = z.infer<typeof FileAuditRecordSchema>;
