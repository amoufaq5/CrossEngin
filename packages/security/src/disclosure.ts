import { z } from "zod";

export const DisclosureContactSchema = z.object({
  email: z.string().email(),
  pgpKeyId: z.string().min(8).optional(),
  pgpKeyUrl: z.string().url().optional(),
  preferredLanguages: z.array(z.string().min(2).max(8)).min(1).default(["en"]),
});
export type DisclosureContact = z.infer<typeof DisclosureContactSchema>;

export const SupportedVersionSchema = z.object({
  version: z.string().regex(/^\d+(?:\.(?:\d+|x))(?:\.(?:\d+|x))?$/),
  supported: z.boolean(),
  supportEndsAt: z.string().datetime({ offset: true }).optional(),
});
export type SupportedVersion = z.infer<typeof SupportedVersionSchema>;

export const DisclosurePolicySchema = z.object({
  contact: DisclosureContactSchema,
  defaultDisclosureTimelineDays: z.number().int().min(7).max(365).default(90),
  bugBountyProgram: z
    .object({
      kind: z.enum(["none", "private_engagement", "public"]),
      url: z.string().url().optional(),
    })
    .default({ kind: "none" }),
  supportedVersions: z.array(SupportedVersionSchema).default([]),
  safeHarborStatement: z.string().min(1).optional(),
});
export type DisclosurePolicy = z.infer<typeof DisclosurePolicySchema>;

export function emitSecurityMd(policy: DisclosurePolicy): string {
  const lines: string[] = [];
  lines.push("# Security Policy");
  lines.push("");
  lines.push("## Reporting a Vulnerability");
  lines.push("");
  lines.push(`Email: ${policy.contact.email}`);
  if (policy.contact.pgpKeyId !== undefined) {
    lines.push(`PGP key id: ${policy.contact.pgpKeyId}`);
  }
  if (policy.contact.pgpKeyUrl !== undefined) {
    lines.push(`PGP key: ${policy.contact.pgpKeyUrl}`);
  }
  lines.push(`Preferred languages: ${policy.contact.preferredLanguages.join(", ")}`);
  lines.push("");
  lines.push("## Disclosure Timeline");
  lines.push("");
  lines.push(
    `Default coordinated-disclosure timeline: ${policy.defaultDisclosureTimelineDays} days.`,
  );
  lines.push("");
  lines.push("## Bug Bounty");
  lines.push("");
  switch (policy.bugBountyProgram.kind) {
    case "none":
      lines.push("No public bug bounty program at this time.");
      break;
    case "private_engagement":
      lines.push("Private engagement available; contact the security email above.");
      break;
    case "public":
      lines.push(
        `Public program: ${policy.bugBountyProgram.url ?? "see contact email for details"}`,
      );
      break;
  }
  if (policy.safeHarborStatement !== undefined) {
    lines.push("");
    lines.push("## Safe Harbor");
    lines.push("");
    lines.push(policy.safeHarborStatement);
  }
  if (policy.supportedVersions.length > 0) {
    lines.push("");
    lines.push("## Supported Versions");
    lines.push("");
    lines.push("| Version | Supported |");
    lines.push("|---|---|");
    for (const v of policy.supportedVersions) {
      lines.push(`| ${v.version} | ${v.supported ? "Yes" : "No"} |`);
    }
  }
  return lines.join("\n");
}
