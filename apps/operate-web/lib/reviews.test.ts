import { describe, expect, it } from "vitest";

import { designedByLabel } from "./reviews";

describe("designedByLabel (ADR-0435 Q3, closed by ADR-0478)", () => {
  it("names the designer when the server sends one", () => {
    expect(designedByLabel({ designedBy: "8d3f…" })).toBe("8d3f…");
  });

  it("says the record holds none, which is a fact about the proposal", () => {
    expect(designedByLabel({ designedBy: null })).toBe("not recorded");
    expect(designedByLabel({ designedBy: "  " })).toBe("not recorded");
  });

  it("says nothing when the server does not send the field, which is a fact about the server", () => {
    expect(designedByLabel({})).toBeNull();
    expect(designedByLabel({ designedBy: undefined })).toBeNull();
  });
});
