import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import { formatManifestSectionSurvey, surveyManifestSections } from "./manifest-section-survey.js";
import { BUILTIN_PACK_NAMES, loadBuiltinPack } from "./manifest-source.js";

describe("surveyManifestSections", () => {
  it("names all eight unserved sections from the kernel's map, not three hand-picked ones", async () => {
    const survey = surveyManifestSections(await loadBuiltinPack("erp-core"));
    // A literal on purpose: comparing the survey against the same map it reads would pass whatever
    // the map said. This is the measured reach as committed.
    expect(survey.unservedSections).toEqual([
      "integrations",
      "files",
      "reports",
      "dashboards",
      "customWidgets",
      "theme",
      "i18n",
      "search",
    ]);
  });

  it("does not read a present-and-empty section as a declaration, which every extending pack carries", async () => {
    // A resolved extending pack carries five of them as own keys holding `undefined`; key presence
    // would report five unserved declarations there, all false. An authored `{}` is checked too.
    const retail = await loadBuiltinPack("erp-retail");
    expect("reports" in retail).toBe(true);
    expect(retail.reports).toBeUndefined();
    expect(surveyManifestSections({ ...retail, reports: {}, theme: {} } as unknown as Manifest).declared).toEqual([]);
    for (const name of BUILTIN_PACK_NAMES) {
      expect(surveyManifestSections(await loadBuiltinPack(name)).declared).toEqual([]);
    }
  });

  it("finds a declared unserved section, with its member count (positive control)", async () => {
    const core = await loadBuiltinPack("erp-core");
    const declaring = {
      ...core,
      reports: { r1: { kind: "tabular" }, r2: { kind: "kpi" } },
      theme: { primaryColor: "#000000" },
    } as unknown as Manifest;
    expect(surveyManifestSections(declaring).declared).toEqual([
      { section: "reports", reach: "validated_only", members: 2 },
      { section: "theme", reach: "unread", members: 1 },
    ]);
  });

  it("never counts a served section, however much it declares", async () => {
    const core = await loadBuiltinPack("erp-core");
    expect((core.entities ?? []).length).toBeGreaterThan(0);
    expect(surveyManifestSections(core).declared.some((d) => d.section === "entities")).toBe(false);
  });
});

describe("formatManifestSectionSurvey", () => {
  it("says the census when nothing unserved is declared", async () => {
    const line = formatManifestSectionSurvey(surveyManifestSections(await loadBuiltinPack("erp-core")));
    expect(line).toBe(
      "[manifest] 8 of 17 manifest sections are read by no request path in this binary" +
        " (validated_only: integrations, files, reports, dashboards, search; unread: customWidgets," +
        " theme, i18n) — this manifest declares a member in none of them",
    );
  });

  it("names each declared one with the kernel's own sentence for its reach", async () => {
    const core = await loadBuiltinPack("erp-core");
    const line = formatManifestSectionSurvey(
      surveyManifestSections({ ...core, reports: { r1: { kind: "tabular" } } } as unknown as Manifest),
    );
    expect(line).toContain("this manifest declares 1 of them: reports (1 member(s)): validated for coherence;");
    expect(line.includes("\n")).toBe(false);
  });
});
