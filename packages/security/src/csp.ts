import { z } from "zod";

export const CSP_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "connect-src",
  "font-src",
  "frame-src",
  "frame-ancestors",
  "form-action",
  "object-src",
  "media-src",
  "worker-src",
  "manifest-src",
  "base-uri",
  "report-uri",
  "report-to",
] as const;
export type CspDirective = (typeof CSP_DIRECTIVES)[number];

export const CSP_KEYWORDS = [
  "'self'",
  "'none'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'strict-dynamic'",
  "data:",
  "blob:",
  "https:",
] as const;

const CSP_NONCE_REGEX = /^'nonce-[A-Za-z0-9+/=_-]+'$/;
const CSP_HASH_REGEX = /^'sha(?:256|384|512)-[A-Za-z0-9+/=]+'$/;
const CSP_HOST_REGEX = /^(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/.*)?$/i;
const CSP_SCHEME_HOST_REGEX = /^https?:\/\/(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/.*)?$/i;

export const CspSourceSchema = z.string().refine(
  (v) => {
    return (
      (CSP_KEYWORDS as readonly string[]).includes(v) ||
      CSP_NONCE_REGEX.test(v) ||
      CSP_HASH_REGEX.test(v) ||
      CSP_HOST_REGEX.test(v) ||
      CSP_SCHEME_HOST_REGEX.test(v)
    );
  },
  { message: "invalid CSP source — must be a keyword, nonce, hash, or host expression" },
);

export const CspPolicySchema = z
  .object({
    directives: z.record(z.enum(CSP_DIRECTIVES), z.array(CspSourceSchema).min(1)),
    reportOnly: z.boolean().default(false),
    upgradeInsecureRequests: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (!("default-src" in v.directives) && !("script-src" in v.directives)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["directives"],
        message: "policy must declare at least default-src or script-src",
      });
    }
  });
export type CspPolicy = z.infer<typeof CspPolicySchema>;

export function emitCspHeader(policy: CspPolicy): string {
  const parts: string[] = [];
  for (const directive of CSP_DIRECTIVES) {
    const sources = policy.directives[directive];
    if (sources !== undefined && sources.length > 0) {
      parts.push(`${directive} ${sources.join(" ")}`);
    }
  }
  if (policy.upgradeInsecureRequests) {
    parts.push("upgrade-insecure-requests");
  }
  return parts.join("; ");
}

export function cspHeaderName(policy: CspPolicy): string {
  return policy.reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}
