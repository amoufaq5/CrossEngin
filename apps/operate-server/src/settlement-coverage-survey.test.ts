import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpConstructionPack } from "@crossengin/pack-erp-construction";
import { SETTLEMENT_COVERAGE_DOCUMENTS } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import {
  ALLOW_UNCOVERED_SETTLEMENT_FLAG,
  COVERAGE_DOCUMENT_LIMIT,
  SETTLEMENT_COVERAGE_GAPS,
  SETTLEMENT_COVERAGE_GAP_ORDER,
  SETTLEMENT_COVERAGE_MAY_SERVE,
  SETTLEMENT_COVERAGE_VERDICTS,
  formatSettlementCoverageReport,
  settlementCoverageIsSuspect,
  surveySettlementCoverage,
  type SettlementCoverageGap,
} from "./settlement-coverage-survey.js";

const core = buildErpCorePack();
const guarded = surveySettlementCoverage(core, { allowUncoveredSettlement: false });
const hatched = surveySettlementCoverage(core, { allowUncoveredSettlement: true });

function gapsFor(
  report: ReturnType<typeof surveySettlementCoverage>,
  entity: string,
): readonly SettlementCoverageGap[] {
  const doc = report.documents.find((d) => d.entity === entity);
  if (doc === undefined) throw new Error(`${entity} is not settleable in this manifest`);
  return doc.gaps;
}

describe("surveySettlementCoverage — resolved erp-core", () => {
  it("finds exactly the three documents a lifecycle can mark paid", () => {
    // Measured: `Invoice.mark_paid`, `Bill.mark_paid`, `TaxReturn.mark_paid`. The two `slas`
    // entries beside them (`sent_to_paid_30d`, `approved_to_paid_due`) are deliberately NOT here —
    // an SLA carries no trigger, guard or effect and its only reader in the workspace checks that
    // its states are declared, so it cannot move a document anywhere.
    expect(guarded.documents.map((d) => d.entity)).toEqual(["Invoice", "Bill", "TaxReturn"]);
    for (const doc of guarded.documents) expect(doc.transitions).toEqual(["mark_paid"]);
  });

  it("covers Invoice and Bill and reports TaxReturn for BOTH missing operands", () => {
    expect(gapsFor(guarded, "Invoice")).toEqual([]);
    expect(gapsFor(guarded, "Bill")).toEqual([]);
    // Both, in the declared order, rather than one ranked reason: TaxReturn satisfies two at once
    // and a reader who fixed only the total would still not get a guard.
    expect(gapsFor(guarded, "TaxReturn")).toEqual(["no_total_field", "no_payment_reference"]);
    expect(guarded.verdict).toBe("partly_covered");
    expect(guarded.coveredCount).toBe(2);
    expect(settlementCoverageIsSuspect(guarded)).toBe(true);
  });

  it("reports every document unguarded under the flag, and keeps the operand gaps", () => {
    expect(gapsFor(hatched, "Invoice")).toEqual(["coverage_disabled"]);
    expect(gapsFor(hatched, "TaxReturn")).toEqual([
      "coverage_disabled",
      "no_total_field",
      "no_payment_reference",
    ]);
    expect(hatched.verdict).toBe("none_covered");
    expect(hatched.coveredCount).toBe(0);
  });

  it("agrees with the runtime's own declaration about which documents are covered", () => {
    // The cross-rule join: two hand-written lists would be ADR-0288's maintained list, and here the
    // two halves are the guards that exist and the sentence claiming they exist — the pair where a
    // divergence is a falsely-true control.
    const declared = new Set(SETTLEMENT_COVERAGE_DOCUMENTS.map((d) => d.entity));
    for (const doc of guarded.documents) {
      expect(doc.gaps.length === 0, doc.entity).toBe(declared.has(doc.entity));
    }
  });
});

describe("surveySettlementCoverage — the other six packs inherit core's three", () => {
  it("resolves the same three documents through meta.extends", async () => {
    // Which is what bounds the whole subject to one pack: measured, no other pack declares a
    // transition of its own targeting the settled state. `erp-construction` is the sharpest probe,
    // because it *replaces* core's `WorkOrder` lifecycle — so a pack overlay genuinely can take a
    // transition away, and this is evidence it did not take these.
    const registry: ManifestRegistry = {
      async getManifest(id: string): Promise<Manifest | null> {
        return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
      },
    };
    const resolved = await resolveManifest(buildErpConstructionPack(), { registry });
    const report = surveySettlementCoverage(resolved, { allowUncoveredSettlement: false });
    expect(report.documents.map((d) => d.entity).sort()).toEqual(["Bill", "Invoice", "TaxReturn"]);
    expect(report.coveredCount).toBe(2);
  });
});

describe("surveySettlementCoverage — derived, not asserted", () => {
  const BASE: Manifest = {
    manifestVersion: "1.0",
    meta: { name: "t", slug: "t/t", version: "1.0.0" },
    entities: [
      {
        name: "Invoice",
        fields: [
          { name: "state", type: { kind: "enum", values: ["sent", "paid"] } },
          { name: "total", type: { kind: "decimal", precision: 12, scale: 2 } },
        ],
      },
      {
        name: "Payment",
        fields: [{ name: "invoice_id", type: { kind: "reference", target: "Invoice" } }],
      },
    ],
    workflows: {
      invoice_lifecycle: {
        kind: "entityLifecycle",
        entity: "Invoice",
        stateField: "state",
        initialState: "sent",
        states: [{ name: "sent" }, { name: "paid" }],
        transitions: [{ name: "mark_paid", from: ["sent"], to: "paid", trigger: { kind: "userAction" } }],
      },
    },
  } as unknown as Manifest;

  function without(mutate: (m: Manifest) => Manifest): readonly SettlementCoverageGap[] {
    return gapsFor(surveySettlementCoverage(mutate(structuredClone(BASE)), { allowUncoveredSettlement: false }), "Invoice");
  }

  it("covers the base fixture, so the three mutations below are not vacuous", () => {
    expect(without((m) => m)).toEqual([]);
  });

  it("reads the missing total off the manifest", () => {
    expect(
      without((m) => {
        const inv = (m.entities ?? []).find((e) => e.name === "Invoice");
        if (inv !== undefined) {
          (inv as { fields: unknown[] }).fields = inv.fields.filter((f) => f.name !== "total");
        }
        return m;
      }),
    ).toEqual(["no_total_field"]);
  });

  it("finds a total contributed by a custom trait, which `entity.fields` would miss", () => {
    // The trait read is a precaution with no live member — no builtin trait declares a `total` and
    // no pack declares a custom trait — so without this fixture, swapping `resolvedFields` for
    // `entity.fields` is measurably invisible and the next reader simplifies it away. ADR-0361's
    // class is a reader whose aperture is narrower than the writer's, and the writer here is
    // `columnPlanForEntity`, which resolves traits.
    const trait = structuredClone(BASE) as Manifest;
    const inv = (trait.entities ?? []).find((e) => e.name === "Invoice");
    if (inv !== undefined) {
      (inv as { fields: { name: string }[] }).fields = inv.fields.filter((f) => f.name !== "total");
      (inv as { traits?: string[] }).traits = ["billable"];
    }
    (trait as { traits?: unknown[] }).traits = [
      { name: "billable", fields: [{ name: "total", type: { kind: "decimal", precision: 12, scale: 2 } }] },
    ];
    expect(gapsFor(surveySettlementCoverage(trait, { allowUncoveredSettlement: false }), "Invoice")).toEqual(
      [],
    );
  });

  it("reads the missing payment reference off the reference field's own target", () => {
    // `Payment.invoice_id` carries `{kind: "reference", target: "Invoice"}`; the `relations`
    // section is a separate declaration and does not carry it (measured on erp-core: one Payment
    // relation, for `account_id`), so the target is where this has to be read from.
    expect(
      without((m) => {
        const pay = (m.entities ?? []).find((e) => e.name === "Payment");
        if (pay !== undefined) {
          (pay as { fields: { name: string; type: { target?: string } }[] }).fields[0]!.type.target =
            "Something";
        }
        return m;
      }),
    ).toEqual(["no_payment_reference"]);
  });

  it("reports the whole manifest when there is no Payment entity, and not the implied gap", () => {
    // `no_payment_reference` is vacuously true here and is suppressed, because its remedy — add a
    // reference field *on Payment* — presupposes the entity this gap says is missing. ADR-0334, and
    // `no_payment_entity`'s own remedy already asks for the references.
    expect(
      without((m) => {
        (m as { entities: unknown[] }).entities = (m.entities ?? []).filter(
          (e) => e.name !== "Payment",
        );
        return m;
      }),
    ).toEqual(["no_payment_entity"]);
  });

  it("names a settleable document the declaration does not cover, and only then", () => {
    // The residual, last in the order: a declaration gap reported beside a missing operand would
    // send a reader to add an entry that could not work.
    const renamed = structuredClone(BASE) as Manifest;
    for (const e of renamed.entities ?? []) {
      if (e.name === "Invoice") (e as { name: string }).name = "Levy";
    }
    const pay = (renamed.entities ?? []).find((e) => e.name === "Payment");
    if (pay !== undefined) {
      (pay as { fields: { name: string; type: { target?: string } }[] }).fields[0]!.type.target = "Levy";
    }
    const wf = (renamed.workflows ?? {})["invoice_lifecycle"];
    if (wf !== undefined) (wf as { entity: string }).entity = "Levy";
    const report = surveySettlementCoverage(renamed, { allowUncoveredSettlement: false });
    expect(gapsFor(report, "Levy")).toEqual(["not_declared"]);
    expect(report.verdict).toBe("none_covered");
  });

  it("says nothing is settleable when no transition reaches the settled state", () => {
    const noPaid = structuredClone(BASE) as Manifest;
    const wf = (noPaid.workflows ?? {})["invoice_lifecycle"];
    if (wf !== undefined) {
      (wf as { transitions: { to: string }[] }).transitions[0]!.to = "sent";
    }
    const report = surveySettlementCoverage(noPaid, { allowUncoveredSettlement: false });
    expect(report.verdict).toBe("no_settleable_documents");
    expect(report.documents).toEqual([]);
    expect(settlementCoverageIsSuspect(report)).toBe(false);
  });
});

describe("the verdict map and the gap vocabulary", () => {
  it("permits a boot on every verdict — this survey reports and never refuses", () => {
    for (const v of SETTLEMENT_COVERAGE_VERDICTS) {
      expect(SETTLEMENT_COVERAGE_MAY_SERVE[v], v).toBe(true);
    }
    expect(Object.keys(SETTLEMENT_COVERAGE_MAY_SERVE).sort()).toEqual([...SETTLEMENT_COVERAGE_VERDICTS].sort());
    expect(guarded.mayServe).toBe(true);
    expect(hatched.mayServe).toBe(true);
  });

  it("orders the gaps from the map's own keys, so a sixth cannot arrive unplaced", () => {
    expect(SETTLEMENT_COVERAGE_GAP_ORDER).toEqual(Object.keys(SETTLEMENT_COVERAGE_GAPS));
    // The two deployment-wide facts first, the vacuous-pass operand before the refuse-everything
    // one, the residual last — the ranking argued in each member's doc.
    expect(SETTLEMENT_COVERAGE_GAP_ORDER).toEqual([
      "coverage_disabled",
      "no_payment_entity",
      "no_total_field",
      "no_payment_reference",
      "not_declared",
    ]);
  });

  it("gives every gap a sentence and a remedy, and no gap is unreachable", () => {
    // Both directions: a gap with no remedy cannot be reported, and a gap no input produces would
    // be a modelled value with no producer. The five inputs above cover four; `not_declared` is
    // covered by its own test, so the union below is the producer census.
    const produced = new Set<SettlementCoverageGap>();
    for (const r of [guarded, hatched]) for (const d of r.documents) for (const g of d.gaps) produced.add(g);
    produced.add("no_payment_entity");
    produced.add("not_declared");
    for (const gap of SETTLEMENT_COVERAGE_GAP_ORDER) {
      expect(SETTLEMENT_COVERAGE_GAPS[gap].gap, gap).toBeTruthy();
      expect(SETTLEMENT_COVERAGE_GAPS[gap].remedy, gap).toBeTruthy();
      expect(produced.has(gap), `${gap} has no producer`).toBe(true);
    }
  });
});

describe("formatSettlementCoverageReport", () => {
  it("says it either way, including when nothing is settleable", () => {
    // `boot-erasure-report.ts`' rule: "we checked and found nothing" cannot be claimed from the
    // absence of a log line, and a line printed only on a finding would print nothing here —
    // indistinguishable, in a boot log, from a survey that did not run.
    const none = surveySettlementCoverage({ ...core, workflows: {} } as Manifest, {
      allowUncoveredSettlement: false,
    });
    const line = formatSettlementCoverageReport(none);
    expect(line).toContain("[settlement]");
    expect(line).toContain("none");
    expect(line).toContain("no coverage");
  });

  it("names the counts, the guarded documents, each gap and its remedy", () => {
    const line = formatSettlementCoverageReport(guarded);
    expect(line).toContain("2 of 3 guarded");
    expect(line).toContain("Invoice (mark_paid)");
    expect(line).toContain("TaxReturn (mark_paid)");
    expect(line).toContain("no_total_field");
    expect(line).toContain("remedy:");
    // The consequence, said once at the end: it is what makes the finding actionable.
    expect(line).toContain("aging report showing nothing open");
  });

  it("names the flag in the remedy an operator would act on, and nowhere else", () => {
    expect(formatSettlementCoverageReport(hatched)).toContain(ALLOW_UNCOVERED_SETTLEMENT_FLAG);
    // Not in the all-guarded line: a deployment doing the right thing is not told how to stop.
    expect(formatSettlementCoverageReport(guarded)).not.toContain(ALLOW_UNCOVERED_SETTLEMENT_FLAG);
  });

  it("keeps the count exact when the list is truncated", () => {
    const many = {
      ...guarded,
      documents: Array.from({ length: COVERAGE_DOCUMENT_LIMIT + 3 }, (_, i) => ({
        entity: `E${i.toString()}`,
        transitions: ["mark_paid"],
        gaps: ["not_declared" as SettlementCoverageGap],
      })),
      coveredCount: 0,
      verdict: "none_covered" as const,
    };
    const line = formatSettlementCoverageReport(many);
    expect(line).toContain(`0 of ${(COVERAGE_DOCUMENT_LIMIT + 3).toString()} guarded`);
    expect(line).toContain("(+3 more)");
  });
});
