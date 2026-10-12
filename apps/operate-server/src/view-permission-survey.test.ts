import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import { BUILTIN_PACK_NAMES, loadBuiltinPack } from "./manifest-source.js";
import {
  formatViewPermissionSurvey,
  OVERRIDING_VIEW_LIMIT,
  surveyViewPermissionOverrides,
  VIEW_PERMISSION_MAY_SERVE,
  VIEW_PERMISSION_VERDICTS,
  viewPermissionsAreSuspect,
  type ViewPermissionVerdict,
} from "./view-permission-survey.js";

/**
 * Views are built as plain objects and cast, because `@crossengin/views` is not a dependency of
 * this app (`abac-obligations.test.ts` records the same constraint) so `ListViewSchema` is not
 * available to parse them. The cast is honest here: the survey reads exactly two fields of a view,
 * `permissions` and `entity`, and every case below sets both deliberately.
 */
function manifest(views: Record<string, unknown> | undefined): Manifest {
  return {
    manifestVersion: "1.0",
    meta: { name: "Fixture", slug: "fixture/views", version: "1.0.0" },
    ...(views === undefined ? {} : { views }),
  } as unknown as Manifest;
}

function listView(entity: string, permissions: unknown): Record<string, unknown> {
  return {
    kind: "list",
    entity,
    columns: [{ field: "name", label: { en: "Name" } }],
    pageSize: 50,
    ...(permissions === undefined ? {} : { permissions }),
  };
}

const INHERIT = manifest({
  patient_list: listView("Patient", "inherit"),
  encounter_list: listView("Encounter", "inherit"),
});

const ONE_OVERRIDE = manifest({
  patient_list: listView("Patient", { roles: ["clinician", "nurse"] }),
  encounter_list: listView("Encounter", "inherit"),
});

const lineFor = (m: Manifest): string =>
  formatViewPermissionSurvey(surveyViewPermissionOverrides(m));

describe("VIEW_PERMISSION_VERDICTS and VIEW_PERMISSION_MAY_SERVE", () => {
  it("is the exact verdict set, so a fourth member is a visible change", () => {
    expect([...VIEW_PERMISSION_VERDICTS]).toEqual([
      "no_views",
      "all_inherit",
      "overrides_unenforced",
    ]);
  });

  it("permits a boot on every verdict: this survey reports and never refuses", () => {
    expect(VIEW_PERMISSION_MAY_SERVE).toEqual({
      no_views: true,
      all_inherit: true,
      overrides_unenforced: true,
    });
  });

  it("has a map entry for every verdict and no entry for anything else", () => {
    expect(Object.keys(VIEW_PERMISSION_MAY_SERVE).sort()).toEqual([...VIEW_PERMISSION_VERDICTS].sort());
  });

  /**
   * The brief's rule: do not invent a verdict with no member. Each of the three is produced here by
   * a manifest a deployment could really hold, so the set is exactly as large as the facts are.
   */
  it("gives every verdict a reachable producer", () => {
    const produced = new Set<ViewPermissionVerdict>([
      surveyViewPermissionOverrides(manifest(undefined)).verdict,
      surveyViewPermissionOverrides(INHERIT).verdict,
      surveyViewPermissionOverrides(ONE_OVERRIDE).verdict,
    ]);
    expect([...produced].sort()).toEqual([...VIEW_PERMISSION_VERDICTS].sort());
  });
});

describe("surveyViewPermissionOverrides — verdicts", () => {
  it("answers no_views for a manifest with no views section", () => {
    expect(surveyViewPermissionOverrides(manifest(undefined))).toEqual({
      verdict: "no_views",
      viewCount: 0,
      inheritCount: 0,
      overrides: [],
      mayServe: true,
    });
  });

  it("answers no_views for an empty views record, which is the same fact", () => {
    expect(surveyViewPermissionOverrides(manifest({})).verdict).toBe("no_views");
  });

  it("answers all_inherit when every view inherits", () => {
    expect(surveyViewPermissionOverrides(INHERIT)).toEqual({
      verdict: "all_inherit",
      viewCount: 2,
      inheritCount: 2,
      overrides: [],
      mayServe: true,
    });
  });

  // A one-view manifest is an ordinary authored one — a tenant's first activated manifest is likely
  // to have exactly one — and "none of 1 views" on a boot line that argues for care about
  // declarations reads as carelessness about them.
  it("says 'view' and not 'views' for a single-view manifest", () => {
    const one = manifest({ patient_list: listView("Patient", "inherit") });
    expect(lineFor(one)).toContain("none of 1 view —");
    expect(lineFor(one)).not.toContain("1 views");
  });

  it("answers overrides_unenforced on the first override, and names it", () => {
    expect(surveyViewPermissionOverrides(ONE_OVERRIDE)).toEqual({
      verdict: "overrides_unenforced",
      viewCount: 2,
      inheritCount: 1,
      overrides: [{ view: "patient_list", entity: "Patient", roles: ["clinician", "nurse"] }],
      mayServe: true,
    });
  });

  it("counts several overrides and keeps declaration order", () => {
    const survey = surveyViewPermissionOverrides(
      manifest({
        a_list: listView("A", { roles: ["r1"] }),
        b_list: listView("B", "inherit"),
        c_list: listView("C", { roles: ["r2", "r3"] }),
      }),
    );
    expect(survey.overrides).toEqual([
      { view: "a_list", entity: "A", roles: ["r1"] },
      { view: "c_list", entity: "C", roles: ["r2", "r3"] },
    ]);
    expect(survey.viewCount).toBe(3);
    expect(survey.inheritCount).toBe(1);
  });

  it("carries mayServe straight off the map rather than restating it", () => {
    for (const m of [manifest(undefined), INHERIT, ONE_OVERRIDE]) {
      const survey = surveyViewPermissionOverrides(m);
      expect(survey.mayServe).toBe(VIEW_PERMISSION_MAY_SERVE[survey.verdict]);
    }
  });

  it("keeps inheritCount and overrides consistent with viewCount on every fixture", () => {
    for (const m of [manifest(undefined), manifest({}), INHERIT, ONE_OVERRIDE]) {
      const survey = surveyViewPermissionOverrides(m);
      expect(survey.inheritCount + survey.overrides.length).toBe(survey.viewCount);
    }
  });
});

describe("surveyViewPermissionOverrides — reading the declaration", () => {
  it("treats an absent permissions key as inheriting, as an unparsed manifest has one", () => {
    const survey = surveyViewPermissionOverrides(manifest({ a_list: listView("A", undefined) }));
    expect(survey.verdict).toBe("all_inherit");
    expect(survey.overrides).toEqual([]);
  });

  it("reports an override whose roles key is missing, with an empty role list", () => {
    // A hand-built override, which `validateManifest` runs over too. It is still a declaration the
    // serving path ignores, so it is named — reporting is the direction a surprise should fall in.
    const survey = surveyViewPermissionOverrides(manifest({ a_list: listView("A", {}) }));
    expect(survey.overrides).toEqual([{ view: "a_list", entity: "A", roles: [] }]);
    expect(survey.verdict).toBe("overrides_unenforced");
  });

  it("does not alias the declared role array, so a caller cannot mutate the manifest through it", () => {
    const roles = ["clinician"];
    const survey = surveyViewPermissionOverrides(
      manifest({ a_list: listView("A", { roles }) }),
    );
    const reported = survey.overrides[0]?.roles as string[];
    reported.push("intruder");
    expect(roles).toEqual(["clinician"]);
  });

  it("reads the view's own entity and not the view key", () => {
    const survey = surveyViewPermissionOverrides(
      manifest({ a_list: listView("Patient", { roles: ["r1"] }) }),
    );
    expect(survey.overrides[0]).toEqual({ view: "a_list", entity: "Patient", roles: ["r1"] });
  });

  it("surveys every view kind, not only list views", () => {
    // `listConfigForEntity` reads only the first `list` view per entity, so a record view's
    // override is doubly inert — but it is still a declaration, and this survey is about the
    // declaration rather than about which reader would have ignored it.
    const survey = surveyViewPermissionOverrides(
      manifest({
        record_view: { kind: "record", entity: "A", permissions: { roles: ["r1"] }, sections: [] },
        kanban_view: { kind: "kanban", entity: "B", permissions: "inherit" },
      }),
    );
    expect(survey.viewCount).toBe(2);
    expect(survey.overrides).toEqual([{ view: "record_view", entity: "A", roles: ["r1"] }]);
  });

  it("is deterministic and depends on nothing but the manifest", () => {
    expect(surveyViewPermissionOverrides(ONE_OVERRIDE)).toEqual(
      surveyViewPermissionOverrides(ONE_OVERRIDE),
    );
    // One parameter, so there is no store or store kind the answer could turn on.
    expect(surveyViewPermissionOverrides.length).toBe(1);
  });
});

describe("viewPermissionsAreSuspect", () => {
  it("is false when there are no views", () => {
    expect(viewPermissionsAreSuspect(surveyViewPermissionOverrides(manifest(undefined)))).toBe(false);
  });

  it("is false when every view inherits", () => {
    expect(viewPermissionsAreSuspect(surveyViewPermissionOverrides(INHERIT))).toBe(false);
  });

  it("is true as soon as one view overrides", () => {
    expect(viewPermissionsAreSuspect(surveyViewPermissionOverrides(ONE_OVERRIDE))).toBe(true);
  });

  it("agrees with the verdict on every fixture, so the log level and the verdict cannot disagree", () => {
    for (const m of [manifest(undefined), manifest({}), INHERIT, ONE_OVERRIDE]) {
      const survey = surveyViewPermissionOverrides(m);
      expect(viewPermissionsAreSuspect(survey)).toBe(survey.verdict === "overrides_unenforced");
    }
  });
});

describe("formatViewPermissionSurvey", () => {
  it("says the no-views case exactly, and on one line", () => {
    expect(lineFor(manifest(undefined))).toBe(
      "[views] view permission overrides: none, because this manifest declares no view — so there" +
        " is no override to be ignored",
    );
  });

  it("says the clean case exactly, affirmatively, with the count", () => {
    expect(lineFor(INHERIT)).toBe(
      "[views] view permission overrides: none of 2 views — every one inherits its entity's" +
        " permissions, which is what the serving path reads",
    );
  });

  it("distinguishes no views from views that all inherit", () => {
    expect(lineFor(manifest(undefined))).not.toBe(lineFor(INHERIT));
  });

  it("leads with the count on the headline case", () => {
    expect(lineFor(ONE_OVERRIDE).split("\n")[0]).toBe(
      "[views] view permission overrides: 1 of 2 views declare one, and nothing reads it",
    );
  });

  it("renders the whole headline report line for line", () => {
    expect(lineFor(ONE_OVERRIDE).split("\n")).toEqual([
      "[views] view permission overrides: 1 of 2 views declare one, and nothing reads it",
      "  patient_list on Patient grants clinician, nurse",
      "  listConfigForEntity is the only serve-time reader of manifest.views and takes columns," +
        " sort and pageSize; UiSchema carries no view at all. So each view above is served per its" +
        " entity's own grants in manifest.permissions, which is strictly wider than it declares" +
        " wherever the two differ",
      "  remedy: express the restriction in manifest.permissions, where it is read, and drop the" +
        " view's override so the manifest says what is true; no flag enforces one",
    ]);
  });

  /**
   * The clause order is what carries the meaning: the count, then which views, then why it is
   * ignored, then the remedy. An ordered regex pins that without pinning every word, so a reworded
   * sentence stays green and a reordered report does not.
   */
  it("orders the clauses count → views → reason → remedy", () => {
    expect(lineFor(ONE_OVERRIDE)).toMatch(
      /^\[views\][^\n]*1 of 2 views[\s\S]*patient_list on Patient grants[\s\S]*only serve-time reader[\s\S]*strictly wider[\s\S]*remedy:/,
    );
  });

  it("names every overriding view up to the limit, with no summary", () => {
    const views: Record<string, unknown> = {};
    for (let i = 0; i < OVERRIDING_VIEW_LIMIT; i += 1) {
      views[`v${String(i)}_list`] = listView(`E${String(i)}`, { roles: ["r1"] });
    }
    const line = lineFor(manifest(views));
    for (let i = 0; i < OVERRIDING_VIEW_LIMIT; i += 1) {
      expect(line).toContain(`v${String(i)}_list on E${String(i)} grants r1`);
    }
    expect(line).not.toContain("more)");
  });

  it("summarises past the limit and keeps the count exact", () => {
    const views: Record<string, unknown> = {};
    for (let i = 0; i < OVERRIDING_VIEW_LIMIT + 3; i += 1) {
      views[`v${String(i)}_list`] = listView(`E${String(i)}`, { roles: ["r1"] });
    }
    const line = lineFor(manifest(views));
    expect(line.split("\n")[0]).toBe(
      `[views] view permission overrides: ${String(OVERRIDING_VIEW_LIMIT + 3)} of ${String(
        OVERRIDING_VIEW_LIMIT + 3,
      )} views declare one, and nothing reads it`,
    );
    expect(line).toContain("  (+3 more)");
    expect(line).not.toContain(`v${String(OVERRIDING_VIEW_LIMIT)}_list on`);
  });

  it("renders a multi-role override as a comma list", () => {
    expect(lineFor(manifest({ a_list: listView("A", { roles: ["x", "y", "z"] }) }))).toContain(
      "  a_list on A grants x, y, z",
    );
  });
});

describe("the shipped packs", () => {
  /**
   * The vacuity control, in the shape `abac-obligations.test.ts` uses: a zero that comes from an
   * empty walk is not a measurement. Every resolved pack is surveyed and every one must have views
   * — so `all_inherit` is reached over a real, large view set rather than over an absence.
   */
  it("declares zero view permission overrides across all seven resolved packs today", async () => {
    let totalViews = 0;
    for (const name of BUILTIN_PACK_NAMES) {
      const survey = surveyViewPermissionOverrides(await loadBuiltinPack(name));
      expect(survey.overrides).toEqual([]);
      expect(survey.verdict).toBe("all_inherit");
      // Non-empty on every pack, which is what makes the zero above a finding.
      expect(survey.viewCount).toBeGreaterThan(0);
      expect(survey.inheritCount).toBe(survey.viewCount);
      totalViews += survey.viewCount;
    }
    expect(BUILTIN_PACK_NAMES).toHaveLength(7);
    // 132 as measured on the resolved lineages. Pinned so a pack that starts declaring an override
    // moves this figure rather than slipping past the assertions above.
    expect(totalViews).toBe(132);
  });

  it("prints the affirmative line for the shipped compose default", async () => {
    const line = lineFor(await loadBuiltinPack("erp-core"));
    expect(line).toMatch(/^\[views\] view permission overrides: none of \d+ views — every one inherits/);
    expect(viewPermissionsAreSuspect(surveyViewPermissionOverrides(await loadBuiltinPack("erp-core")))).toBe(
      false,
    );
  });

  /**
   * The survey would see an override if a pack grew one: the same resolved pack with one view's
   * `permissions` replaced is reported. Proves the clean result above is the manifest's answer and
   * not the survey failing to look.
   */
  it("reports an override injected into a real resolved pack", async () => {
    const core = await loadBuiltinPack("erp-core");
    const views = { ...(core.views ?? {}) } as Record<string, unknown>;
    const firstKey = Object.keys(views)[0] ?? "";
    const first = views[firstKey] as { readonly entity: string };
    views[firstKey] = { ...first, permissions: { roles: ["erp_admin"] } };
    const survey = surveyViewPermissionOverrides({ ...core, views } as unknown as Manifest);
    expect(survey.verdict).toBe("overrides_unenforced");
    expect(survey.overrides).toEqual([
      { view: firstKey, entity: first.entity, roles: ["erp_admin"] },
    ]);
    expect(survey.inheritCount).toBe(survey.viewCount - 1);
  });
});
