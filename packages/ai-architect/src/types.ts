import { z } from "zod";

const ManifestPatchSchema = z.unknown();
const ManifestSchema = z.unknown();

export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

const AskOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});

export type AskOption = z.infer<typeof AskOptionSchema>;

export const AgentAskSchema = z.object({
  question: z.string().min(1),
  options: z.array(AskOptionSchema).optional(),
});

export type AgentAsk = z.infer<typeof AgentAskSchema>;

const ReadManifestCall = z.object({
  tool: z.literal("readManifest"),
  args: z.object({ tenantId: z.string().min(1) }),
});

const SearchSimilarManifestsCall = z.object({
  tool: z.literal("searchSimilarManifests"),
  args: z.object({
    query: z.string().min(1),
    topK: z.number().int().positive().optional(),
  }),
});

const SearchCompliancePackCall = z.object({
  tool: z.literal("searchCompliancePack"),
  args: z.object({ name: z.string().min(1) }),
});

const ReadUploadedDocumentCall = z.object({
  tool: z.literal("readUploadedDocument"),
  args: z.object({ docId: z.string().min(1) }),
});

const ProposeManifestPatchCall = z.object({
  tool: z.literal("proposeManifestPatch"),
  args: z.object({ patch: ManifestPatchSchema }),
});

const ValidateManifestCall = z.object({
  tool: z.literal("validateManifest"),
  args: z.object({ manifest: ManifestSchema }),
});

const PreviewManifestApplyCall = z.object({
  tool: z.literal("previewManifestApply"),
  args: z.object({ patch: ManifestPatchSchema }),
});

const ApplyManifestPatchCall = z.object({
  tool: z.literal("applyManifestPatch"),
  args: z.object({
    patch: ManifestPatchSchema,
    approvalToken: z.string().min(1),
  }),
});

const AskUserCall = z.object({
  tool: z.literal("askUser"),
  args: z.object({
    question: z.string().min(1),
    options: z.array(AskOptionSchema).optional(),
  }),
});

const FinishConversationCall = z.object({
  tool: z.literal("finishConversation"),
  args: z.object({ summary: z.string().min(1) }),
});

export const AgentToolCallSchema = z.discriminatedUnion("tool", [
  ReadManifestCall,
  SearchSimilarManifestsCall,
  SearchCompliancePackCall,
  ReadUploadedDocumentCall,
  ProposeManifestPatchCall,
  ValidateManifestCall,
  PreviewManifestApplyCall,
  ApplyManifestPatchCall,
  AskUserCall,
  FinishConversationCall,
]);

export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;
export type AgentToolName = AgentToolCall["tool"];

export const AGENT_TOOL_NAMES = [
  "readManifest",
  "searchSimilarManifests",
  "searchCompliancePack",
  "readUploadedDocument",
  "proposeManifestPatch",
  "validateManifest",
  "previewManifestApply",
  "applyManifestPatch",
  "askUser",
  "finishConversation",
] as const satisfies readonly AgentToolName[];

export const AgentPlanSchema = z.object({
  goal: z.string().min(1),
  nextAction: AgentToolCallSchema,
  confidence: ConfidenceSchema,
  rationale: z.string().optional(),
});

export type AgentPlan = z.infer<typeof AgentPlanSchema>;

export const AgentReflectionSchema = z.object({
  observation: z.string(),
  decision: z.enum(["continue", "ask_user", "finish"]),
});

export type AgentReflection = z.infer<typeof AgentReflectionSchema>;

export const AgentToolResultSchema = z.object({
  tool: z.string(),
  result: z.unknown(),
  latencyMs: z.number().nonnegative().optional(),
  errorMessage: z.string().optional(),
});

export type AgentToolResult = z.infer<typeof AgentToolResultSchema>;

export const AgentLoopStepSchema = z.object({
  iteration: z.number().int().nonnegative(),
  plan: AgentPlanSchema,
  toolCall: AgentToolCallSchema,
  toolResult: AgentToolResultSchema,
  reflection: AgentReflectionSchema,
});

export type AgentLoopStep = z.infer<typeof AgentLoopStepSchema>;

export const DiffSummarySchema = z.object({
  summary: z.string(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  modified: z.array(z.string()),
  destructive: z.boolean(),
});

export type DiffSummary = z.infer<typeof DiffSummarySchema>;

export const AgentTurnSchema = z.object({
  narration: z.string().min(1),
  asks: z.array(AgentAskSchema).optional(),
  diffSummary: DiffSummarySchema.optional(),
});

export type AgentTurn = z.infer<typeof AgentTurnSchema>;
