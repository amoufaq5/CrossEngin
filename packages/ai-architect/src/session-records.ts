import { z } from "zod";

export const ARCHITECT_PROPOSAL_DECISIONS = [
  "auto_approved",
  "interactive_approved",
  "interactive_denied",
  "no_changes",
  "invalid_manifest",
] as const;
export type ArchitectProposalDecision = (typeof ARCHITECT_PROPOSAL_DECISIONS)[number];

export const ArchitectSessionRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().min(1),
  sessionId: z.string().min(1),
  model: z.string().min(1),
  systemPromptSha256: z.string().length(64).nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  turnCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type ArchitectSessionRecord = z.infer<typeof ArchitectSessionRecordSchema>;

export const ArchitectMessageRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().min(1),
  sessionId: z.string().uuid(),
  turnIndex: z.number().int().nonnegative(),
  messageIndex: z.number().int().nonnegative(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCallId: z.string().nullable(),
  toolUses: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        input: z.unknown(),
      }),
    )
    .nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  createdAt: z.string().datetime(),
});
export type ArchitectMessageRecord = z.infer<typeof ArchitectMessageRecordSchema>;

export const ArchitectToolInvocationRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().min(1),
  sessionId: z.string().uuid(),
  messageId: z.string().uuid().nullable(),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown(),
  output: z.string(),
  isError: z.boolean(),
  durationMs: z.number().int().nonnegative().nullable(),
  startedAt: z.string().datetime(),
});
export type ArchitectToolInvocationRecord = z.infer<typeof ArchitectToolInvocationRecordSchema>;

export const ArchitectProposalRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().min(1),
  sessionId: z.string().uuid(),
  toolInvocationId: z.string().uuid().nullable(),
  targetPath: z.string().min(1),
  isNew: z.boolean(),
  oldHash: z.string().length(64).nullable(),
  newHash: z.string().length(64),
  entitiesAdded: z.number().int().nonnegative(),
  entitiesRemoved: z.number().int().nonnegative(),
  entitiesModified: z.number().int().nonnegative(),
  decision: z.enum(ARCHITECT_PROPOSAL_DECISIONS),
  applied: z.boolean(),
  denialReason: z.string().nullable(),
  proposedAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
});
export type ArchitectProposalRecord = z.infer<typeof ArchitectProposalRecordSchema>;
