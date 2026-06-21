import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  addDaysIso,
  applySettingsDefaults,
  planHasSettingsDefaults,
  settingsDefaultPlan,
} from "./settings-defaults.js";

const INVOICE: Entity = {
  name: "Invoice",
  traits: ["auditable"],
  fields: [
    { name: "issue_date", type: { kind: "date" }, required: true },
    { name: "due_date", type: { kind: "date" }, required: true },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true },
    { name: "total", type: { kind: "decimal", precision: 14, scale: 2 }, required: true },
  ],
};

const NOTE: Entity = {
  name: "Note",
  traits: ["auditable"],
  fields: [{ name: "body", type: { kind: "long_text" } }],
};

describe("settingsDefaultPlan", () => {
  it("detects currency, due-date, and the base date field", () => {
    const plan = settingsDefaultPlan(INVOICE);
    expect(plan.currencyFields).toEqual(["currency"]);
    expect(plan.dueDateField).toBe("due_date");
    expect(plan.baseDateField).toBe("issue_date");
    expect(planHasSettingsDefaults(plan)).toBe(true);
  });

  it("is empty for an entity with no currency or due date", () => {
    expect(planHasSettingsDefaults(settingsDefaultPlan(NOTE))).toBe(false);
  });
});

describe("addDaysIso", () => {
  it("adds days across a month boundary (UTC-safe)", () => {
    expect(addDaysIso("2026-01-20", 30)).toBe("2026-02-19");
    expect(addDaysIso("2026-12-25", 10)).toBe("2027-01-04");
  });
});

describe("applySettingsDefaults", () => {
  const plan = settingsDefaultPlan(INVOICE);

  it("fills currency from defaults and due_date from payment terms", () => {
    const out = applySettingsDefaults(
      { issue_date: "2026-03-01", total: 100 },
      plan,
      { defaults: { currency: "AED" }, finance: { defaultPaymentTermsDays: 30 } },
    );
    expect(out.currency).toBe("AED");
    expect(out.due_date).toBe("2026-03-31");
  });

  it("never overrides caller-supplied currency or due_date", () => {
    const out = applySettingsDefaults(
      { issue_date: "2026-03-01", currency: "EUR", due_date: "2026-04-15" },
      plan,
      { defaults: { currency: "AED" }, finance: { defaultPaymentTermsDays: 30 } },
    );
    expect(out.currency).toBe("EUR");
    expect(out.due_date).toBe("2026-04-15");
  });

  it("falls back to `now` when no base date is present", () => {
    const out = applySettingsDefaults(
      { currency: "USD" },
      plan,
      { finance: { defaultPaymentTermsDays: 14 } },
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(out.due_date).toBe("2026-06-15");
  });

  it("does nothing without relevant settings", () => {
    const rec = { issue_date: "2026-03-01" };
    expect(applySettingsDefaults(rec, plan, {})).toEqual(rec);
  });
});
