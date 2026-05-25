import {
  ManifestSchema,
  computeManifestDiff,
  manifestHash,
  resolveManifest,
  tryValidateManifest,
  type Manifest,
  type ManifestRegistry,
} from "@crossengin/kernel/manifest";
import { buildErpCorePack, ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { ERP_PAYMENTS_PACK_SLUG, ERP_PAYMENTS_PACK_VERSION, buildErpPaymentsPack } from "./pack.js";

function makeRegistry(): ManifestRegistry {
  const map: Record<string, Manifest> = {
    [ERP_CORE_PACK_SLUG]: buildErpCorePack(),
  };
  return {
    async getManifest(slug: string): Promise<Manifest | null> {
      return map[slug] ?? null;
    },
  };
}

async function buildResolvedPayments(): Promise<Manifest> {
  return resolveManifest(buildErpPaymentsPack(), { registry: makeRegistry() });
}

describe("buildErpPaymentsPack — manifest shape (child-only)", () => {
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

  it("child manifest carries only payments additions (1 entity, 1 relation)", () => {
    const m = buildErpPaymentsPack();
    expect(m.entities).toHaveLength(1);
    expect(m.entities?.[0]?.name).toBe("Payment");
    expect(m.relations).toHaveLength(1);
  });
});

describe("buildErpPaymentsPack — full kernel cross-validation (resolved)", () => {
  it("passes tryValidateManifest with the merged core + payments manifest", async () => {
    const m = await buildResolvedPayments();
    const result = tryValidateManifest(m);
    if (!result.ok) {
      throw new Error(`tryValidateManifest failed: ${JSON.stringify(result.errors)}`);
    }
    expect(result.ok).toBe(true);
  });

  it("returns deterministic hash across resolved builds", async () => {
    expect(manifestHash(await buildResolvedPayments())).toBe(
      manifestHash(await buildResolvedPayments()),
    );
  });

  it("differs from the core pack hash (extends adds entities)", async () => {
    expect(manifestHash(await buildResolvedPayments())).not.toBe(manifestHash(buildErpCorePack()));
  });

  it("self-diff returns no changes", async () => {
    const diff = computeManifestDiff(await buildResolvedPayments(), await buildResolvedPayments());
    expect(diff.addedEntities).toHaveLength(0);
    expect(diff.removedEntities).toHaveLength(0);
    expect(diff.modifiedEntities).toHaveLength(0);
  });

  it("diff from core to resolved payments adds exactly Payment", async () => {
    const diff = computeManifestDiff(buildErpCorePack(), await buildResolvedPayments());
    expect(diff.addedEntities.map((e) => e.name)).toEqual(["Payment"]);
    expect(diff.removedEntities).toHaveLength(0);
  });
});

describe("buildErpPaymentsPack — composition counts (resolved)", () => {
  it("has 5 entities (4 from core + Payment)", async () => {
    const m = await buildResolvedPayments();
    expect(m.entities).toHaveLength(5);
  });

  it("has 4 relations (3 from core + Invoice→Payments)", async () => {
    const m = await buildResolvedPayments();
    expect(m.relations).toHaveLength(4);
  });

  it("has 3 roles (inherited from core, no payments-specific roles)", async () => {
    const m = await buildResolvedPayments();
    expect(Object.keys(m.roles ?? {})).toHaveLength(3);
  });

  it("has 5 permission entries (core's 4 + Payment)", async () => {
    const m = await buildResolvedPayments();
    expect(Object.keys(m.permissions ?? {})).toHaveLength(5);
  });

  it("has 2 workflows (invoice_lifecycle + payment_lifecycle)", async () => {
    const m = await buildResolvedPayments();
    expect(Object.keys(m.workflows ?? {})).toHaveLength(2);
  });

  it("has 4 jobs (core's 2 + payments' 2)", async () => {
    const m = await buildResolvedPayments();
    expect(Object.keys(m.jobs ?? {})).toHaveLength(4);
  });

  it("has 3 views (core's 2 + payment.list)", async () => {
    const m = await buildResolvedPayments();
    expect(Object.keys(m.views ?? {})).toHaveLength(3);
  });
});

describe("Payment entity composition (resolved)", () => {
  it("Payment entity is present in the merged manifest", async () => {
    const m = await buildResolvedPayments();
    const payment = (m.entities ?? []).find((e) => e.name === "Payment");
    expect(payment).toBeDefined();
  });

  it("Payment references Invoice (cross-pack FK resolves via merge)", async () => {
    const m = await buildResolvedPayments();
    const payment = (m.entities ?? []).find((e) => e.name === "Payment");
    const invoiceRef = payment?.fields.find((f) => f.name === "invoice_id");
    if (invoiceRef?.type.kind !== "reference") {
      throw new Error("invoice_id is not a reference field");
    }
    expect(invoiceRef.type.target).toBe("Invoice");
  });

  it("payment_lifecycle has 6 states; settled stays active so refunds remain possible", async () => {
    const m = await buildResolvedPayments();
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

  it("permissions cover all 5 named transitions", async () => {
    const m = await buildResolvedPayments();
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
