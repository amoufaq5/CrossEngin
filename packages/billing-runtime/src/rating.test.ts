import { describe, expect, it } from "vitest";

import { rateMeter, subscriptionBaseLine, usageOverageLine } from "./rating.js";
import { basePlan, period } from "./test-fixtures.js";

describe("rateMeter", () => {
  it("bills only the units above the included quota", () => {
    // basePlan includes 500 ai_calls; 700 used ⇒ 200 billable @ 8¢ = 1600¢.
    const rated = rateMeter(basePlan, "ai_call", 700);
    expect(rated.overage.includedUnits).toBe(500);
    expect(rated.overage.billableUnits).toBe(200);
    expect(rated.overage.overageCents).toBe(1600);
  });

  it("bills nothing within the included quota", () => {
    const rated = rateMeter(basePlan, "ai_call", 300);
    expect(rated.overage.billableUnits).toBe(0);
    expect(rated.overage.overageCents).toBe(0);
  });
});

describe("usageOverageLine", () => {
  it("emits a usage_overage line for billable overage", () => {
    const line = usageOverageLine({ plan: basePlan, meter: "ai_call", usedUnits: 700, period, id: "00000000-0000-4000-8000-000000000001" });
    expect(line).not.toBeNull();
    expect(line?.kind).toBe("usage_overage");
    expect(line?.quantity).toBe(200);
    expect(line?.unitAmountCents).toBe(8);
    expect(line?.amountCents).toBe(1600);
    expect(line?.meter).toBe("ai_call");
  });

  it("returns null when usage is within quota", () => {
    expect(
      usageOverageLine({ plan: basePlan, meter: "ai_call", usedUnits: 100, period, id: "00000000-0000-4000-8000-000000000002" }),
    ).toBeNull();
  });
});

describe("subscriptionBaseLine", () => {
  it("emits the flat base fee line", () => {
    const line = subscriptionBaseLine({ plan: basePlan, period, id: "00000000-0000-4000-8000-000000000003" });
    expect(line?.kind).toBe("subscription_base");
    expect(line?.amountCents).toBe(19900);
  });

  it("returns null for a zero base fee", () => {
    expect(
      subscriptionBaseLine({ plan: { ...basePlan, basePriceCents: 0 }, period, id: "00000000-0000-4000-8000-000000000004" }),
    ).toBeNull();
  });
});
