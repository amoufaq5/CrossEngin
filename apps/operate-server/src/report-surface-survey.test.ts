import type { RoleName } from "@crossengin/auth";
import type { Manifest } from "@crossengin/kernel/manifest";
import { compileOperateServer, InMemoryEntityStore, type ReportSurface } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { BUILTIN_PACK_NAMES, loadBuiltinPack } from "./manifest-source.js";
import { formatReportSurfaceSurvey, surveyReportSurfaces } from "./report-surface-survey.js";

function surfacesOf(manifest: Manifest, financeRoles?: readonly RoleName[]): readonly ReportSurface[] {
  return compileOperateServer(manifest, {
    store: new InMemoryEntityStore(),
    principalRoles: () => ({ primaryRole: "erp_admin" }),
    ...(financeRoles !== undefined ? { financeRoles } : {}),
  }).reportSurfaces;
}

describe("surveyReportSurfaces — over the shipped erp-core", () => {
  it("names both reports, every entity each reads, and the four roles each admits", async () => {
    const core = await loadBuiltinPack("erp-core");
    const survey = surveyReportSurfaces(surfacesOf(core), core);
    expect(survey.reports.map((r) => [r.operationId, r.reads, r.admittedRoles])).toEqual([
      ["meta.aging.read", ["Invoice", "Bill", "Payment"], ["ap_clerk", "controller", "erp_accountant", "erp_admin"]],
      [
        "meta.whtReconciliation.read",
        ["Invoice", "WhtCertificate"],
        ["ap_clerk", "controller", "erp_accountant", "erp_admin"],
      ],
    ]);
    expect(survey.reports.every((r) => r.undeclaredRoles.length === 0)).toBe(true);
  });

  it("counts the disagreement in both units: 5 per-report triples over 3 distinct pairs", async () => {
    // Bill and Payment are on FIN_READERS, which carries controller and ap_clerk; Invoice is on the
    // pack's original three-role set; WhtCertificate is on TAX_READERS, which carries no ap_clerk.
    const core = await loadBuiltinPack("erp-core");
    const survey = surveyReportSurfaces(surfacesOf(core), core);
    expect(survey.reports.map((r) => r.listGaps.map((g) => `${g.role}→${g.entity}`))).toEqual([
      ["ap_clerk→Invoice", "controller→Invoice"],
      ["ap_clerk→Invoice", "controller→Invoice", "ap_clerk→WhtCertificate"],
    ]);
    expect(survey.gapCount).toBe(5);
    expect(survey.distinctGapPairs).toBe(3);
  });

  it("finds a gap only where the real grant refuses list — erp_admin and erp_accountant have none", async () => {
    // The non-vacuity half: a survey that reported every admitted role would also report these two.
    const core = await loadBuiltinPack("erp-core");
    const gaps = surveyReportSurfaces(surfacesOf(core), core).reports.flatMap((r) => r.listGaps);
    expect(gaps.some((g) => g.role === "erp_admin" || g.role === "erp_accountant")).toBe(false);
  });

  it("is the same on every resolved pack, which is what makes it a standing line", async () => {
    for (const name of BUILTIN_PACK_NAMES) {
      const m = await loadBuiltinPack(name);
      const survey = surveyReportSurfaces(surfacesOf(m), m);
      expect([survey.reports.length, survey.gapCount, survey.distinctGapPairs]).toEqual([2, 5, 3]);
    }
  });
});

describe("surveyReportSurfaces — what it reads and refuses to re-derive", () => {
  it("reports the roles the handler was built with, including ones the manifest does not declare", async () => {
    const core = await loadBuiltinPack("erp-core");
    const survey = surveyReportSurfaces(surfacesOf(core, ["platform_admin", "erp_admin"]), core);
    for (const r of survey.reports) {
      expect(r.admittedRoles).toEqual(["erp_admin", "platform_admin"]);
      expect(r.undeclaredRoles).toEqual(["platform_admin"]);
    }
  });

  it("follows role inheritance through the real rbacCheck rather than reading grant lists", () => {
    const manifest = {
      manifestVersion: "1.0",
      meta: { name: "m", version: "1.0.0" },
      entities: [],
      roles: { child: { inherits: ["parent"] }, parent: {} },
      permissions: { Invoice: { list: { roles: ["parent"] } } },
    } as unknown as Manifest;
    const surfaces: readonly ReportSurface[] = [
      { operationId: "r", reads: ["Invoice"], viewerRoles: new Set(["child", "stranger"]) },
    ];
    const survey = surveyReportSurfaces(surfaces, manifest);
    expect(survey.reports[0]?.listGaps).toEqual([{ role: "stranger", entity: "Invoice" }]);
    expect(survey.reports[0]?.undeclaredRoles).toEqual(["stranger"]);
  });

  it("does not count a pair rbacCheck could not answer as a gap", () => {
    const manifest = {
      manifestVersion: "1.0",
      meta: { name: "m", version: "1.0.0" },
      entities: [],
      roles: { a: { inherits: ["b"] }, b: { inherits: ["a"] } },
      permissions: { Invoice: { list: { roles: ["a"] } } },
    } as unknown as Manifest;
    const survey = surveyReportSurfaces(
      [{ operationId: "r", reads: ["Invoice"], viewerRoles: new Set(["a"]) }],
      manifest,
    );
    expect(survey.gapCount).toBe(0);
    expect(survey.reports[0]?.unanswered).toEqual([{ role: "a", entity: "Invoice" }]);
  });
});

describe("formatReportSurfaceSurvey", () => {
  it("says it when nothing is mounted, rather than going quiet", () => {
    const line = formatReportSurfaceSurvey({ reports: [], gapCount: 0, distinctGapPairs: 0 });
    expect(line).toContain("server-side reports mounted: 0");
  });

  it("names both vocabularies, both units and every gap, with no remedy and no verdict on which is wrong", async () => {
    const core = await loadBuiltinPack("erp-core");
    const block = formatReportSurfaceSurvey(surveyReportSurfaces(surfacesOf(core), core));
    const lines = block.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.startsWith("[reports] "))).toBe(true);
    expect(lines[0]).toContain("role list fixed when this server was compiled");
    expect(lines[0]).toContain("per-entity grants");
    expect(lines[0]).toContain("5 (report, role, entity) over 3 distinct (role, entity) pair(s)");
    expect(lines[2]).toContain("ap_clerk→WhtCertificate");
    expect(block).not.toMatch(/--[a-z]|bypass|should|must|remedy/i);
  });

  it("says agreement when there is no gap", () => {
    const line = formatReportSurfaceSurvey({
      reports: [
        {
          operationId: "meta.aging.read",
          reads: ["Invoice"],
          admittedRoles: ["erp_admin"],
          undeclaredRoles: [],
          listGaps: [],
          unanswered: [],
        },
      ],
      gapCount: 0,
      distinctGapPairs: 0,
    });
    expect(line).toContain("0 (report, role, entity) over 0 distinct");
    expect(line).toContain("every admitted role may also list every entity it reads");
  });
});
