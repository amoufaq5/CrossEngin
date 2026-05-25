import { describe, expect, it } from "vitest";
import {
  exactCaseFor,
  isCompleteForLocale,
  missingPluralCases,
  pluralCategoriesFor,
  pluralCategory,
  PLURAL_CATEGORIES,
} from "./plurals.js";

describe("PLURAL_CATEGORIES", () => {
  it("includes the six CLDR categories", () => {
    expect(PLURAL_CATEGORIES).toEqual(["zero", "one", "two", "few", "many", "other"]);
  });
});

describe("pluralCategoriesFor", () => {
  it("English uses one + other", () => {
    expect(pluralCategoriesFor("en")).toEqual(["one", "other"]);
  });

  it("Arabic uses six categories", () => {
    expect(pluralCategoriesFor("ar")).toEqual(["zero", "one", "two", "few", "many", "other"]);
  });

  it("Chinese uses only other", () => {
    expect(pluralCategoriesFor("zh")).toEqual(["other"]);
  });

  it("falls back to [one, other] for unknown languages", () => {
    expect(pluralCategoriesFor("zz" as never)).toEqual(["one", "other"]);
  });
});

describe("pluralCategory", () => {
  it("English 1 → one, English 0/2/many → other", () => {
    expect(pluralCategory("en", 1)).toBe("one");
    expect(pluralCategory("en", 0)).toBe("other");
    expect(pluralCategory("en", 2)).toBe("other");
    expect(pluralCategory("en", 17)).toBe("other");
  });

  it("Arabic 0 → zero, 1 → one, 2 → two", () => {
    expect(pluralCategory("ar", 0)).toBe("zero");
    expect(pluralCategory("ar", 1)).toBe("one");
    expect(pluralCategory("ar", 2)).toBe("two");
  });
});

describe("isCompleteForLocale / missingPluralCases", () => {
  it("English is complete with one + other", () => {
    expect(isCompleteForLocale("en", ["one", "other"])).toBe(true);
  });

  it("Arabic needs all six", () => {
    expect(isCompleteForLocale("ar", ["zero", "one", "two", "few", "many", "other"])).toBe(true);
    expect(isCompleteForLocale("ar", ["one", "other"])).toBe(false);
    expect([...missingPluralCases("ar", ["one", "other"])].sort()).toEqual([
      "few",
      "many",
      "two",
      "zero",
    ]);
  });

  it("=N cases don't count toward category coverage", () => {
    expect(isCompleteForLocale("en", ["=0", "=1"])).toBe(false);
    expect(isCompleteForLocale("en", ["=0", "one", "other"])).toBe(true);
  });
});

describe("exactCaseFor", () => {
  it("produces =N templates", () => {
    expect(exactCaseFor(0)).toBe("=0");
    expect(exactCaseFor(7)).toBe("=7");
  });
});
