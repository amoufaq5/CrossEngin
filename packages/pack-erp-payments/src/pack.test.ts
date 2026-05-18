import {
  ManifestSchema,
  computeManifestDiff,
  manifestHash,
  tryValidateManifest,
} from "@crossengin/kernel/manifest";
import { buildErpCorePack, ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import {
  ERP_PAYMENTS_PACK_SLUG,
  ERP_PAYMENTS_PACK_VERSION,
  buildErpPaymentsPack,
} from "./pack.js";

describe("buildErpPaymentsPack — manifest shape", () => {
  it("parses against the kernel ManifestSchema", () => {
    const m = buildErpPaymentsPack();
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("uses the documented slug + version", () => {
    const m = buildErpPaymentsPack();
    expect(m.meta.slug).toBe(ERP_PAYMENTS_PACK_SLUG);
    expect(m.meta.version).toBe(ERP_PAYMENTS_PACK_VERSION);
  });

  it("declares extends: ['operate-erp/core']", () => {
    const m = buildErpPaymentsPack();
    expect(m.meta.extends).toEqual([ERP_CORE_PACK_SLUG]);
  });

  it("threads compliancePacks + description overrides", () => {
    const m = buildErpPaymentsPack({
      description: "custom",
      compliancePacks: ["pci_dss"],
    });
    expect(m.meta.description).toBe("custom");
    expect(m.meta.compliancePacks).toEqual(["pci_dss"]);
  });
});

describe("buildErpPaymentsPack — full kernel cross-validation", () => {
  it("passes tryValidateManifest with the merged core + payments manifest", () => {
    const m = buildErpPaymentsPack();
    const result = tryValidateManifest(m);
    if (!result.ok) {
      throw new Error(
        `tryValidateManifest failed: ${JSON.stringify(result.errors)}`,
      );
    }
    expect(result.ok).toBe(true);
  });

  it("returns deterministic hash across builds", () => {
    expect(manifestHash(buildErpPaymentsPack())).toBe(
      manifestHash(buildErpPaymentsPack()),
    );
  });

  it("differs from the core pack hash (extends adds entities)", () => {
    expect(manifestHash(buildErpPaymentsPack())).not.toBe(
      manifestHash(buildErpCorePack()),
    );
  });

  it("self-diff returns no changes", () => {
    const diff = computeManifestDiff(
      buildErpPaymentsPack(),
      buildErpPaymentsPack(),
    );
    expect(diff.addedEntities).toHaveLength(0);
    expect(diff.removedEntities).toHaveLength(0);
    expect(diff.modifiedEntities).toHaveLength(0);
  });

  it("diff from core to payments adds exactly Payment", () => {
    const diff = computeManifestDiff(buildErpCorePack(), buildErpPaymentsPack());
    expect(diff.addedEntities.map((e) => e.name)).toEqual(["Payment"]);
    expect(diff.removedEntities).toHaveLength(0);
  });
});

describe("buildErpPaymentsPack — composition counts", () => {
  it("has 5 entities (4 from core + Payment)", () => {
    expect(buildErpPaymentsPack().entities).toHaveLength(5);
  });

  it("has 4 relations (3 from core + Invoice→Payments)", () => {
    expect(buildErpPaymentsPack().relations).toHaveLength(4);
  });

  it("has 3 roles (inherited from core, no payments-specific roles)", () => {
    expect(Object.keys(buildErpPaymentsPack().roles ?? {})).toHaveLength(3);
  });

  it("has 5 permission entries (core's 4 + Payment)", () => {
    expect(Object.keys(buildErpPaymentsPack().permissions ?? {})).toHaveLength(5);
  });

  it("has 2 workflows (invoice_lifecycle + payment_lifecycle)", () => {
    expect(Object.keys(buildErpPaymentsPack().workflows ?? {})).toHaveLength(2);
  });

  it("has 4 jobs (core's 2 + payments' 2)", () => {
    expect(Object.keys(buildErpPaymentsPack().jobs ?? {})).toHaveLength(4);
  });

  it("has 3 views (core's 2 + payment.list)", () => {
    expect(Object.keys(buildErpPaymentsPack().views ?? {})).toHaveLength(3);
  });
});

describe("Payment entity composition", () => {
  it("Payment entity is present in the merged manifest", () => {
    const m = buildErpPaymentsPack();
    const payment = (m.entities ?? []).find((e) => e.name === "Payment");
    expect(payment).toBeDefined();
  });

  it("Payment references Invoice (cross-pack FK resolves via merge)", () => {
    const m = buildErpPaymentsPack();
    const payment = (m.entities ?? []).find((e) => e.name === "Payment");
    const invoiceRef = payment?.fields.find((f) => f.name === "invoice_id");
    if (invoiceRef?.type.kind !== "reference") {
      throw new Error("invoice_id is not a reference field");
    }
    expect(invoiceRef.type.target).toBe("Invoice");
  });

  it("payment_lifecycle has 6 states; settled stays active so refunds remain possible", () => {
    const m = buildErpPaymentsPack();
    const wf = m.workflows?.["payment_lifecycle"];
    if (wf?.kind !== "entityLifecycle") return;
    expect(wf.states).toHaveLength(6);
    const terminals = wf.states
      .filter((s) => s.category === "terminal")
      .map((s) => s.name)
      .sort();
    expect(terminals).toEqual(["cancelled", "failed", "refunded"]);
    const settled = wf.states.find((s) => s.name === "settled");
    expect(settled?.category).toBe("active");
  });

  it("permissions cover all 5 named transitions", () => {
    const m = buildErpPaymentsPack();
    const perms = m.permissions?.["Payment"];
    expect(Object.keys(perms?.transitions ?? {}).sort()).toEqual([
      "cancel",
      "capture",
      "fail",
      "refund",
      "settle",
    ]);
  });
});
