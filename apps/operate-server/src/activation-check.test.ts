import type { Manifest } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { buildActivationCheck, type ActivationCheckOptions } from "./activation-check.js";
import { buildTenantManifestLineage } from "./tenant-manifest-lineage.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const BOOT = buildErpCorePack();
const LINEAGE = buildTenantManifestLineage({ slug: ERP_CORE_PACK_SLUG, manifest: BOOT });

function options(over: Partial<ActivationCheckOptions> = {}): ActivationCheckOptions {
  return { lineage: LINEAGE, abac: null, cursorSealing: "sealed", ...over };
}

/** A tenant manifest extending the boot pack with one entity of its own — the shape that serves. */
function extending(entityName: string, over: Partial<Manifest> = {}): Record<string, unknown> {
  const manifest: Manifest = {
    manifestVersion: "1.0",
    meta: { name: "acme", slug: "tenant/acme", version: "1.0.0", extends: [ERP_CORE_PACK_SLUG] },
    entities: [{ name: entityName, fields: [{ name: "name", type: { kind: "text" } }] }],
    roles: { operator: { name: "operator" } },
    permissions: {
      [entityName]: {
        list: { roles: ["operator"] },
        read: { roles: ["operator"] },
        create: { roles: ["operator"] },
        update: { roles: ["operator"] },
        delete: { roles: ["operator"] },
      },
    },
    ...over,
  };
  return manifest as unknown as Record<string, unknown>;
}

function withMeta(manifest: Record<string, unknown>, meta: Record<string, unknown>): Record<string, unknown> {
  const current = manifest["meta"];
  return { ...manifest, meta: { ...(typeof current === "object" && current !== null ? current : {}), ...meta } };
}

describe("buildActivationCheck", () => {
  it("admits a manifest that extends the permitted parent and validates", async () => {
    const check = buildActivationCheck(options());
    expect(await check(TENANT, extending("Widget"))).toBeNull();
  });

  it("refuses a parent this deployment does not serve, naming the permitted one", async () => {
    const check = buildActivationCheck(options());
    const refusal = await check(TENANT, withMeta(extending("Widget"), { extends: ["operate-erp/retail"] }));
    expect(refusal?.kind).toBe("lineage_parent_unknown");
    expect(refusal?.sentence).toContain("operate-erp/core");
    expect(refusal?.issues.join(" ")).toContain("operate-erp/retail");
  });

  it("refuses a lineage cycle", async () => {
    const check = buildActivationCheck(options());
    const refusal = await check(TENANT, withMeta(extending("Widget"), { slug: ERP_CORE_PACK_SLUG }));
    expect(refusal?.kind).toBe("lineage_cycle");
  });

  it("refuses an inherited entity redeclared without overrides: true", async () => {
    const check = buildActivationCheck(options());
    const refusal = await check(TENANT, extending("Invoice"));
    expect(refusal?.kind).toBe("lineage_override_undeclared");
    expect(refusal?.issues.join(" ")).toContain("Invoice");
  });

  it("refuses a manifest that does not validate, with its issues — where the cache would fall back", async () => {
    const check = buildActivationCheck(options());
    const broken = extending("Widget", {
      entities: [
        {
          name: "Widget",
          fields: [{ name: "owner", type: { kind: "reference", target: "NoSuchEntity" } }],
        },
      ],
    });
    const refusal = await check(TENANT, broken);
    expect(refusal?.kind).toBe("manifest_invalid");
    expect(refusal?.issues.length).toBeGreaterThan(0);
    expect(refusal?.issues.join(" ")).toContain("NoSuchEntity");
  });

  it("refuses an unparseable manifest as invalid", async () => {
    const check = buildActivationCheck(options());
    const refusal = await check(TENANT, { manifestVersion: "9.9" });
    expect(refusal?.kind).toBe("manifest_invalid");
  });

  it("refuses an ABAC obligation no declared policy can discharge, without echoing the deployment's keys", async () => {
    const obliged = extending("Widget");
    const permissions = obliged["permissions"] as Record<string, Record<string, unknown>>;
    const withObligation = {
      ...obliged,
      permissions: {
        Widget: { ...permissions["Widget"], list: { roles: ["operator"], abac: "own_department" } },
      },
    };
    const none = await buildActivationCheck(options())(TENANT, withObligation);
    expect(none?.kind).toBe("abac_obligation_unevaluable");
    // The obligation check's message names this deployment's policy surface, which the 503 path
    // already keeps out of a response; the activation answer inherits that.
    expect(none?.issues).toEqual([]);

    // Control: the same manifest is admitted once a policy answers the key, so the refusal above
    // is the obligation and not something else about the manifest.
    const answered = await buildActivationCheck(
      options({
        abac: { answerableKeys: new Set(["own_department"]), recordBearingKeys: new Set() },
      }),
    )(TENANT, withObligation);
    expect(answered).toBeNull();
  });

  it("checks each call afresh — a refusal is not remembered by the next activation", async () => {
    const check = buildActivationCheck(options());
    expect((await check(TENANT, extending("Invoice")))?.kind).toBe("lineage_override_undeclared");
    expect(await check(TENANT, extending("Widget"))).toBeNull();
  });

  it("refuses an extending manifest when the deployment permits no parent at all", async () => {
    const check = buildActivationCheck(options({ lineage: buildTenantManifestLineage(null) }));
    expect((await check(TENANT, extending("Widget")))?.kind).toBe("lineage_parent_unknown");
  });

  // Asked on the request path of every activation, so its cost is part of the decision to run it
  // there. Measured over the real erp-core parent; the bound is generous so a loaded CI box does
  // not flake, and the median is what the ADR records.
  it("costs a few milliseconds per activation against the real erp-core parent", async () => {
    const check = buildActivationCheck(options());
    const manifest = extending("Widget");
    await check(TENANT, manifest);
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const start = performance.now();
      await check(TENANT, manifest);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
    expect(median).toBeLessThan(250);
  });
});
