import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });

export const TEST_OUTCOMES = ["passed", "failed", "timed_out", "skipped"] as const;
export type TestOutcome = (typeof TEST_OUTCOMES)[number];

export const TestRunRecordSchema = z.object({
  testId: z.string().min(1),
  ranAt: Iso8601,
  outcome: z.enum(TEST_OUTCOMES),
  durationMs: z.number().int().nonnegative(),
  commit: z.string().min(1),
  ciJobId: z.string().min(1).optional(),
});
export type TestRunRecord = z.infer<typeof TestRunRecordSchema>;

export const FLAKE_QUARANTINE_THRESHOLD = 0.05;

export interface FlakeStats {
  readonly testId: string;
  readonly totalRuns: number;
  readonly failures: number;
  readonly flakeRate: number;
  readonly recommended: "active" | "quarantine";
}

export function computeFlakeStats(
  records: readonly TestRunRecord[],
  threshold: number = FLAKE_QUARANTINE_THRESHOLD,
): readonly FlakeStats[] {
  if (threshold < 0 || threshold > 1) {
    throw new Error("threshold must be in [0, 1]");
  }
  const byTest = new Map<string, { total: number; failures: number }>();
  for (const record of records) {
    if (record.outcome === "skipped") continue;
    const stats = byTest.get(record.testId) ?? { total: 0, failures: 0 };
    stats.total++;
    if (record.outcome === "failed" || record.outcome === "timed_out") {
      stats.failures++;
    }
    byTest.set(record.testId, stats);
  }
  const result: FlakeStats[] = [];
  for (const [testId, stats] of byTest) {
    const flakeRate = stats.total === 0 ? 0 : stats.failures / stats.total;
    const recommended =
      flakeRate > threshold && stats.failures < stats.total ? "quarantine" : "active";
    result.push({
      testId,
      totalRuns: stats.total,
      failures: stats.failures,
      flakeRate,
      recommended,
    });
  }
  return result.sort((a, b) => b.flakeRate - a.flakeRate);
}

export function flakesToQuarantine(
  records: readonly TestRunRecord[],
  threshold: number = FLAKE_QUARANTINE_THRESHOLD,
): readonly string[] {
  return computeFlakeStats(records, threshold)
    .filter((s) => s.recommended === "quarantine")
    .map((s) => s.testId);
}

export const FlakeQuarantineTicketSchema = z
  .object({
    testId: z.string().min(1),
    quarantinedAt: Iso8601,
    quarantineSlaDays: z.number().int().min(1).max(30).default(7),
    issueUrl: z.string().url().optional(),
    flakeRate: z.number().min(0).max(1),
    runsAnalyzed: z.number().int().positive(),
    triagedBy: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.flakeRate <= FLAKE_QUARANTINE_THRESHOLD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["flakeRate"],
        message: `flakeRate ${v.flakeRate} is below quarantine threshold ${FLAKE_QUARANTINE_THRESHOLD}; no quarantine needed`,
      });
    }
  });
export type FlakeQuarantineTicket = z.infer<typeof FlakeQuarantineTicketSchema>;

export function isTicketOverdue(ticket: FlakeQuarantineTicket, now: Date = new Date()): boolean {
  const slaMs = ticket.quarantineSlaDays * 86_400_000;
  return now.getTime() - new Date(ticket.quarantinedAt).getTime() > slaMs;
}
