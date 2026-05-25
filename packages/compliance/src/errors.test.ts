import { describe, expect, it } from "vitest";
import { CollisionError, PackParameterError, UnknownPackError } from "./errors.js";

describe("UnknownPackError", () => {
  it("is an Error subclass with the right name", () => {
    const err = new UnknownPackError("hipaa");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UnknownPackError");
  });

  it("includes the pack id in the message", () => {
    const err = new UnknownPackError("hipaa");
    expect(err.message).toBe("compliance pack 'hipaa' not found in registry");
  });

  it("exposes the pack id", () => {
    const err = new UnknownPackError("uae-moh");
    expect(err.packId).toBe("uae-moh");
  });
});

describe("CollisionError", () => {
  it("is an Error subclass with the right name", () => {
    const err = new CollisionError("hipaa", "entity", "patient_record");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CollisionError");
  });

  it("includes all three identifiers in the message", () => {
    const err = new CollisionError("hipaa", "entity", "patient_record");
    expect(err.message).toContain("hipaa");
    expect(err.message).toContain("entity");
    expect(err.message).toContain("patient_record");
    expect(err.message).toContain("already exists");
  });

  it("exposes packId, kind, itemName", () => {
    const err = new CollisionError("gdpr", "role", "data_protection_officer");
    expect(err.packId).toBe("gdpr");
    expect(err.kind).toBe("role");
    expect(err.itemName).toBe("data_protection_officer");
  });
});

describe("PackParameterError", () => {
  it("is an Error subclass with the right name", () => {
    const err = new PackParameterError("hipaa", "min_password_length", "must be >= 12");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PackParameterError");
  });

  it("includes pack id, parameter name, and message", () => {
    const err = new PackParameterError("hipaa", "audit_retention_years", "must be >= 7");
    expect(err.message).toBe(
      "compliance pack 'hipaa' parameter 'audit_retention_years': must be >= 7",
    );
  });

  it("exposes packId and parameterName", () => {
    const err = new PackParameterError("gdpr", "consent_required", "must be a boolean");
    expect(err.packId).toBe("gdpr");
    expect(err.parameterName).toBe("consent_required");
  });
});
