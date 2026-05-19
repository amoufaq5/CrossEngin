import { describe, expect, it } from "vitest";

import {
  OPENAI_DEFAULT_MODERATION_MODEL,
  OPENAI_MODERATION_CATEGORY_KEYS,
  OPENAI_MODERATION_MODELS,
  buildModerationRequest,
  highestCategoryScore,
  isOpenAIModerationModel,
  normalizeModerationResponse,
  type OpenAIModerationCategories,
  type OpenAIModerationCategoryScores,
  type OpenAIModerationResponse,
  type OpenAIModerationResult,
} from "./moderations-api.js";

function categoriesAll(value: boolean): OpenAIModerationCategories {
  return Object.fromEntries(
    OPENAI_MODERATION_CATEGORY_KEYS.map((k) => [k, value]),
  ) as OpenAIModerationCategories;
}

function scoresAll(value: number): OpenAIModerationCategoryScores {
  return Object.fromEntries(
    OPENAI_MODERATION_CATEGORY_KEYS.map((k) => [k, value]),
  ) as OpenAIModerationCategoryScores;
}

describe("OPENAI_MODERATION_MODELS", () => {
  it("includes omni-moderation-latest as the default", () => {
    expect(OPENAI_MODERATION_MODELS).toContain("omni-moderation-latest");
    expect(OPENAI_DEFAULT_MODERATION_MODEL).toBe("omni-moderation-latest");
  });

  it("includes legacy text-moderation models for backwards compat", () => {
    expect(OPENAI_MODERATION_MODELS).toContain("text-moderation-latest");
    expect(OPENAI_MODERATION_MODELS).toContain("text-moderation-stable");
  });

  it("has at least 4 models today", () => {
    expect(OPENAI_MODERATION_MODELS.length).toBeGreaterThanOrEqual(4);
  });
});

describe("OPENAI_MODERATION_CATEGORY_KEYS", () => {
  it("covers the 11 documented OpenAI categories", () => {
    expect(OPENAI_MODERATION_CATEGORY_KEYS).toHaveLength(11);
    expect(OPENAI_MODERATION_CATEGORY_KEYS).toContain("sexual");
    expect(OPENAI_MODERATION_CATEGORY_KEYS).toContain("hate");
    expect(OPENAI_MODERATION_CATEGORY_KEYS).toContain("harassment");
    expect(OPENAI_MODERATION_CATEGORY_KEYS).toContain("self-harm");
    expect(OPENAI_MODERATION_CATEGORY_KEYS).toContain("violence");
  });
});

describe("isOpenAIModerationModel", () => {
  it("returns true for each known model", () => {
    for (const m of OPENAI_MODERATION_MODELS) {
      expect(isOpenAIModerationModel(m)).toBe(true);
    }
  });

  it("returns false for unknown models", () => {
    expect(isOpenAIModerationModel("gpt-4o")).toBe(false);
    expect(isOpenAIModerationModel("claude-sonnet-4-6")).toBe(false);
    expect(isOpenAIModerationModel("")).toBe(false);
  });
});

describe("buildModerationRequest", () => {
  it("accepts a string input", () => {
    const built = buildModerationRequest({
      input: "is this OK?",
      defaultModel: OPENAI_DEFAULT_MODERATION_MODEL,
    });
    expect(built.input).toBe("is this OK?");
    expect(built.model).toBe(OPENAI_DEFAULT_MODERATION_MODEL);
  });

  it("accepts an array of strings", () => {
    const built = buildModerationRequest({
      input: ["one", "two", "three"],
      defaultModel: OPENAI_DEFAULT_MODERATION_MODEL,
    });
    expect(built.input).toEqual(["one", "two", "three"]);
  });

  it("uses the explicit model when provided", () => {
    const built = buildModerationRequest({
      input: "x",
      model: "text-moderation-stable",
      defaultModel: OPENAI_DEFAULT_MODERATION_MODEL,
    });
    expect(built.model).toBe("text-moderation-stable");
  });

  it("rejects an empty string", () => {
    expect(() =>
      buildModerationRequest({
        input: "",
        defaultModel: OPENAI_DEFAULT_MODERATION_MODEL,
      }),
    ).toThrow(/empty/);
  });

  it("rejects an empty array", () => {
    expect(() =>
      buildModerationRequest({
        input: [],
        defaultModel: OPENAI_DEFAULT_MODERATION_MODEL,
      }),
    ).toThrow(/empty/);
  });

  it("rejects an array containing an empty string", () => {
    expect(() =>
      buildModerationRequest({
        input: ["valid", ""],
        defaultModel: OPENAI_DEFAULT_MODERATION_MODEL,
      }),
    ).toThrow(/empty/);
  });
});

describe("normalizeModerationResponse", () => {
  function fixtureResponse(
    results: readonly OpenAIModerationResult[],
  ): OpenAIModerationResponse {
    return {
      id: "modr_1",
      model: "omni-moderation-latest",
      results,
    };
  }

  it("returns anyFlagged=false when no results are flagged", () => {
    const normalized = normalizeModerationResponse(
      fixtureResponse([
        {
          flagged: false,
          categories: categoriesAll(false),
          category_scores: scoresAll(0.001),
        },
      ]),
    );
    expect(normalized.anyFlagged).toBe(false);
    expect(normalized.flaggedCategoriesPerResult[0]).toEqual([]);
  });

  it("returns anyFlagged=true if ANY result is flagged", () => {
    const cats = categoriesAll(false);
    cats.hate = true;
    const normalized = normalizeModerationResponse(
      fixtureResponse([
        {
          flagged: true,
          categories: cats,
          category_scores: scoresAll(0.5),
        },
      ]),
    );
    expect(normalized.anyFlagged).toBe(true);
    expect(normalized.flaggedCategoriesPerResult[0]).toEqual(["hate"]);
  });

  it("lists multiple flagged categories per result in tuple order", () => {
    const cats = categoriesAll(false);
    cats.violence = true;
    cats.harassment = true;
    const normalized = normalizeModerationResponse(
      fixtureResponse([
        {
          flagged: true,
          categories: cats,
          category_scores: scoresAll(0.5),
        },
      ]),
    );
    expect(normalized.flaggedCategoriesPerResult[0]).toEqual([
      "harassment",
      "violence",
    ]);
  });

  it("aggregates across multiple results", () => {
    const cats1 = categoriesAll(false);
    cats1.sexual = true;
    const cats2 = categoriesAll(false);
    const normalized = normalizeModerationResponse(
      fixtureResponse([
        { flagged: true, categories: cats1, category_scores: scoresAll(0.5) },
        { flagged: false, categories: cats2, category_scores: scoresAll(0.001) },
      ]),
    );
    expect(normalized.results).toHaveLength(2);
    expect(normalized.anyFlagged).toBe(true);
    expect(normalized.flaggedCategoriesPerResult).toEqual([["sexual"], []]);
  });

  it("passes the response model through unchanged", () => {
    const normalized = normalizeModerationResponse({
      id: "modr_2",
      model: "text-moderation-latest",
      results: [],
    });
    expect(normalized.model).toBe("text-moderation-latest");
  });
});

describe("highestCategoryScore", () => {
  it("returns the category with the highest score", () => {
    const scores = scoresAll(0);
    scores.hate = 0.7;
    scores.violence = 0.3;
    const result: OpenAIModerationResult = {
      flagged: true,
      categories: categoriesAll(true),
      category_scores: scores,
    };
    const top = highestCategoryScore(result);
    expect(top).toEqual({ category: "hate", score: 0.7 });
  });

  it("returns the first category at tied scores (deterministic via tuple order)", () => {
    const scores = scoresAll(0);
    scores.hate = 0.5;
    scores.violence = 0.5;
    const result: OpenAIModerationResult = {
      flagged: true,
      categories: categoriesAll(true),
      category_scores: scores,
    };
    const top = highestCategoryScore(result);
    expect(top?.category).toBe("hate");
  });

  it("returns null when no category has a numeric score", () => {
    const result: OpenAIModerationResult = {
      flagged: false,
      categories: categoriesAll(false),
      category_scores: {} as OpenAIModerationCategoryScores,
    };
    const top = highestCategoryScore(result);
    expect(top).toBeNull();
  });
});
