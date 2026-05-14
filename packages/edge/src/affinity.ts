import { z } from "zod";
import { RegionSchema, type Region } from "@crossengin/residency";

const POLICY_ID_REGEX = /^[a-z][a-z0-9-]*$/;
const COOKIE_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const AFFINITY_KINDS = [
  "session_sticky",
  "write_region_pinned",
  "read_replica_round_robin",
  "latency_based",
  "tenant_residency_pinned",
] as const;
export type AffinityKind = (typeof AFFINITY_KINDS)[number];
export const AffinityKindSchema = z.enum(AFFINITY_KINDS);

export const AffinityRuleSchema = z
  .object({
    id: z.string().regex(POLICY_ID_REGEX),
    kind: AffinityKindSchema,
    ttlSeconds: z.number().int().nonnegative(),
    cookieName: z.string().regex(COOKIE_NAME_REGEX).optional(),
    cookieSecure: z.boolean().default(true),
    cookieSameSite: z.enum(["strict", "lax", "none"]).default("lax"),
    candidateRegions: z.array(RegionSchema).min(1),
    fallbackRegion: RegionSchema.optional(),
    sessionHeader: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "session_sticky" && v.cookieName === undefined && v.sessionHeader === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cookieName"],
        message: "session_sticky kind requires either cookieName or sessionHeader",
      });
    }
    if (v.kind === "write_region_pinned" && v.candidateRegions.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateRegions"],
        message: "write_region_pinned requires exactly one candidate region",
      });
    }
    if (v.kind === "read_replica_round_robin" && v.candidateRegions.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateRegions"],
        message: "read_replica_round_robin requires at least two candidate regions",
      });
    }
    if (v.fallbackRegion !== undefined && v.candidateRegions.includes(v.fallbackRegion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fallbackRegion"],
        message: "fallbackRegion must not be in candidateRegions (it's a last-resort outside the set)",
      });
    }
    if (
      v.cookieSameSite === "none" &&
      !v.cookieSecure &&
      v.cookieName !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cookieSecure"],
        message: "SameSite=None requires cookieSecure=true (browser enforcement)",
      });
    }
    const seen = new Set<Region>();
    v.candidateRegions.forEach((r, i) => {
      if (seen.has(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidateRegions", i],
          message: `duplicate candidate region '${r}'`,
        });
      }
      seen.add(r);
    });
  });
export type AffinityRule = z.infer<typeof AffinityRuleSchema>;

export interface AffinityResolutionInput {
  readonly cookieValue?: string;
  readonly sessionHeaderValue?: string;
  readonly hashSeed?: string;
  readonly previouslyChosen?: Region;
}

export function resolveAffinity(
  rule: AffinityRule,
  input: AffinityResolutionInput,
): Region {
  switch (rule.kind) {
    case "session_sticky": {
      const candidate = input.cookieValue ?? input.sessionHeaderValue;
      if (candidate !== undefined) {
        const match = rule.candidateRegions.find((r) => r === candidate);
        if (match !== undefined) return match;
      }
      if (input.previouslyChosen !== undefined && rule.candidateRegions.includes(input.previouslyChosen)) {
        return input.previouslyChosen;
      }
      return rule.candidateRegions[0] ?? rule.fallbackRegion ?? rule.candidateRegions[0]!;
    }
    case "write_region_pinned":
      return rule.candidateRegions[0] ?? rule.fallbackRegion!;
    case "read_replica_round_robin": {
      const seed = input.hashSeed ?? "";
      let hash = 0;
      for (let i = 0; i < seed.length; i++) {
        hash = (hash * 31 + seed.charCodeAt(i)) | 0;
      }
      const index = Math.abs(hash) % rule.candidateRegions.length;
      return rule.candidateRegions[index]!;
    }
    case "latency_based":
      return rule.candidateRegions[0]!;
    case "tenant_residency_pinned":
      return rule.candidateRegions[0]!;
  }
}

export function affinityCookieAttributes(rule: AffinityRule): string {
  const parts: string[] = [];
  parts.push(`Max-Age=${rule.ttlSeconds.toString()}`);
  parts.push("Path=/");
  parts.push(`SameSite=${rule.cookieSameSite[0]?.toUpperCase()}${rule.cookieSameSite.slice(1)}`);
  if (rule.cookieSecure) parts.push("Secure");
  parts.push("HttpOnly");
  return parts.join("; ");
}
