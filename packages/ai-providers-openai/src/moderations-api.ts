export const OPENAI_MODERATION_MODELS = [
  "omni-moderation-latest",
  "omni-moderation-2024-09-26",
  "text-moderation-latest",
  "text-moderation-stable",
] as const;
export type OpenAIModerationModel = (typeof OPENAI_MODERATION_MODELS)[number];

export const OPENAI_DEFAULT_MODERATION_MODEL: OpenAIModerationModel =
  "omni-moderation-latest";

export function isOpenAIModerationModel(value: string): value is OpenAIModerationModel {
  return (OPENAI_MODERATION_MODELS as readonly string[]).includes(value);
}

export const OPENAI_MODERATION_CATEGORY_KEYS = [
  "sexual",
  "hate",
  "harassment",
  "self-harm",
  "sexual/minors",
  "hate/threatening",
  "violence/graphic",
  "self-harm/intent",
  "self-harm/instructions",
  "harassment/threatening",
  "violence",
] as const;
export type OpenAIModerationCategoryKey =
  (typeof OPENAI_MODERATION_CATEGORY_KEYS)[number];

export type OpenAIModerationCategories = Record<OpenAIModerationCategoryKey, boolean>;
export type OpenAIModerationCategoryScores = Record<OpenAIModerationCategoryKey, number>;

export interface OpenAIModerationResult {
  readonly flagged: boolean;
  readonly categories: OpenAIModerationCategories;
  readonly category_scores: OpenAIModerationCategoryScores;
  readonly category_applied_input_types?: Readonly<
    Partial<Record<OpenAIModerationCategoryKey, readonly string[]>>
  >;
}

export interface OpenAIModerationResponse {
  readonly id: string;
  readonly model: string;
  readonly results: readonly OpenAIModerationResult[];
}

export interface OpenAIModerationRequest {
  readonly model: string;
  readonly input: string | readonly string[];
}

export interface BuildModerationRequestInput {
  readonly input: string | readonly string[];
  readonly model?: string;
  readonly defaultModel: OpenAIModerationModel;
}

export function buildModerationRequest(
  input: BuildModerationRequestInput,
): OpenAIModerationRequest {
  if (typeof input.input === "string") {
    if (input.input.length === 0) {
      throw new Error("buildModerationRequest: input string is empty");
    }
  } else {
    if (input.input.length === 0) {
      throw new Error("buildModerationRequest: input array is empty");
    }
    for (const s of input.input) {
      if (typeof s !== "string" || s.length === 0) {
        throw new Error(
          "buildModerationRequest: input array contains an empty or non-string entry",
        );
      }
    }
  }
  return {
    model: input.model ?? input.defaultModel,
    input: input.input,
  };
}

export interface NormalizedModerationOutcome {
  readonly model: string;
  readonly anyFlagged: boolean;
  readonly results: readonly OpenAIModerationResult[];
  readonly flaggedCategoriesPerResult: ReadonlyArray<readonly OpenAIModerationCategoryKey[]>;
}

export function normalizeModerationResponse(
  response: OpenAIModerationResponse,
): NormalizedModerationOutcome {
  const flaggedPer: OpenAIModerationCategoryKey[][] = [];
  let any = false;
  for (const r of response.results) {
    if (r.flagged) any = true;
    const flaggedCats: OpenAIModerationCategoryKey[] = [];
    for (const k of OPENAI_MODERATION_CATEGORY_KEYS) {
      if (r.categories[k]) flaggedCats.push(k);
    }
    flaggedPer.push(flaggedCats);
  }
  return {
    model: response.model,
    anyFlagged: any,
    results: response.results,
    flaggedCategoriesPerResult: flaggedPer,
  };
}

export function highestCategoryScore(
  result: OpenAIModerationResult,
): { readonly category: OpenAIModerationCategoryKey; readonly score: number } | null {
  let best: { category: OpenAIModerationCategoryKey; score: number } | null = null;
  for (const k of OPENAI_MODERATION_CATEGORY_KEYS) {
    const s = result.category_scores[k];
    if (typeof s !== "number") continue;
    if (best === null || s > best.score) {
      best = { category: k, score: s };
    }
  }
  return best;
}
