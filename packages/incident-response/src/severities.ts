import { z } from "zod";

export const SEVERITIES = ["sev1", "sev2", "sev3", "sev4", "sev5"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SeveritySchema = z.enum(SEVERITIES);

export interface SeverityProfile {
  readonly id: Severity;
  readonly label: string;
  readonly description: string;
  readonly ackMinutes: number;
  readonly mitigateMinutes: number;
  readonly resolveMinutes: number;
  readonly pageOnCall: boolean;
  readonly requiresStatusPage: boolean;
  readonly requiresExecutiveBrief: boolean;
  readonly postmortemRequired: boolean;
}

export const SEVERITY_PROFILES: Readonly<Record<Severity, SeverityProfile>> =
  Object.freeze({
    sev1: {
      id: "sev1",
      label: "SEV-1 / Critical",
      description: "Production down, data loss imminent, or active security incident",
      ackMinutes: 5,
      mitigateMinutes: 60,
      resolveMinutes: 240,
      pageOnCall: true,
      requiresStatusPage: true,
      requiresExecutiveBrief: true,
      postmortemRequired: true,
    },
    sev2: {
      id: "sev2",
      label: "SEV-2 / High",
      description: "Major feature down or significant degradation",
      ackMinutes: 15,
      mitigateMinutes: 240,
      resolveMinutes: 1440,
      pageOnCall: true,
      requiresStatusPage: true,
      requiresExecutiveBrief: false,
      postmortemRequired: true,
    },
    sev3: {
      id: "sev3",
      label: "SEV-3 / Medium",
      description: "Minor degradation or single-tenant impact",
      ackMinutes: 60,
      mitigateMinutes: 1440,
      resolveMinutes: 4320,
      pageOnCall: false,
      requiresStatusPage: false,
      requiresExecutiveBrief: false,
      postmortemRequired: false,
    },
    sev4: {
      id: "sev4",
      label: "SEV-4 / Low",
      description: "Cosmetic issue or future-impact warning",
      ackMinutes: 240,
      mitigateMinutes: 10_080,
      resolveMinutes: 43_200,
      pageOnCall: false,
      requiresStatusPage: false,
      requiresExecutiveBrief: false,
      postmortemRequired: false,
    },
    sev5: {
      id: "sev5",
      label: "SEV-5 / Informational",
      description: "Tracked observation; no immediate response",
      ackMinutes: 1440,
      mitigateMinutes: 43_200,
      resolveMinutes: 129_600,
      pageOnCall: false,
      requiresStatusPage: false,
      requiresExecutiveBrief: false,
      postmortemRequired: false,
    },
  });

export const SeverityProfileSchema = z
  .object({
    id: SeveritySchema,
    label: z.string().min(1),
    description: z.string().min(1),
    ackMinutes: z.number().int().positive(),
    mitigateMinutes: z.number().int().positive(),
    resolveMinutes: z.number().int().positive(),
    pageOnCall: z.boolean(),
    requiresStatusPage: z.boolean(),
    requiresExecutiveBrief: z.boolean(),
    postmortemRequired: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.ackMinutes >= v.mitigateMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mitigateMinutes"],
        message: "mitigateMinutes must be greater than ackMinutes",
      });
    }
    if (v.mitigateMinutes >= v.resolveMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolveMinutes"],
        message: "resolveMinutes must be greater than mitigateMinutes",
      });
    }
    if (v.id === "sev1" && !v.pageOnCall) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pageOnCall"],
        message: "sev1 must page on-call",
      });
    }
    if (v.id === "sev1" && !v.postmortemRequired) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postmortemRequired"],
        message: "sev1 must require a postmortem",
      });
    }
  });

export function profileFor(severity: Severity): SeverityProfile {
  return SEVERITY_PROFILES[severity];
}

export function requiresPostmortem(severity: Severity): boolean {
  return SEVERITY_PROFILES[severity].postmortemRequired;
}

export function ackDeadlineFor(severity: Severity, declaredAt: Date): Date {
  const minutes = SEVERITY_PROFILES[severity].ackMinutes;
  return new Date(declaredAt.getTime() + minutes * 60_000);
}

export function mitigateDeadlineFor(severity: Severity, declaredAt: Date): Date {
  const minutes = SEVERITY_PROFILES[severity].mitigateMinutes;
  return new Date(declaredAt.getTime() + minutes * 60_000);
}
