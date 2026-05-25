import { describe, expect, it } from "vitest";
import { ExtendsCycleError, UnknownParentManifestError } from "./errors.js";
import { resolveManifest, type ManifestRegistry } from "./extends.js";
import type { Manifest } from "./types.js";
import { validateManifest } from "./validate.js";

const v = "1.0.0";

function registryFrom(map: Record<string, Manifest>): ManifestRegistry {
  return {
    async getManifest(id) {
      return map[id] ?? null;
    },
  };
}

describe("resolveManifest — no parents", () => {
  it("returns the manifest with extends stripped from meta", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Self", slug: "self", version: v },
      entities: [{ name: "X", fields: [{ name: "a", type: { kind: "text" } }] }],
    };
    const resolved = await resolveManifest(m, { registry: registryFrom({}) });
    expect(resolved.meta.slug).toBe("self");
    expect(resolved.entities).toHaveLength(1);
    expect(resolved.meta.extends).toBeUndefined();
  });

  it("a manifest with an empty extends array also resolves to itself", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Self", slug: "self", version: v, extends: [] },
    };
    const resolved = await resolveManifest(m, { registry: registryFrom({}) });
    expect(resolved.meta.extends).toBeUndefined();
  });
});

describe("resolveManifest — single parent", () => {
  it("inherits entities additively from a parent", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      entities: [{ name: "Parent", fields: [{ name: "a", type: { kind: "text" } }] }],
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
      entities: [{ name: "Child", fields: [{ name: "b", type: { kind: "text" } }] }],
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(resolved.entities?.map((e) => e.name).sort()).toEqual(["Child", "Parent"]);
  });

  it("local entity overrides parent entity with the same name", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      entities: [{ name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] }],
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
      entities: [{ name: "Patient", fields: [{ name: "b", type: { kind: "integer" } }] }],
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(resolved.entities).toHaveLength(1);
    expect(resolved.entities?.[0]?.fields[0]?.name).toBe("b");
  });

  it("strips extends from the resolved meta", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(resolved.meta.extends).toBeUndefined();
  });

  it("preserves the current manifest's meta (not the parent's)", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v, description: "parent desc" },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: {
        name: "Child",
        slug: "child",
        version: v,
        description: "child desc",
        extends: ["base"],
      },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(resolved.meta.name).toBe("Child");
    expect(resolved.meta.slug).toBe("child");
    expect(resolved.meta.description).toBe("child desc");
  });
});

describe("resolveManifest — multi-parent", () => {
  const sharedFrom = (maxLength: number) => ({
    name: "Shared",
    fields: [{ name: "x", type: { kind: "text" as const, maxLength } }],
  });

  it("later parent wins among parents", async () => {
    const p1: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "P1", slug: "p1", version: v },
      entities: [sharedFrom(50)],
    };
    const p2: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "P2", slug: "p2", version: v },
      entities: [sharedFrom(100)],
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["p1", "p2"] },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ p1, p2 }),
    });
    const shared = resolved.entities?.find((e) => e.name === "Shared");
    expect(shared?.fields[0]?.type).toEqual({ kind: "text", maxLength: 100 });
  });

  it("local wins over all parents", async () => {
    const p1: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "P1", slug: "p1", version: v },
      entities: [sharedFrom(50)],
    };
    const p2: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "P2", slug: "p2", version: v },
      entities: [sharedFrom(100)],
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["p1", "p2"] },
      entities: [sharedFrom(200)],
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ p1, p2 }),
    });
    const shared = resolved.entities?.find((e) => e.name === "Shared");
    expect(shared?.fields[0]?.type).toEqual({ kind: "text", maxLength: 200 });
  });
});

describe("resolveManifest — sections", () => {
  it("merges roles record (additive at key level)", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      roles: { staff: { name: "staff" }, manager: { name: "manager" } },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
      roles: { admin: { name: "admin" } },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(Object.keys(resolved.roles ?? {}).sort()).toEqual(["admin", "manager", "staff"]);
  });

  it("local role overrides parent role with the same key", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      roles: { admin: { name: "admin", description: "parent" } },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
      roles: { admin: { name: "admin", description: "child" } },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(resolved.roles?.admin?.description).toBe("child");
  });

  it("merges integrations record (additive at key level)", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      integrations: {
        stripe: {
          kind: "outbound.http",
          auth: { kind: "none" },
          endpoint: "https://api.stripe.com",
          operations: [{ name: "x", method: "GET", path: "/" }],
        },
      },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
      integrations: {
        sendgrid: {
          kind: "outbound.http",
          auth: { kind: "none" },
          endpoint: "https://api.sendgrid.com",
          operations: [{ name: "y", method: "GET", path: "/" }],
        },
      },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(Object.keys(resolved.integrations ?? {}).sort()).toEqual(["sendgrid", "stripe"]);
  });

  it("merges workflows record (additive at key level)", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      workflows: {
        parentFlow: {
          kind: "entityLifecycle",
          entity: "Patient",
          stateField: "status",
          states: [{ name: "x", category: "terminal" }],
          initialState: "x",
          transitions: [],
        },
      },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
      workflows: {
        childFlow: {
          kind: "entityLifecycle",
          entity: "Order",
          stateField: "status",
          states: [{ name: "y", category: "terminal" }],
          initialState: "y",
          transitions: [],
        },
      },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(Object.keys(resolved.workflows ?? {}).sort()).toEqual(["childFlow", "parentFlow"]);
  });

  it("merges jobs record (additive at key level)", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      jobs: {
        "parent-job": {
          id: "parent-job",
          name: "Parent",
          trigger: { kind: "scheduled", cron: "0 6 * * *" },
          onFailure: { strategy: "dead-letter" },
          idempotent: true,
          inputDataClass: "internal",
          outputDataClass: "internal",
        },
      },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
      jobs: {
        "child-job": {
          id: "child-job",
          name: "Child",
          trigger: { kind: "event", eventName: "thing.happened" },
          onFailure: { strategy: "alert-and-dead-letter" },
          idempotent: true,
          inputDataClass: "internal",
          outputDataClass: "internal",
        },
      },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(Object.keys(resolved.jobs ?? {}).sort()).toEqual(["child-job", "parent-job"]);
  });

  it("merges files record (additive at key level)", async () => {
    const baseFile = {
      allowedMimeTypes: ["application/pdf"],
      maxSize: "20MB" as const,
      storage: { bucket: "crossengin-files-eu", prefix: "x/" },
      dataClass: "internal" as const,
    } as unknown as NonNullable<Manifest["files"]>[string];
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      files: { parentScan: baseFile },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
      files: { childScan: baseFile },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(Object.keys(resolved.files ?? {}).sort()).toEqual(["childScan", "parentScan"]);
  });

  it("concatenates relations (additive, no dedup)", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      entities: [
        { name: "A", fields: [{ name: "x", type: { kind: "text" } }] },
        { name: "B", fields: [{ name: "x", type: { kind: "text" } }] },
      ],
      relations: [{ kind: "many_to_one", from: "B", field: "a", to: "A" }],
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
      relations: [{ kind: "many_to_one", from: "B", field: "a2", to: "A" }],
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(resolved.relations).toHaveLength(2);
  });
});

describe("resolveManifest — transitive", () => {
  it("resolves a 3-deep chain A -> B -> C", async () => {
    const c: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "C", slug: "c", version: v },
      entities: [{ name: "FromC", fields: [{ name: "x", type: { kind: "text" } }] }],
    };
    const b: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "B", slug: "b", version: v, extends: ["c"] },
      entities: [{ name: "FromB", fields: [{ name: "x", type: { kind: "text" } }] }],
    };
    const a: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "A", slug: "a", version: v, extends: ["b"] },
      entities: [{ name: "FromA", fields: [{ name: "x", type: { kind: "text" } }] }],
    };
    const resolved = await resolveManifest(a, { registry: registryFrom({ b, c }) });
    expect(resolved.entities?.map((e) => e.name).sort()).toEqual(["FromA", "FromB", "FromC"]);
  });
});

describe("resolveManifest — errors", () => {
  it("throws ExtendsCycleError on a direct A -> B -> A cycle", async () => {
    const a: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "A", slug: "a", version: v, extends: ["b"] },
    };
    const b: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "B", slug: "b", version: v, extends: ["a"] },
    };
    await expect(resolveManifest(a, { registry: registryFrom({ a, b }) })).rejects.toBeInstanceOf(
      ExtendsCycleError,
    );
  });

  it("throws ExtendsCycleError on a longer cycle", async () => {
    const a: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "A", slug: "a", version: v, extends: ["b"] },
    };
    const b: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "B", slug: "b", version: v, extends: ["c"] },
    };
    const c: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "C", slug: "c", version: v, extends: ["a"] },
    };
    await expect(
      resolveManifest(a, { registry: registryFrom({ a, b, c }) }),
    ).rejects.toBeInstanceOf(ExtendsCycleError);
  });

  it("throws UnknownParentManifestError when a parent is missing", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "M", slug: "m", version: v, extends: ["nonexistent"] },
    };
    await expect(resolveManifest(m, { registry: registryFrom({}) })).rejects.toBeInstanceOf(
      UnknownParentManifestError,
    );
  });
});

describe("resolveManifest + validateManifest end-to-end", () => {
  it("a resolved manifest passes validateManifest (cross-section refs resolve via parent)", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      entities: [{ name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] }],
      roles: { pharmacist: { name: "pharmacist" } },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
      entities: [
        {
          name: "Prescription",
          fields: [{ name: "patient", type: { kind: "reference", target: "Patient" } }],
        },
      ],
      permissions: {
        Patient: { read: { roles: ["pharmacist"] } },
      },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(() => validateManifest(resolved)).not.toThrow();
  });
});

describe("resolveManifest — manifestResolution provenance", () => {
  it("attaches manifestResolution.parents when there are parents", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    expect(resolved.meta.manifestResolution).toBeDefined();
    expect(resolved.meta.manifestResolution?.parents).toHaveLength(1);
    expect(resolved.meta.manifestResolution?.parents[0]?.slug).toBe("base");
    expect(resolved.meta.manifestResolution?.parents[0]?.parentId).toBe("base");
  });

  it("omits manifestResolution when no parents are extended", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Solo", slug: "solo", version: v },
    };
    const resolved = await resolveManifest(m, { registry: registryFrom({}) });
    expect(resolved.meta.manifestResolution).toBeUndefined();
  });

  it("records the parent's hash matching manifestHash(parent)", async () => {
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Base", slug: "base", version: v },
      entities: [{ name: "X", fields: [{ name: "a", type: { kind: "text" } }] }],
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Child", slug: "child", version: v, extends: ["base"] },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ base: parent }),
    });
    const { manifestHash } = await import("./hash.js");
    expect(resolved.meta.manifestResolution?.parents[0]?.hash).toBe(manifestHash(parent));
  });

  it("records grandparents in depth-first order (parent first, then its parent)", async () => {
    const grandparent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "GP", slug: "gp", version: v },
    };
    const parent: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "P", slug: "p", version: v, extends: ["gp"] },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "C", slug: "c", version: v, extends: ["p"] },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ p: parent, gp: grandparent }),
    });
    expect(resolved.meta.manifestResolution?.parents.map((p) => p.slug)).toEqual(["p", "gp"]);
  });

  it("records multiple parents in left-to-right order", async () => {
    const p1: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "P1", slug: "p1", version: v },
    };
    const p2: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "P2", slug: "p2", version: v },
    };
    const child: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "C", slug: "c", version: v, extends: ["p1", "p2"] },
    };
    const resolved = await resolveManifest(child, {
      registry: registryFrom({ p1, p2 }),
    });
    expect(resolved.meta.manifestResolution?.parents.map((p) => p.slug)).toEqual(["p1", "p2"]);
  });
});
