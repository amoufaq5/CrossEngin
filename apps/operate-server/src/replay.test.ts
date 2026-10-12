import { describe, expect, it } from "vitest";

import {
  REPLAY_SCOPE_SUPPORT,
  REPLAY_SUBSYSTEMS,
  SCOPE_NONE,
  SCOPE_TENANT_ONLY,
  SCOPE_TENANT_OR_PLATFORM,
  formatReplayReport,
  runReplaySections,
  scopeRefusal,
  subsystemsServedBy,
  summarizeReplay,
  type ReplayCoverage,
  type ReplaySection,
  type ReplaySubsystem,
} from "./replay.js";
import type { PgConnection } from "@crossengin/kernel-pg";

const TENANT: ReplayCoverage = { kind: "tenant", tenantId: "11111111-1111-1111-1111-111111111111" };
const PLATFORM: ReplayCoverage = { kind: "platform" };
const UNSCOPED: ReplayCoverage = { kind: "unscoped" };

// Never called: every runner in these tests is a stub, so the sweep never issues SQL.
const conn = {} as unknown as PgConnection;

const section = (over: Partial<ReplaySection> = {}): ReplaySection => ({
  subsystem: "dr",
  coverage: TENANT,
  complete: true,
  scanned: 3,
  refusal: null,
  findings: [],
  ...over,
});

describe("REPLAY_SCOPE_SUPPORT", () => {
  it("is total over REPLAY_SUBSYSTEMS, so a seventh subsystem is a compile error", () => {
    expect(Object.keys(REPLAY_SCOPE_SUPPORT).sort()).toEqual([...REPLAY_SUBSYSTEMS].sort());
  });

  it("names the three arms the catalog actually serves", () => {
    // Measured from pg_policy on a fresh cluster, not chosen: isolation-only tables cannot serve
    // a cross-scope read at all, split tables serve the platform's rows to a non-owner, and
    // meta.incidents has no tenant_id and no RLS.
    expect(REPLAY_SCOPE_SUPPORT.access_reviews).toBe(SCOPE_TENANT_ONLY);
    expect(REPLAY_SCOPE_SUPPORT.workflow).toBe(SCOPE_TENANT_ONLY);
    expect(REPLAY_SCOPE_SUPPORT.dr).toBe(SCOPE_TENANT_OR_PLATFORM);
    expect(REPLAY_SCOPE_SUPPORT.slo).toBe(SCOPE_TENANT_OR_PLATFORM);
    expect(REPLAY_SCOPE_SUPPORT.gateway).toBe(SCOPE_TENANT_OR_PLATFORM);
    expect(REPLAY_SCOPE_SUPPORT.incidents).toBe(SCOPE_NONE);
  });

  it("uses every arm, so none of the three is vacuous", () => {
    const arms = new Set(Object.values(REPLAY_SCOPE_SUPPORT));
    expect(arms).toEqual(new Set([SCOPE_TENANT_ONLY, SCOPE_TENANT_OR_PLATFORM, SCOPE_NONE]));
  });
});

describe("scopeRefusal", () => {
  it("refuses an isolation-only subsystem without a tenant, and says why", () => {
    const r = scopeRefusal("access_reviews", PLATFORM);
    expect(r).toContain("requires --tenant");
    expect(r).toContain("zero rows");
    expect(scopeRefusal("access_reviews", UNSCOPED)).toContain("requires --tenant");
    expect(scopeRefusal("access_reviews", TENANT)).toBeNull();
  });

  it("refuses an unscoped read of a split subsystem rather than treating it as a sweep", () => {
    // The measured reason: 1 of 7 rows as a non-owner, 7 of 7 as the owner. A diagnostic, not a
    // sweep, so it must not be reachable by omitting a flag.
    const r = scopeRefusal("gateway", UNSCOPED);
    expect(r).toContain("1 of 7");
    expect(scopeRefusal("gateway", TENANT)).toBeNull();
    expect(scopeRefusal("gateway", PLATFORM)).toBeNull();
  });

  it("rejects a scope on a subsystem that has none, rather than ignoring it", () => {
    expect(scopeRefusal("incidents", UNSCOPED)).toBeNull();
    expect(scopeRefusal("incidents", TENANT)).toContain("no tenant_id column");
    expect(scopeRefusal("incidents", PLATFORM)).toContain("cannot be applied");
  });
});

describe("subsystemsServedBy", () => {
  it("serves everything but incidents under a tenant", () => {
    expect([...subsystemsServedBy(TENANT)].sort()).toEqual(
      ["access_reviews", "dr", "gateway", "slo", "workflow"].sort(),
    );
  });

  it("serves only the split subsystems under --platform", () => {
    expect([...subsystemsServedBy(PLATFORM)].sort()).toEqual(["dr", "gateway", "slo"].sort());
  });

  it("serves only incidents unscoped", () => {
    expect(subsystemsServedBy(UNSCOPED)).toEqual(["incidents"]);
  });
});

describe("runReplaySections", () => {
  const ok = (findings: readonly string[], scanned = 2, complete = true) => ({
    run: async () => ({ complete, scanned, refusal: null, findings }),
  });

  it("refuses per subsystem rather than per invocation", async () => {
    // A mixed selection is the normal case: the servable half must still be read.
    const sections = await runReplaySections(
      conn,
      PLATFORM,
      ["dr", "access_reviews"],
      { dr: ok(["dr-1"]), access_reviews: ok([]) },
      10,
    );
    expect(sections.map((s) => s.subsystem)).toEqual(["dr", "access_reviews"]);
    expect(sections[0]?.findings).toEqual(["dr-1"]);
    expect(sections[1]?.refusal).toContain("requires --tenant");
  });

  it("does not call a runner it has refused", async () => {
    let called = false;
    await runReplaySections(
      conn,
      PLATFORM,
      ["access_reviews"],
      { access_reviews: { run: async () => { called = true; return { complete: true, scanned: 0, refusal: null, findings: [] }; } } },
      10,
    );
    expect(called).toBe(false);
  });

  it("reports a missing runner instead of silently skipping the subsystem", async () => {
    const [s] = await runReplaySections(conn, TENANT, ["workflow"], {}, 10);
    expect(s?.refusal).toContain("no runner wired");
  });

  it("reports a throwing runner and keeps sweeping the rest", async () => {
    const sections = await runReplaySections(
      conn,
      TENANT,
      ["dr", "slo"],
      {
        dr: { run: () => Promise.reject(new Error("relation does not exist")) },
        slo: ok(["slo-1"]),
      },
      10,
    );
    expect(sections[0]?.refusal).toContain("relation does not exist");
    expect(sections[1]?.findings).toEqual(["slo-1"]);
  });

  it("carries the coverage onto every section, so a tenant loop's findings stay attributable", async () => {
    const sections = await runReplaySections(conn, TENANT, ["dr"], { dr: ok(["x"]) }, 10);
    expect(sections[0]?.coverage).toEqual(TENANT);
  });
});

describe("summarizeReplay", () => {
  it("is ok only when every section was readable and found nothing", () => {
    expect(summarizeReplay([section(), section({ subsystem: "slo" })]).ok).toBe(true);
    expect(summarizeReplay([section({ findings: ["drift"] })]).ok).toBe(false);
  });

  it("is NOT ok for a refused section with zero findings", () => {
    // The whole point: "0 findings" from a section that could not be read must not exit 0, or a
    // maintenance job launders an unread subsystem into a pass.
    expect(summarizeReplay([section({ refusal: "requires --tenant", scanned: 0 })]).ok).toBe(false);
  });

  it("is ok over no sections at all, since nothing was asked", () => {
    expect(summarizeReplay([]).ok).toBe(true);
  });
});

describe("formatReplayReport", () => {
  it("says the window before the count, so a truncated pass cannot read as complete", () => {
    const out = formatReplayReport(summarizeReplay([section({ complete: false, scanned: 500 })]));
    expect(out).toContain("TRUNCATED at 500");
  });

  it("marks a refused section NOT READ rather than showing a zero", () => {
    const out = formatReplayReport(
      summarizeReplay([section({ refusal: "requires --tenant", scanned: 0 })]),
    );
    expect(out).toContain("NOT READ");
    expect(out).not.toContain("0 finding(s)");
  });

  it("names the tenant a section was read under", () => {
    const out = formatReplayReport(summarizeReplay([section()]));
    expect(out).toContain("tenant 11111111-1111-1111-1111-111111111111");
    expect(out).toContain("complete");
  });

  it("lists each finding under its subsystem", () => {
    const out = formatReplayReport(summarizeReplay([section({ findings: ["a", "b"] })]));
    expect(out).toContain("  - a");
    expect(out).toContain("  - b");
  });
});

describe("the subsystem list", () => {
  it("covers all six replayers that had no caller", () => {
    const expected: readonly ReplaySubsystem[] = [
      "dr", "slo", "access_reviews", "gateway", "incidents", "workflow",
    ];
    expect([...REPLAY_SUBSYSTEMS].sort()).toEqual([...expected].sort());
  });
});
