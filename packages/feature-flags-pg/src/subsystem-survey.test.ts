import { describe, expect, it } from "vitest";

import { EVALUATION_REASONS, FLAG_EVALUATION_REASON_PRODUCERS } from "@crossengin/feature-flags";

import {
  CALLERLESS_FLAG_STORES,
  CALLERLESS_STORE_REASONS,
  EXPORTED_STORE_SYMBOLS,
  FLAG_SUBSYSTEM_DEFECTS,
  KILL_SWITCH_ENFORCEMENT_GAP,
  surveyFlagSubsystem,
  type CallerlessStoreReason,
  type FlagSubsystemDefect,
} from "./subsystem-survey.js";

describe("CALLERLESS_STORE_REASONS", () => {
  it("has the two reasons and no more", () => {
    expect(CALLERLESS_STORE_REASONS).toEqual(["no_consumer_exists", "awaiting_authoring_grant"]);
  });

  it("is exhaustively mapped by a total switch", () => {
    const describeReason = (r: CallerlessStoreReason): string => {
      switch (r) {
        case "no_consumer_exists":
          return "nothing consumes what the store returns";
        case "awaiting_authoring_grant":
          return "the write is config-grade and wants four-eyes";
      }
    };
    for (const r of CALLERLESS_STORE_REASONS) {
      expect(describeReason(r).length).toBeGreaterThan(0);
    }
  });
});

describe("CALLERLESS_FLAG_STORES", () => {
  it("declares exactly the two stores nothing constructs", () => {
    expect(CALLERLESS_FLAG_STORES.map((d) => d.symbol)).toEqual([
      "PostgresFeatureFlagStore",
      "PostgresTargetingRuleStore",
    ]);
  });

  /**
   * The forcing function. A declaration naming a symbol this package does not export is the failure
   * mode of every hand-maintained list here, so the list is compared against the real exports
   * rather than trusted.
   */
  it("names only symbols this package really exports", () => {
    for (const decl of CALLERLESS_FLAG_STORES) {
      expect(Object.keys(EXPORTED_STORE_SYMBOLS)).toContain(decl.symbol);
      expect(typeof EXPORTED_STORE_SYMBOLS[decl.symbol]).toBe("function");
    }
  });

  it("does not declare the kill-switch store, which is constructed", () => {
    expect(CALLERLESS_FLAG_STORES.map((d) => d.symbol)).not.toContain("PostgresKillSwitchStore");
    expect(Object.keys(EXPORTED_STORE_SYMBOLS)).toContain("PostgresKillSwitchStore");
  });

  it("covers every exported store either as callerless or as constructed", () => {
    const callerless = new Set(CALLERLESS_FLAG_STORES.map((d) => d.symbol));
    const constructed = new Set(["PostgresKillSwitchStore"]);
    for (const symbol of Object.keys(EXPORTED_STORE_SYMBOLS)) {
      expect(callerless.has(symbol) || constructed.has(symbol)).toBe(true);
    }
    expect(callerless.size + constructed.size).toBe(Object.keys(EXPORTED_STORE_SYMBOLS).length);
  });

  it("gives every declaration a module, a reason, a consequence and a note", () => {
    const reasons: ReadonlySet<string> = new Set(CALLERLESS_STORE_REASONS);
    for (const decl of CALLERLESS_FLAG_STORES) {
      expect(decl.module).toMatch(/^[a-z-]+\.ts$/);
      expect(reasons.has(decl.reason)).toBe(true);
      expect(decl.consequence.length).toBeGreaterThan(40);
      expect(decl.note.length).toBeGreaterThan(40);
    }
  });

  it("records that ADR-0300 built a store and did not claim a caller", () => {
    const flagStore = CALLERLESS_FLAG_STORES.find(
      (d) => d.symbol === "PostgresFeatureFlagStore",
    );
    expect(flagStore?.note).toContain("never claimed to wire it");
  });

  it("is frozen in both the list and its entries", () => {
    expect(Object.isFrozen(CALLERLESS_FLAG_STORES)).toBe(true);
    for (const decl of CALLERLESS_FLAG_STORES) expect(Object.isFrozen(decl)).toBe(true);
  });
});

describe("KILL_SWITCH_ENFORCEMENT_GAP", () => {
  it("records that a kill switch is written and never applied", () => {
    expect(KILL_SWITCH_ENFORCEMENT_GAP.recorded).toBe(true);
    expect(KILL_SWITCH_ENFORCEMENT_GAP.enforced).toBe(false);
    expect(KILL_SWITCH_ENFORCEMENT_GAP.enforcedBy).toBeNull();
  });

  it("names the two engines that do write one", () => {
    expect(KILL_SWITCH_ENFORCEMENT_GAP.recordedBy).toContain("buildPersistentEngine");
    expect(KILL_SWITCH_ENFORCEMENT_GAP.recordedBy).toContain("buildPersistentLatencyEngine");
  });
});

describe("surveyFlagSubsystem", () => {
  it("reports all three defects today", () => {
    const survey = surveyFlagSubsystem();
    expect(survey.findings.map((f) => f.defect)).toEqual([...FLAG_SUBSYSTEM_DEFECTS]);
    expect(survey.evaluable).toBe(false);
  });

  it("derives no_evaluator from the contracts map rather than restating it", () => {
    const survey = surveyFlagSubsystem();
    const finding = survey.findings.find((f) => f.defect === "no_evaluator");
    expect(finding?.detail).toContain(String(EVALUATION_REASONS.length));
    expect(
      EVALUATION_REASONS.every((r) => FLAG_EVALUATION_REASON_PRODUCERS[r] === "none"),
    ).toBe(true);
  });

  it("carries the callerless declaration on the survey", () => {
    expect(surveyFlagSubsystem().callerless).toBe(CALLERLESS_FLAG_STORES);
  });

  it("gives every finding a non-empty detail", () => {
    for (const f of surveyFlagSubsystem().findings) {
      expect(f.detail.length).toBeGreaterThan(20);
    }
  });

  it("returns a frozen survey", () => {
    const survey = surveyFlagSubsystem();
    expect(Object.isFrozen(survey)).toBe(true);
    expect(Object.isFrozen(survey.findings)).toBe(true);
  });

  it("exhaustively maps every defect kind", () => {
    const grade = (d: FlagSubsystemDefect): "disease" | "symptom" => {
      switch (d) {
        case "no_evaluator":
          return "disease";
        case "no_flag_source":
        case "kill_switch_unenforced":
          return "symptom";
      }
    };
    expect(FLAG_SUBSYSTEM_DEFECTS.map(grade)).toEqual(["disease", "symptom", "symptom"]);
  });
});
