import { EntitySchema } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";
import {
  COURSE_ENTITY,
  ENROLLMENT_ENTITY,
  ERP_EDUCATION_ENTITIES,
  STUDENT_ENTITY,
} from "./entities.js";

describe("education entities", () => {
  it("all parse against the kernel EntitySchema", () => {
    for (const e of ERP_EDUCATION_ENTITIES) {
      expect(() => EntitySchema.parse(e)).not.toThrow();
    }
  });

  it("puts the classified entities (Student, Enrollment) on the auditable trait", () => {
    expect(STUDENT_ENTITY.traits).toContain("auditable");
    expect(ENROLLMENT_ENTITY.traits).toContain("auditable");
    // Course carries no classified field, so it is not auditable.
    expect(COURSE_ENTITY.traits ?? []).not.toContain("auditable");
  });

  it("classifies the student email + DOB as PII", () => {
    expect(STUDENT_ENTITY.fields.find((f) => f.name === "student_email")?.classification).toBe(
      "pii",
    );
    expect(STUDENT_ENTITY.fields.find((f) => f.name === "date_of_birth")?.classification).toBe(
      "pii",
    );
  });

  it("classifies the recorded grade as a PII education record", () => {
    expect(ENROLLMENT_ENTITY.fields.find((f) => f.name === "grade")?.classification).toBe("pii");
  });

  it("Student references the core Account; Enrollment references Student + Course", () => {
    expect(STUDENT_ENTITY.fields.find((f) => f.name === "account_id")?.type).toEqual({
      kind: "reference",
      target: "Account",
    });
    expect(ENROLLMENT_ENTITY.fields.find((f) => f.name === "student_id")?.type).toEqual({
      kind: "reference",
      target: "Student",
    });
    expect(ENROLLMENT_ENTITY.fields.find((f) => f.name === "course_id")?.type).toEqual({
      kind: "reference",
      target: "Course",
    });
  });

  it("does not require encryption/audit-only classes (no phi/regulated)", () => {
    const classes = ERP_EDUCATION_ENTITIES.flatMap((e) =>
      e.fields.map((f) => f.classification).filter((c) => c !== undefined),
    );
    expect(classes).not.toContain("phi");
    expect(classes).not.toContain("regulated");
  });
});
