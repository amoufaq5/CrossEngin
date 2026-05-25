import { z } from "zod";
import { SeveritySchema } from "./severities.js";

const Iso8601 = z.string().datetime({ offset: true });
const INCIDENT_ID_REGEX = /^INC-\d{4}-\d{4,8}$/;
const POSTMORTEM_ID_REGEX = /^PM-\d{4}-\d{4,8}$/;

export const POSTMORTEM_STATUSES = ["drafting", "review", "published", "amended"] as const;
export type PostmortemStatus = (typeof POSTMORTEM_STATUSES)[number];
export const PostmortemStatusSchema = z.enum(POSTMORTEM_STATUSES);

export const POSTMORTEM_TRANSITIONS: Readonly<
  Record<PostmortemStatus, readonly PostmortemStatus[]>
> = Object.freeze({
  drafting: ["review"],
  review: ["drafting", "published"],
  published: ["amended"],
  amended: ["published"],
});

export function canTransitionPostmortem(from: PostmortemStatus, to: PostmortemStatus): boolean {
  return POSTMORTEM_TRANSITIONS[from].includes(to);
}

export const ACTION_ITEM_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type ActionItemPriority = (typeof ACTION_ITEM_PRIORITIES)[number];

export const ACTION_ITEM_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "completed",
  "won_t_fix",
] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export const ActionItemSchema = z
  .object({
    id: z.string().regex(/^ai-\d{4}-\d{4,8}$/, {
      message: "action item id must match 'ai-YYYY-NNNN'",
    }),
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    owner: z.string().min(1),
    priority: z.enum(ACTION_ITEM_PRIORITIES),
    status: z.enum(ACTION_ITEM_STATUSES),
    createdAt: Iso8601,
    dueAt: Iso8601,
    completedAt: Iso8601.nullable().default(null),
    blockedReason: z.string().min(1).optional(),
    wontFixReason: z.string().min(1).optional(),
    linkedTrackerUrl: z.string().url().optional(),
    preventsRecurrence: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (new Date(v.dueAt).getTime() <= new Date(v.createdAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dueAt"],
        message: "dueAt must be after createdAt",
      });
    }
    if (v.status === "completed" && v.completedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completed status requires completedAt",
      });
    }
    if (v.status === "blocked" && v.blockedReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockedReason"],
        message: "blocked status requires blockedReason",
      });
    }
    if (v.status === "won_t_fix" && v.wontFixReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["wontFixReason"],
        message: "won_t_fix status requires wontFixReason",
      });
    }
    if (v.priority === "critical" && !v.preventsRecurrence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preventsRecurrence"],
        message: "critical priority action items must preventsRecurrence=true",
      });
    }
  });
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const PostmortemSchema = z
  .object({
    id: z.string().regex(POSTMORTEM_ID_REGEX, {
      message: "postmortem id must match 'PM-YYYY-NNNN'",
    }),
    incidentId: z.string().regex(INCIDENT_ID_REGEX),
    title: z.string().min(1),
    severity: SeveritySchema,
    status: PostmortemStatusSchema,
    summary: z.string().min(1).max(5_000),
    rootCause: z.string().min(1),
    contributingFactors: z.array(z.string().min(1)).default([]),
    detection: z.string().min(1),
    response: z.string().min(1),
    impact: z.string().min(1),
    whatWentWell: z.array(z.string().min(1)).default([]),
    whatWentWrong: z.array(z.string().min(1)).min(1),
    lessonsLearned: z.array(z.string().min(1)).min(1),
    actionItems: z.array(ActionItemSchema).default([]),
    timelineSummary: z.string().min(1),
    authorUserId: z.string().min(1),
    reviewers: z.array(z.string().min(1)).default([]),
    createdAt: Iso8601,
    publishedAt: Iso8601.nullable().default(null),
    amendedAt: Iso8601.nullable().default(null),
    blamelessAttested: z.boolean(),
    confidentialityClass: z.enum([
      "public",
      "customer_facing",
      "internal_only",
      "security_restricted",
    ]),
    storageUri: z.string().url().optional(),
    storageSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.blamelessAttested) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blamelessAttested"],
        message: "postmortems must be attested blameless before publishing (culture invariant)",
      });
    }
    if (v.status === "published" || v.status === "amended") {
      if (v.publishedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publishedAt"],
          message: `status '${v.status}' requires publishedAt`,
        });
      }
      if (v.reviewers.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reviewers"],
          message: "published postmortems require at least 2 reviewers (peer review)",
        });
      }
    }
    if (v.status === "amended" && v.amendedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amendedAt"],
        message: "amended status requires amendedAt",
      });
    }
    if (v.severity === "sev1" && v.actionItems.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actionItems"],
        message: "sev1 postmortems must declare at least one action item",
      });
    }
    if (v.reviewers.includes(v.authorUserId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewers"],
        message: "author cannot be a reviewer of their own postmortem",
      });
    }
    const itemIds = new Set<string>();
    v.actionItems.forEach((a, i) => {
      if (itemIds.has(a.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actionItems", i, "id"],
          message: `duplicate action item id '${a.id}'`,
        });
      }
      itemIds.add(a.id);
    });
    const reviewerSet = new Set<string>();
    v.reviewers.forEach((r, i) => {
      if (reviewerSet.has(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reviewers", i],
          message: `duplicate reviewer '${r}'`,
        });
      }
      reviewerSet.add(r);
    });
  });
export type Postmortem = z.infer<typeof PostmortemSchema>;

export function openActionItems(pm: Postmortem): readonly ActionItem[] {
  return pm.actionItems.filter(
    (a) => a.status === "open" || a.status === "in_progress" || a.status === "blocked",
  );
}

export function overdueActionItems(pm: Postmortem, now: Date = new Date()): readonly ActionItem[] {
  return openActionItems(pm).filter((a) => new Date(a.dueAt).getTime() < now.getTime());
}

export function preventsRecurrenceItems(pm: Postmortem): readonly ActionItem[] {
  return pm.actionItems.filter((a) => a.preventsRecurrence);
}
