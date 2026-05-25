import { describe, expect, it } from "vitest";
import type { Manifest } from "./types.js";
import { tryValidateManifest } from "./try-validate.js";

const baseMeta = { name: "T", slug: "t", version: "1.0.0" } as const;

describe("tryValidateManifest", () => {
  it("returns { ok: true } for a valid manifest", () => {
    const m: Manifest = { manifestVersion: "1.0", meta: baseMeta };
    expect(tryValidateManifest(m)).toEqual({ ok: true });
  });

  it("returns { ok: false, errors } for a manifest with a duplicate entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "X", fields: [{ name: "a", type: { kind: "text" } }] },
        { name: "X", fields: [{ name: "b", type: { kind: "text" } }] },
      ],
    };
    const result = tryValidateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.path).toBe("entities[1].name");
      expect(result.errors[0]?.message).toMatch(/duplicate/);
    }
  });

  it("returns { ok: false } when reference targets an unknown entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Prescription",
          fields: [{ name: "patient", type: { kind: "reference", target: "Patient" } }],
        },
      ],
    };
    const result = tryValidateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("returns { ok: false } when a permission grants an unknown role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] }],
      roles: { pharmacist: { name: "pharmacist" } },
      permissions: {
        Prescription: { read: { roles: ["mystery"] } },
      },
    };
    const result = tryValidateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toMatch(/role 'mystery'/);
    }
  });

  it("returns { ok: false } with the workflow error path on workflow validation failure", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] }],
      workflows: {
        lifecycle: {
          kind: "entityLifecycle",
          entity: "Prescription",
          stateField: "status",
          states: [{ name: "pending" }],
          initialState: "mystery",
          transitions: [],
        },
      },
    };
    const result = tryValidateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("workflows.lifecycle.initialState");
    }
  });
});
