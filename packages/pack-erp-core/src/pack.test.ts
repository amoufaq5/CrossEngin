import {
  ManifestSchema,
  computeManifestDiff,
  manifestHash,
  tryValidateManifest,
} from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import { ACCOUNT_ENTITY, INVOICE_ENTITY } from "./entities.js";
import {
  ERP_CORE_PACK_SLUG,
  ERP_CORE_PACK_VERSION,
  buildErpCorePack,
} from "./pack.js";

describe("buildErpCorePack — manifest shape", () => {
  it("parses against the kernel ManifestSchema", () => {
    const m = buildErpCorePack();
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("uses the documented slug and version", () => {
    const m = buildErpCorePack();
    expect(m.meta.slug).toBe(ERP_CORE_PACK_SLUG);
    expect(m.meta.version).toBe(ERP_CORE_PACK_VERSION);
  });

  it("threads compliancePacks when supplied", () => {
    const m = buildErpCorePack({
      compliancePacks: ["gdpr", "soc2"],
    });
    expect(m.meta.compliancePacks).toEqual(["gdpr", "soc2"]);
  });

  it("threads custom description when supplied", () => {
    const m = buildErpCorePack({ description: "custom" });
    expect(m.meta.description).toBe("custom");
  });
});

describe("buildErpCorePack — full kernel cross-validation", () => {
  it("passes tryValidateManifest (entities, roles, workflows, permissions, views all resolve)", () => {
    const m = buildErpCorePack();
    const result = tryValidateManifest(m);
    if (!result.ok) {
      throw new Error(
        `tryValidateManifest failed: ${JSON.stringify(result.errors)}`,
      );
    }
    expect(result.ok).toBe(true);
  });

  it("returns deterministic hash across two builds", () => {
    expect(manifestHash(buildErpCorePack())).toBe(
      manifestHash(buildErpCorePack()),
    );
  });

  it("two empty diffs against itself returns no changes", () => {
    const diff = computeManifestDiff(buildErpCorePack(), buildErpCorePack());
    expect(diff.addedEntities).toHaveLength(0);
    expect(diff.removedEntities).toHaveLength(0);
    expect(diff.modifiedEntities).toHaveLength(0);
  });
});

describe("buildErpCorePack — counts", () => {
  it("has 23 entities", () => {
    expect(buildErpCorePack().entities).toHaveLength(23);
  });

  it("has 23 relations", () => {
    expect(buildErpCorePack().relations).toHaveLength(23);
  });

  it("has 9 roles", () => {
    expect(Object.keys(buildErpCorePack().roles ?? {})).toHaveLength(9);
  });

  it("has 23 entity permission sets", () => {
    expect(Object.keys(buildErpCorePack().permissions ?? {})).toHaveLength(23);
  });

  it("has 7 workflows", () => {
    expect(Object.keys(buildErpCorePack().workflows ?? {})).toHaveLength(7);
  });

  it("has 2 jobs", () => {
    expect(Object.keys(buildErpCorePack().jobs ?? {})).toHaveLength(2);
  });

  it("has 17 views", () => {
    expect(Object.keys(buildErpCorePack().views ?? {})).toHaveLength(17);
  });
});

describe("Account entity — shape spot-checks", () => {
  it("requires billing_email", () => {
    const f = ACCOUNT_ENTITY.fields.find((f) => f.name === "billing_email");
    expect(f?.required).toBe(true);
    expect(f?.type.kind).toBe("email");
  });

  it("has a status enum with 4 values", () => {
    const f = ACCOUNT_ENTITY.fields.find((f) => f.name === "status");
    if (f?.type.kind !== "enum") {
      throw new Error("status field is not an enum");
    }
    expect(f.type.values).toEqual([
      "prospect",
      "active",
      "suspended",
      "churned",
    ]);
  });
});

describe("Invoice entity — shape spot-checks", () => {
  it("invoice_number is unique", () => {
    const f = INVOICE_ENTITY.fields.find((f) => f.name === "invoice_number");
    expect(f?.unique).toBe(true);
  });

  it("state enum has 5 values matching workflow states", () => {
    const f = INVOICE_ENTITY.fields.find((f) => f.name === "state");
    if (f?.type.kind !== "enum") {
      throw new Error("state field is not an enum");
    }
    expect(f.type.values.sort()).toEqual(
      ["draft", "overdue", "paid", "sent", "void"].sort(),
    );
  });

  it("decimal fields have correct precision/scale", () => {
    const totalField = INVOICE_ENTITY.fields.find((f) => f.name === "total");
    if (totalField?.type.kind !== "decimal") {
      throw new Error("total is not a decimal");
    }
    expect(totalField.type.precision).toBe(14);
    expect(totalField.type.scale).toBe(2);
  });
});
