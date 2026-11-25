import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Manifest } from "@crossengin/kernel/manifest";
import { UNIQUE_INDEX_REFUSAL_CAUSES } from "@crossengin/operate-runtime-pg";
import { describe, expect, it } from "vitest";

import {
  formatUniqueEnforcementReport,
  surveyUniqueEnforcement,
  UNIQUE_ENFORCEMENT_REASONS,
} from "./unique-enforcement.js";
import {
  formatUniqueIndexRefusal,
  observedUniqueRefusal,
  UNIQUE_INDEX_REFUSAL_REASON,
  UNIQUE_INDEX_REFUSAL_SENTENCE,
} from "./unique-index-refusal.js";

const SQL = 'CREATE UNIQUE INDEX IF NOT EXISTS "item_code_uniq" ON "public"."item" ("tenant_id", "code")';

function line(cause: (typeof UNIQUE_INDEX_REFUSAL_CAUSES)[number], detail: string): string {
  return formatUniqueIndexRefusal("boot", { entity: "Item", field: "code", cause, detail, sql: SQL });
}

describe("a refused unique index names its cause, not always duplicates (ADR-0474)", () => {
  it("has a sentence and a survey reason for every cause the store can report", () => {
    expect(Object.keys(UNIQUE_INDEX_REFUSAL_SENTENCE).sort()).toEqual([...UNIQUE_INDEX_REFUSAL_CAUSES].sort());
    expect(Object.keys(UNIQUE_INDEX_REFUSAL_REASON).sort()).toEqual([...UNIQUE_INDEX_REFUSAL_CAUSES].sort());
    for (const reason of Object.values(UNIQUE_INDEX_REFUSAL_REASON)) {
      expect(Object.keys(UNIQUE_ENFORCEMENT_REASONS)).toContain(reason);
    }
  });

  it("tells an operator to deduplicate only when the rows refused the index", () => {
    const dup = line("duplicates", 'could not create unique index "item_code_uniq"');
    expect(dup).toContain("Item.code");
    expect(dup).toContain("(duplicates)");
    expect(dup).toMatch(/deduplicate/i);
    expect(dup).toContain(SQL);
    for (const cause of ["timed_out", "other"] as const) {
      expect(line(cause, "canceling statement due to lock timeout"), cause).not.toMatch(/deduplicat/i);
      expect(UNIQUE_ENFORCEMENT_REASONS[UNIQUE_INDEX_REFUSAL_REASON[cause]].remedy, cause).not.toMatch(
        /deduplicat/i,
      );
    }
  });

  it("names the lock or timeout remedy for a build that was abandoned", () => {
    const t = line("timed_out", "canceling statement due to lock timeout");
    expect(t).toContain("(timed_out)");
    expect(t).toContain("no row was read");
    // Not a flag: the boot store and `column-schema` build the index through `applyBootStatement`,
    // whose `SET LOCAL` bounds override the session's, so naming `--pg-lock-timeout-ms` here was a
    // remedy that cannot work on the arm that prints this most (found in review).
    expect(t).not.toMatch(/--pg-(lock|statement)-timeout-ms/);
    expect(UNIQUE_ENFORCEMENT_REASONS.index_timed_out.remedy).not.toMatch(/--pg-(lock|statement)-timeout-ms/);
    expect(t).toContain("no flag raises them");
    expect(t).toContain(SQL);
  });

  it("quotes the database's reason for anything else", () => {
    expect(line("other", "permission denied for table item")).toContain("permission denied for table item");
  });

  it("feeds the applying arm's refusals into the enforcement line as withheld", () => {
    const m = {
      manifestVersion: "1.0",
      meta: { slug: "t/u", name: "U", version: "1.0.0" },
      entities: [{ name: "Item", fields: [{ name: "code", type: { kind: "text" }, unique: true }] }],
    } as unknown as Manifest;
    const clean = surveyUniqueEnforcement(m, "pg-columns", []);
    expect(clean.verdict).toBe("all_enforced");
    const observed = observedUniqueRefusal({ entity: "Item", field: "code", cause: "timed_out" });
    const r = surveyUniqueEnforcement(m, "pg-columns", [observed]);
    expect(r.withheld).toEqual([{ entity: "Item", field: "code", reason: "index_timed_out", scope: [] }]);
    expect(formatUniqueEnforcementReport(r)).toContain("1 withheld (index_timed_out)");
  });

  it("is the formatter both node.ts sites use, so neither restates the old sentence", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const node = readFileSync(resolve(here, "node.ts"), "utf8");
    expect(node).not.toContain("the duplicate rows are already there");
    expect(node.match(/formatUniqueIndexRefusal\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // And the boot store's applying arm feeds the enforcement line (ADR-0440 Q9).
    expect(node).toContain("...bootUniqueRefusals,");
  });
});
