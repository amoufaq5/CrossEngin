import { z } from "zod";
import { HardRefusalSchema, type HardRefusal } from "./refusals.js";

const PLACEHOLDER_REGEX = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
const TEMPLATE_ID_REGEX = /^[a-z][a-z0-9_]*$/;

export const RefusalTemplateSchema = z
  .object({
    id: z.string().regex(TEMPLATE_ID_REGEX, {
      message: "template id must be snake_case",
    }),
    refusal: HardRefusalSchema,
    locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
    title: z.string().min(1),
    body: z.string().min(1),
    citation: z.string().min(1),
    alternativeTemplate: z.string().min(1).optional(),
    reviewedBy: z.string().min(1).optional(),
    reviewedAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((v, ctx) => {
    const bodyParams = extractPlaceholders(v.body);
    const titleParams = extractPlaceholders(v.title);
    for (const p of [...bodyParams, ...titleParams]) {
      if (!ALLOWED_PLACEHOLDERS.has(p)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body"],
          message: `placeholder '{${p}}' is not in the allowlist`,
        });
        return;
      }
    }
  });
export type RefusalTemplate = z.infer<typeof RefusalTemplateSchema>;

export const ALLOWED_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "tenantName",
  "userName",
  "entityName",
  "packId",
  "fieldName",
  "retentionYears",
  "citation",
  "scope",
  "providerName",
  "alternativePath",
]);

export function extractPlaceholders(message: string): readonly string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(PLACEHOLDER_REGEX)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return Array.from(names);
}

export interface FormatInput {
  readonly template: RefusalTemplate;
  readonly params: Readonly<Record<string, string>>;
}

export function formatRefusalMessage(input: FormatInput): {
  readonly title: string;
  readonly body: string;
} {
  const required = new Set([
    ...extractPlaceholders(input.template.title),
    ...extractPlaceholders(input.template.body),
  ]);
  for (const name of required) {
    if (!(name in input.params)) {
      throw new Error(`refusal template '${input.template.id}' missing required placeholder '${name}'`);
    }
  }
  return {
    title: substitute(input.template.title, input.params),
    body: substitute(input.template.body, input.params),
  };
}

function substitute(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER_REGEX, (_match, name: string) => params[name] ?? "");
}

export const TemplateRegistrySchema = z
  .array(RefusalTemplateSchema)
  .superRefine((entries, ctx) => {
    const ids = new Set<string>();
    const byRefusalLocale = new Map<string, number>();
    entries.forEach((t, i) => {
      if (ids.has(t.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate template id '${t.id}'`,
        });
      }
      ids.add(t.id);
      const key = `${t.refusal}|${t.locale}`;
      const prior = byRefusalLocale.get(key);
      if (prior !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `refusal '${t.refusal}' already has a template for locale '${t.locale}' (templates[${prior}])`,
        });
      }
      byRefusalLocale.set(key, i);
    });
  });
export type TemplateRegistry = z.infer<typeof TemplateRegistrySchema>;

export function findTemplate(
  registry: TemplateRegistry,
  refusal: HardRefusal,
  locale: string,
  fallbackLocale = "en",
): RefusalTemplate | null {
  const exact = registry.find((t) => t.refusal === refusal && t.locale === locale);
  if (exact !== undefined) return exact;
  const fallback = registry.find((t) => t.refusal === refusal && t.locale === fallbackLocale);
  return fallback ?? null;
}
