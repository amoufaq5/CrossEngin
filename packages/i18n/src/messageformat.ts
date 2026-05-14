import { z } from "zod";

export const ICU_VAR_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const ICU_FORMAT_KINDS = [
  "simple",
  "plural",
  "selectordinal",
  "select",
  "number",
  "date",
  "time",
] as const;
export type IcuFormatKind = (typeof ICU_FORMAT_KINDS)[number];

export interface IcuPlaceholder {
  readonly name: string;
  readonly kind: IcuFormatKind;
  readonly cases?: readonly string[];
}

const CASE_LABEL_REGEX = /^(=\d+|zero|one|two|few|many|other)$/;

function findMatchingClose(text: string, openIdx: number): number {
  let depth = 1;
  let j = openIdx + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  throw new Error("unbalanced '{' in ICU message");
}

function splitTopLevel(text: string, sep: string, max: number): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === sep && depth === 0 && parts.length < max - 1) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function extractCaseLabels(body: string): readonly string[] {
  const cases: string[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i] ?? "")) i++;
    if (i >= body.length) break;
    let labelEnd = i;
    while (
      labelEnd < body.length &&
      body[labelEnd] !== "{" &&
      !/\s/.test(body[labelEnd] ?? "")
    ) {
      labelEnd++;
    }
    const label = body.slice(i, labelEnd);
    if (label.length === 0) {
      i++;
      continue;
    }
    while (labelEnd < body.length && /\s/.test(body[labelEnd] ?? "")) labelEnd++;
    if (body[labelEnd] !== "{") {
      i = labelEnd + 1;
      continue;
    }
    const close = findMatchingClose(body, labelEnd);
    if (CASE_LABEL_REGEX.test(label)) {
      cases.push(label);
    }
    i = close + 1;
  }
  return cases;
}

export function parsePlaceholders(message: string): readonly IcuPlaceholder[] {
  const placeholders: IcuPlaceholder[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < message.length) {
    if (message[i] !== "{") {
      i++;
      continue;
    }
    const close = findMatchingClose(message, i);
    const inner = message.slice(i + 1, close);
    const parts = splitTopLevel(inner, ",", 3);
    const name = (parts[0] ?? "").trim();
    const kindRaw = (parts[1] ?? "").trim();
    const body = parts[2] ?? "";
    let kind: IcuFormatKind = "simple";
    if (kindRaw.length > 0) {
      if (!(ICU_FORMAT_KINDS as readonly string[]).includes(kindRaw)) {
        throw new Error(`unknown ICU format kind '${kindRaw}' in '${message.slice(i, close + 1)}'`);
      }
      kind = kindRaw as IcuFormatKind;
    }
    let cases: readonly string[] | undefined;
    if ((kind === "plural" || kind === "selectordinal" || kind === "select") && body.length > 0) {
      cases = extractCaseLabels(body);
    }
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      placeholders.push(cases !== undefined ? { name, kind, cases } : { name, kind });
    }
    i = close + 1;
  }
  return placeholders;
}

export function placeholderNames(message: string): readonly string[] {
  return parsePlaceholders(message).map((p) => p.name);
}

const PLURAL_CASES_REQUIRED: ReadonlySet<string> = new Set(["other"]);

export function validateIcuMessage(message: string): void {
  let depth = 0;
  for (const ch of message) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) {
        throw new Error("unbalanced '}' in ICU message");
      }
      depth--;
    }
  }
  if (depth !== 0) {
    throw new Error("unbalanced '{' in ICU message");
  }
  const placeholders = parsePlaceholders(message);
  for (const ph of placeholders) {
    if (!ICU_VAR_NAME_REGEX.test(ph.name)) {
      throw new Error(`invalid ICU placeholder name '${ph.name}'`);
    }
    if (ph.kind === "plural" || ph.kind === "selectordinal") {
      if (ph.cases === undefined || ph.cases.length === 0) {
        throw new Error(`'${ph.name}, ${ph.kind}, ...' must declare at least one case`);
      }
      for (const required of PLURAL_CASES_REQUIRED) {
        if (!ph.cases.includes(required)) {
          throw new Error(
            `'${ph.name}, ${ph.kind}, ...' is missing the required 'other' case`,
          );
        }
      }
    }
  }
}

export const IcuMessageSchema = z.string().superRefine((message, ctx) => {
  try {
    validateIcuMessage(message);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : "invalid ICU message",
    });
  }
});
export type IcuMessage = z.infer<typeof IcuMessageSchema>;

export interface PlaceholderConsistencyIssue {
  readonly locale: string;
  readonly key: string;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

export function checkPlaceholderConsistency(
  reference: string,
  candidate: string,
): { readonly missing: readonly string[]; readonly extra: readonly string[] } {
  const refNames = new Set(placeholderNames(reference));
  const candNames = new Set(placeholderNames(candidate));
  const missing: string[] = [];
  const extra: string[] = [];
  for (const n of refNames) {
    if (!candNames.has(n)) missing.push(n);
  }
  for (const n of candNames) {
    if (!refNames.has(n)) extra.push(n);
  }
  return { missing, extra };
}
