import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PgConnection } from "@crossengin/kernel-pg";
import { evaluateEntitlement, LicenseEntitlementResolver, type EntitlementResolver } from "@crossengin/operate-runtime";
import { PostgresEntitlementResolver } from "@crossengin/operate-runtime-pg";
import { describe, expect, it } from "vitest";

import {
  ENTITLEMENT_GATE_SOURCES,
  ENTITLEMENT_SOURCE_GATES,
  entitlementGateSourceOf,
  formatEntitlementSurvey,
} from "./entitlement-survey.js";

const here = dirname(fileURLToPath(import.meta.url));

/** A connection no test here may use: constructing a resolver issues no SQL, and a query is a bug. */
const unusedConn: PgConnection = {
  query: () => {
    throw new Error("the survey must not query");
  },
  transaction: () => {
    throw new Error("the survey must not open a transaction");
  },
  close: async () => undefined,
} as unknown as PgConnection;

describe("entitlementGateSourceOf", () => {
  it("names the absence when no resolver is built", () => {
    expect(entitlementGateSourceOf(undefined)).toBe("none");
  });

  it("names the license resolver", () => {
    expect(entitlementGateSourceOf(new LicenseEntitlementResolver("x.y", "AAAA"))).toBe("license");
  });

  it("names the Stripe snapshot resolver", () => {
    expect(entitlementGateSourceOf(new PostgresEntitlementResolver(unusedConn))).toBe("stripe_snapshots");
  });

  it("calls an embedder's resolver custom rather than guessing which it imitates", () => {
    const custom: EntitlementResolver = { resolve: async () => ({ status: "active" }) };
    expect(entitlementGateSourceOf(custom)).toBe("custom");
  });
});

describe("formatEntitlementSurvey", () => {
  it("says the gate is off when nothing gates", () => {
    const line = formatEntitlementSurvey({ source: "none", stripeWebhookMounted: false });
    expect(line).toMatch(/^subscription gate: off/);
    expect(line).not.toContain("402");
  });

  it("says, under Stripe, that a tenant with no row is refused reads as well as writes", () => {
    const line = formatEntitlementSurvey({ source: "stripe_snapshots", stripeWebhookMounted: true });
    expect(line).toMatch(/^subscription gate: ON/);
    expect(line).toContain("meta.billing_subscriptions");
    expect(line).toContain("402 no_subscription");
    expect(line).toContain("reads included");
    expect(line).toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("states the read refusal because that is what the policy does, not only writes", () => {
    // The brief that opened this module said "refused writes"; the policy says otherwise, and a
    // boot line repeating the brief would have been the falsely-reassuring sentence this exists to
    // replace. Pinned against the policy itself so a change there reds here.
    expect(evaluateEntitlement(null, "read")).toEqual({ allowed: false, reason: "no_subscription" });
    expect(evaluateEntitlement(null, "write")).toEqual({ allowed: false, reason: "no_subscription" });
    expect(evaluateEntitlement({ status: "past_due" }, "read").allowed).toBe(true);
    expect(evaluateEntitlement({ status: "past_due" }, "write").allowed).toBe(false);
  });

  it("says under a license that the Stripe snapshots do not gate when both are configured", () => {
    const both = formatEntitlementSurvey({ source: "license", stripeWebhookMounted: true });
    expect(both).toContain("only the tenant the license names is admitted");
    expect(both).toContain("do not gate while a license does");
    const alone = formatEntitlementSurvey({ source: "license", stripeWebhookMounted: false });
    expect(alone).not.toContain("Stripe");
  });

  it("has a sentence for every source, and every gating source names the 402", () => {
    for (const source of ENTITLEMENT_GATE_SOURCES) {
      const line = formatEntitlementSurvey({ source, stripeWebhookMounted: false });
      expect(line.length).toBeGreaterThan(40);
      expect(line.includes("402")).toBe(ENTITLEMENT_SOURCE_GATES[source]);
    }
  });

  it("prints no key material for any source", () => {
    for (const source of ENTITLEMENT_GATE_SOURCES) {
      const line = formatEntitlementSurvey({ source, stripeWebhookMounted: true });
      expect(line).not.toMatch(/whsec_|sk_live|sk_test|[A-Za-z0-9+/]{40,}={0,2}/);
    }
  });
});

describe("the boot wiring", () => {
  it("prints the line off the live resolver after the Stripe resolver may have been built", () => {
    // Text fence (no type can ask it): the call must read `entitlementResolver` after the webhook
    // block that may assign it, or a Stripe-armed gate would be reported off.
    const node = readFileSync(resolve(here, "./node.ts"), "utf8");
    const call = node.indexOf("formatEntitlementSurvey(");
    expect(call, "node.ts no longer prints the entitlement survey").toBeGreaterThan(0);
    const assignment = node.indexOf("entitlementResolver = new PostgresEntitlementResolver(");
    expect(assignment).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(assignment);
    expect(node.slice(call, call + 400)).toContain("entitlementGateSourceOf(entitlementResolver)");
  });
});
