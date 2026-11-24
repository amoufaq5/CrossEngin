import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpConstructionPack } from "@crossengin/pack-erp-construction";
import {
  SETTLEMENT_COVERAGE_DOCUMENTS,
  taxRemittanceUnwiredReasons,
  taxRemittanceWiring,
} from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import {
  ALLOW_UNCOVERED_SETTLEMENT_FLAG,
  COVERAGE_DOCUMENT_LIMIT,
  SETTLEMENT_COVERAGE_GAPS,
  SETTLEMENT_COVERAGE_GAP_ORDER,
  SETTLEMENT_COVERAGE_MAY_SERVE,
  SETTLEMENT_COVERAGE_VERDICTS,
  formatSettlementCoverageReport,
  formatTaxRemittanceWiring,
  formatTenantTaxRemittanceWiring,
  settlementCoverageIsSuspect,
  surveySettlementCoverage,
  taxRemittanceWiringIsSuspect,
  type SettlementCoverageGap,
} from "./settlement-coverage-survey.js";

const core = buildErpCorePack();
const guarded = surveySettlementCoverage(core, { allowUncoveredSettlement: false });
const hatched = surveySettlementCoverage(core, { allowUncoveredSettlement: true });

/** Resolved erp-core with one remittance stamp removed from TaxReturn, so the posting is unwired. */
function coreWithoutStamp(field = "remittance_count"): Manifest {
  const m = structuredClone(core);
  const tr = (m.entities ?? []).find((e) => e.name === "TaxReturn");
  if (tr === undefined) throw new Error("erp-core declares no TaxReturn");
  (tr as { fields: { name: string }[] }).fields = tr.fields.filter((f) => f.name !== field);
  return m;
}
const unwiredCore = coreWithoutStamp();
const unwired = surveySettlementCoverage(unwiredCore, { allowUncoveredSettlement: false });

/** The Payment-reference remedy, which ADR-0467 says must never be offered for a tax return. */
const PAYMENT_REFERENCE_REMEDY = SETTLEMENT_COVERAGE_GAPS.no_payment_reference.remedy;

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

  it("guards Invoice and Bill and settles TaxReturn by its own posting (ADR-0467)", () => {
    expect(gapsFor(guarded, "Invoice")).toEqual([]);
    expect(gapsFor(guarded, "Bill")).toEqual([]);
    // Not `no_total_field` + `no_payment_reference`, which is what it read before: a return is not
    // settled by a payment, so neither operand is a gap and their remedies would send an operator to
    // build the Payment route ADR-0467 refused.
    expect(gapsFor(guarded, "TaxReturn")).toEqual([]);
    expect(guarded.documents.map((d) => [d.entity, d.mechanism])).toEqual([
      ["Invoice", "payment_coverage"],
      ["Bill", "payment_coverage"],
      ["TaxReturn", "own_posting"],
    ]);
    expect(guarded.verdict).toBe("all_covered");
    expect(guarded.coveredCount).toBe(3);
    expect(settlementCoverageIsSuspect(guarded)).toBe(false);
  });

  it("disables the coverage guards under the flag and leaves the return's own posting alone", () => {
    // The flag turns off a coverage guard; the return never had one, so it gains no gap.
    expect(gapsFor(hatched, "Invoice")).toEqual(["coverage_disabled"]);
    expect(gapsFor(hatched, "Bill")).toEqual(["coverage_disabled"]);
    expect(gapsFor(hatched, "TaxReturn")).toEqual([]);
    expect(hatched.verdict).toBe("partly_covered");
    expect(hatched.coveredCount).toBe(1);
  });

  it("agrees with the runtime's own declaration about which documents are guarded", () => {
    // The cross-rule join: two hand-written lists would be ADR-0288's maintained list, and here the
    // two halves are the guards that exist and the sentence claiming they exist — the pair where a
    // divergence is a falsely-true control. Over the payment-settled documents only: the return is
    // covered by the posting, and by design is in no coverage declaration.
    const declared = new Set(SETTLEMENT_COVERAGE_DOCUMENTS.map((d) => d.entity));
    expect(declared.has("TaxReturn")).toBe(false);
    for (const doc of guarded.documents.filter((d) => d.mechanism === "payment_coverage")) {
      expect(doc.gaps.length === 0, doc.entity).toBe(declared.has(doc.entity));
    }
  });
});

describe("surveySettlementCoverage — the return's own posting, one predicate with the effect gate", () => {
  it("reports the posting unwired, with the runtime's own reasons, when a stamp is missing", () => {
    expect(taxRemittanceWiring(unwiredCore)).toBeNull();
    expect(gapsFor(unwired, "TaxReturn")).toEqual(["tax_remittance_unwired"]);
    const doc = unwired.documents.find((d) => d.entity === "TaxReturn");
    expect(doc?.unwiredReasons).toEqual(taxRemittanceUnwiredReasons(unwiredCore));
    expect(doc?.unwiredReasons).toContain("TaxReturn declares no field 'remittance_count'");
    expect(unwired.verdict).toBe("partly_covered");
    expect(settlementCoverageIsSuspect(unwired)).toBe(true);
  });

  it("agrees with taxRemittanceWiring over every stamp and required field removed one at a time", () => {
    // Not a fixture agreeing with itself: each removal is asked of both readers, so a survey that
    // decided wiring by its own list would disagree with the gate on the first field it forgot.
    const fields = [
      "remitted_at",
      "remittance_entry_number",
      "remittance_count",
      "credit_disposition",
      "net_payable",
      "period_end",
    ];
    for (const field of fields) {
      const m = coreWithoutStamp(field);
      const report = surveySettlementCoverage(m, { allowUncoveredSettlement: false });
      expect(gapsFor(report, "TaxReturn").length === 0, field).toBe(taxRemittanceWiring(m) !== null);
      expect(gapsFor(report, "TaxReturn"), field).toEqual(["tax_remittance_unwired"]);
    }
  });

  it("never offers the Payment-reference remedy for a tax return, wired or not", () => {
    for (const report of [guarded, hatched, unwired]) {
      const doc = report.documents.find((d) => d.entity === "TaxReturn");
      expect(doc?.gaps ?? []).not.toContain("no_payment_reference");
      expect(doc?.gaps ?? []).not.toContain("no_total_field");
      expect(formatSettlementCoverageReport(report)).not.toContain(PAYMENT_REFERENCE_REMEDY);
    }
  });

  it("carries no reasons on a payment-settled document", () => {
    for (const doc of hatched.documents.filter((d) => d.mechanism === "payment_coverage")) {
      expect(doc.unwiredReasons, doc.entity).toEqual([]);
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
    // All three, the return through its own posting: the overlay inherits the remittance fields.
    expect(report.coveredCount).toBe(3);
    expect(taxRemittanceWiring(resolved)).not.toBeNull();
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
      "tax_remittance_unwired",
    ]);
  });

  it("gives every gap a sentence and a remedy, and no gap is unreachable", () => {
    // Both directions: a gap with no remedy cannot be reported, and a gap no input produces would
    // be a modelled value with no producer. The shipped pack produces only the flag's and the
    // unwired posting's gaps now that the return is no longer reported for missing operands; the
    // four the fixture tests above produce are added by name, so the union is the producer census.
    const produced = new Set<SettlementCoverageGap>();
    for (const r of [guarded, hatched, unwired]) for (const d of r.documents) for (const g of d.gaps) produced.add(g);
    produced.add("no_payment_entity");
    produced.add("no_total_field");
    produced.add("no_payment_reference");
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

  it("names the guarded documents and the one settled by its own posting, with the tenant condition", () => {
    const line = formatSettlementCoverageReport(guarded);
    // Per mechanism: the return is not counted among the guarded documents (ADR-0467).
    expect(line).toContain("2 of 2 payment-settled guarded; 1 of 1 settled by its own posting wired (per tenant)");
    expect(line).not.toContain("3 of 3");
    expect(line).toContain("guarded: Invoice (mark_paid), Bill (mark_paid)");
    expect(line).toContain("settled by its own posting: TaxReturn (mark_paid)");
    // The per-tenant condition the boot cannot see, in the server's spelling of the setting.
    expect(line).toContain("finance.taxRemittancePosting=on_mark_paid");
    expect(line).toContain("default manual_journal mode it posts nothing");
    // Nothing is uncovered, so neither a remedy nor the divergence consequence is printed.
    expect(line).not.toContain("remedy:");
    expect(line).not.toContain("aging report showing nothing open");
  });

  it("names each gap and its remedy, and the payment consequence only for a payment document", () => {
    const line = formatSettlementCoverageReport(hatched);
    // The wired return does not lift the headline: no payment-settled document is guarded.
    expect(line).toContain("0 of 2 payment-settled guarded; 1 of 1 settled by its own posting wired (per tenant)");
    expect(line).toContain("2 uncovered (coverage_disabled)");
    expect(line).toContain("remedy:");
    expect(line).toContain("aging report showing nothing open");
  });

  it("prints an unwired posting's reasons and its remedy, and not the payment consequence", () => {
    const line = formatSettlementCoverageReport(unwired);
    expect(line).toContain("1 uncovered (tax_remittance_unwired)");
    expect(line).toContain("reasons: TaxReturn declares no field 'remittance_count'");
    expect(line).toContain(SETTLEMENT_COVERAGE_GAPS.tax_remittance_unwired.remedy);
    expect(line).not.toContain("aging report showing nothing open");
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
        mechanism: "payment_coverage" as const,
        unwiredReasons: [],
        gaps: ["not_declared" as SettlementCoverageGap],
      })),
      coveredCount: 0,
      verdict: "none_covered" as const,
    };
    const line = formatSettlementCoverageReport(many);
    expect(line).toContain(`0 of ${(COVERAGE_DOCUMENT_LIMIT + 3).toString()} payment-settled guarded`);
    expect(line).toContain("(+3 more)");
  });
});

describe("the [tax-remittance] boot line", () => {
  it("says the posting is wired, and that it posts only for a tenant that opts in", () => {
    expect(formatTaxRemittanceWiring(core)).toBe(
      "[tax-remittance] wired: TaxReturn.mark_paid posts when a tenant sets" +
        " finance.taxRemittancePosting=on_mark_paid (default manual_journal)",
    );
    expect(taxRemittanceWiringIsSuspect(core)).toBe(false);
  });

  it("names the runtime's reasons when unwired, and warns only when a TaxReturn exists", () => {
    const line = formatTaxRemittanceWiring(unwiredCore);
    expect(line).toBe(`[tax-remittance] unwired: ${taxRemittanceUnwiredReasons(unwiredCore).join("; ")}`);
    expect(taxRemittanceWiringIsSuspect(unwiredCore)).toBe(true);
    // A manifest with no TaxReturn is unwired too and says so, but has nothing to warn about.
    const none = { ...core, entities: (core.entities ?? []).filter((e) => e.name !== "TaxReturn") } as Manifest;
    expect(formatTaxRemittanceWiring(none)).toContain("the manifest declares no TaxReturn entity");
    expect(taxRemittanceWiringIsSuspect(none)).toBe(false);
  });

  it("prints a per-tenant line only for an unwired manifest that has a TaxReturn", () => {
    const tenant = "6a0f7c2e-0000-4000-8000-000000000001";
    expect(formatTenantTaxRemittanceWiring(tenant, core)).toBeNull();
    const none = { ...core, entities: (core.entities ?? []).filter((e) => e.name !== "TaxReturn") } as Manifest;
    expect(formatTenantTaxRemittanceWiring(tenant, none)).toBeNull();
    expect(formatTenantTaxRemittanceWiring(tenant, unwiredCore)).toBe(
      `[tax-remittance] tenant ${tenant}: unwired: ${taxRemittanceUnwiredReasons(unwiredCore).join("; ")}`,
    );
  });
});
