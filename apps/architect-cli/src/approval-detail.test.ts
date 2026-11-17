import { computeManifestDiff, ManifestSchema, type Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import { MAX_APPROVAL_DETAIL_LINES, approvalDetailLines } from "./approval-detail.js";

function manifest(overrides: Record<string, unknown> = {}): Manifest {
  return ManifestSchema.parse({
    manifestVersion: "1.0",
    meta: { name: "Clinic", slug: "acme/clinic", version: "1.0.0" },
    entities: [
      {
        name: "Patient",
        fields: [
          { name: "email", type: { kind: "email" }, classification: "pii" },
          { name: "status", type: { kind: "text" }, required: true, default: { kind: "literal", value: "new" } },
        ],
      },
    ],
    roles: { clerk: { name: "clerk" }, admin: { name: "admin" } },
    permissions: { Patient: { read: { roles: ["clerk"], abac: "own_rows" } } },
    ...overrides,
  });
}

function detail(before: Manifest, after: Manifest): readonly string[] {
  return approvalDetailLines(before, after, computeManifestDiff(before, after));
}

describe("approvalDetailLines", () => {
  it("names a classification move between two sensitive classes, with the storage change", () => {
    const after = manifest();
    const patient = (after.entities ?? [])[0];
    if (patient === undefined) throw new Error("fixture");
    const moved = ManifestSchema.parse({
      ...after,
      entities: [{ ...patient, fields: patient.fields.map((f) => (f.name === "email" ? { ...f, classification: "phi" } : f)) }],
    });
    const lines = detail(manifest(), moved);
    expect(lines).toContain(
      "! classification Patient.email pii → phi (between sensitive; storage moves between ciphertext and plaintext)",
    );
  });

  it("names a required field losing its default, a role's inherits and an obligation removed", () => {
    const before = manifest();
    const patient = (before.entities ?? [])[0];
    if (patient === undefined) throw new Error("fixture");
    const after = ManifestSchema.parse({
      ...before,
      entities: [{ ...patient, fields: patient.fields.map((f) => (f.name === "status" ? { name: "status", type: f.type, required: true } : f)) }],
      roles: { clerk: { name: "clerk", inherits: ["admin"] }, admin: { name: "admin" } },
      permissions: { Patient: { read: { roles: ["clerk"] } } },
    });
    const lines = detail(before, after);
    expect(lines).toContain(
      '~ default Patient.status literal "new" → none; required, so a create omitting it is refused',
    );
    expect(lines).toContain("! role clerk now inherits admin");
    expect(lines).toContain("! abac Patient read: own_rows → none (the grant becomes unconditional)");
    expect(lines.some((l) => l.startsWith("  section roles"))).toBe(true);
    expect(lines.some((l) => l.startsWith("  section permissions"))).toBe(true);
  });

  it("is empty for an unchanged manifest", () => {
    expect(detail(manifest(), manifest())).toEqual([]);
  });

  it("names the sections of a new file, where there is nothing to compare field by field", () => {
    const lines = approvalDetailLines(null, manifest(), null);
    expect(lines).toContain("  section entities: +Patient");
    expect(lines.some((l) => l.startsWith("!"))).toBe(false);
  });

  it("caps the list and counts what it did not print", () => {
    const many = Array.from({ length: MAX_APPROVAL_DETAIL_LINES + 10 }, (_, i) => ({
      name: `E${i.toString()}`,
      fields: [{ name: "x", type: { kind: "text" } }],
    }));
    const lines = detail(manifest(), manifest({ entities: many }));
    expect(lines).toHaveLength(MAX_APPROVAL_DETAIL_LINES);
    expect(lines[lines.length - 1]).toMatch(/^ {2}… \d+ more$/);
  });
});
