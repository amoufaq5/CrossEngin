import { describe, expect, it } from "vitest";
import { RelationSchema } from "./relation.js";

describe("RelationSchema", () => {
  it("parses many_to_one with restrict", () => {
    const input = {
      kind: "many_to_one",
      from: "Prescription",
      field: "patient",
      to: "Patient",
      onDelete: "restrict",
    };
    expect(RelationSchema.parse(input)).toEqual(input);
  });

  it("parses many_to_one without onDelete (defaults applied by kernel)", () => {
    const input = {
      kind: "many_to_one",
      from: "Prescription",
      field: "patient",
      to: "Patient",
    };
    expect(RelationSchema.parse(input)).toEqual(input);
  });

  it("parses one_to_many with cascade", () => {
    const input = {
      kind: "one_to_many",
      from: "Patient",
      field: "appointments",
      to: "Appointment",
      onDelete: "cascade",
    };
    expect(RelationSchema.parse(input)).toEqual(input);
  });

  it("parses one_to_many with set_null", () => {
    const input = {
      kind: "one_to_many",
      from: "Prescriber",
      field: "prescriptions",
      to: "Prescription",
      onDelete: "set_null",
    };
    expect(RelationSchema.parse(input)).toEqual(input);
  });

  it("parses many_to_many", () => {
    const input = {
      kind: "many_to_many",
      left: "Doctor",
      right: "Specialty",
    };
    expect(RelationSchema.parse(input)).toEqual(input);
  });

  it("rejects many_to_one with empty target", () => {
    expect(() =>
      RelationSchema.parse({
        kind: "many_to_one",
        from: "Prescription",
        field: "patient",
        to: "",
      }),
    ).toThrow();
  });

  it("rejects many_to_many missing right side", () => {
    expect(() =>
      RelationSchema.parse({ kind: "many_to_many", left: "Doctor" }),
    ).toThrow();
  });

  it("rejects unknown relation kind", () => {
    expect(() =>
      RelationSchema.parse({ kind: "self_referential", from: "X", to: "X" }),
    ).toThrow();
  });

  it("rejects unknown onDelete value", () => {
    expect(() =>
      RelationSchema.parse({
        kind: "many_to_one",
        from: "A",
        field: "b",
        to: "B",
        onDelete: "wipe_everything",
      }),
    ).toThrow();
  });
});
