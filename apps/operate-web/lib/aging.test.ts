import { describe, expect, it } from "vitest";

import {
  AGING_AS_OF_REFUSALS,
  AGING_AS_OF_REFUSAL_MEANING,
  agingAsOfRefusal,
  earliestAgingAsOf,
} from "./aging";

describe("aging asOf refusals (ADR-0475's 400s, rendered by ADR-0478)", () => {
  it("gives each refusal code its own sentence", () => {
    for (const code of AGING_AS_OF_REFUSALS) {
      expect(agingAsOfRefusal({ status: 400, code })).toBe(AGING_AS_OF_REFUSAL_MEANING[code]);
    }
    expect(AGING_AS_OF_REFUSAL_MEANING.as_of_not_served).toContain("today or a later date");
    expect(AGING_AS_OF_REFUSAL_MEANING.as_of_malformed).not.toBe(AGING_AS_OF_REFUSAL_MEANING.as_of_not_served);
  });

  it("answers null for any other failure, so the page's other arms still run", () => {
    expect(agingAsOfRefusal({ status: 403, code: "as_of_not_served" })).toBeNull();
    expect(agingAsOfRefusal({ status: 400, code: "invalid_body" })).toBeNull();
    expect(agingAsOfRefusal({ status: 400 })).toBeNull();
    expect(agingAsOfRefusal(new Error("x"))).toBeNull();
    expect(agingAsOfRefusal(null)).toBeNull();
  });
});

describe("earliestAgingAsOf", () => {
  const now = new Date("2026-11-25T23:30:00.000Z");

  it("takes the server's own date when it has reported one", () => {
    expect(earliestAgingAsOf("2026-11-26", now)).toBe("2026-11-26");
  });

  it("falls back to this browser's clock read in UTC, never local time", () => {
    expect(earliestAgingAsOf(null, now)).toBe("2026-11-25");
    expect(earliestAgingAsOf("not a date", now)).toBe("2026-11-25");
  });
});
