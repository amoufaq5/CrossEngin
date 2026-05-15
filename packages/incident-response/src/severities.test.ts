import { describe, expect, it } from "vitest";
import {
  SEVERITIES,
  SEVERITY_PROFILES,
  SeverityProfileSchema,
  ackDeadlineFor,
  mitigateDeadlineFor,
  profileFor,
  requiresPostmortem,
} from "./severities.js";

describe("constants", () => {
  it("SEVERITIES has 5 entries", () => {
    expect(SEVERITIES).toEqual(["sev1", "sev2", "sev3", "sev4", "sev5"]);
  });

  it("SEVERITY_PROFILES covers every severity", () => {
    for (const s of SEVERITIES) {
      expect(SEVERITY_PROFILES[s]).toBeDefined();
    }
  });

  it("sev1 pages on-call and requires postmortem", () => {
    expect(SEVERITY_PROFILES.sev1.pageOnCall).toBe(true);
    expect(SEVERITY_PROFILES.sev1.postmortemRequired).toBe(true);
  });

  it("sev5 doesn't page on-call", () => {
    expect(SEVERITY_PROFILES.sev5.pageOnCall).toBe(false);
  });

  it("ack < mitigate < resolve for every severity", () => {
    for (const s of SEVERITIES) {
      const p = SEVERITY_PROFILES[s];
      expect(p.ackMinutes).toBeLessThan(p.mitigateMinutes);
      expect(p.mitigateMinutes).toBeLessThan(p.resolveMinutes);
    }
  });
});

describe("SeverityProfileSchema", () => {
  it("accepts the default sev1 profile", () => {
    expect(() => SeverityProfileSchema.parse(SEVERITY_PROFILES.sev1)).not.toThrow();
  });

  it("rejects mitigate <= ack", () => {
    expect(() =>
      SeverityProfileSchema.parse({
        ...SEVERITY_PROFILES.sev1,
        mitigateMinutes: 1,
      }),
    ).toThrow(/mitigateMinutes must be greater/);
  });

  it("rejects sev1 with pageOnCall=false", () => {
    expect(() =>
      SeverityProfileSchema.parse({
        ...SEVERITY_PROFILES.sev1,
        pageOnCall: false,
      }),
    ).toThrow(/sev1 must page on-call/);
  });

  it("rejects sev1 with postmortemRequired=false", () => {
    expect(() =>
      SeverityProfileSchema.parse({
        ...SEVERITY_PROFILES.sev1,
        postmortemRequired: false,
      }),
    ).toThrow(/sev1 must require a postmortem/);
  });
});

describe("helpers", () => {
  it("profileFor returns the canonical profile", () => {
    expect(profileFor("sev2").id).toBe("sev2");
  });

  it("requiresPostmortem true for sev1+sev2", () => {
    expect(requiresPostmortem("sev1")).toBe(true);
    expect(requiresPostmortem("sev2")).toBe(true);
    expect(requiresPostmortem("sev3")).toBe(false);
  });

  it("ackDeadlineFor adds ackMinutes", () => {
    const declared = new Date("2026-05-14T10:00:00Z");
    const deadline = ackDeadlineFor("sev1", declared);
    expect(deadline.getTime() - declared.getTime()).toBe(5 * 60_000);
  });

  it("mitigateDeadlineFor adds mitigateMinutes", () => {
    const declared = new Date("2026-05-14T10:00:00Z");
    const deadline = mitigateDeadlineFor("sev1", declared);
    expect(deadline.getTime() - declared.getTime()).toBe(60 * 60_000);
  });
});
