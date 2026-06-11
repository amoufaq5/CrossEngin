import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

/** A course offering for a core ERP `Account` (the institution). A lifecycle entity. */
export const COURSE_ENTITY: Entity = {
  name: "Course",
  traits: [...AUDITABLE],
  fields: [
    { name: "account_id", type: { kind: "reference", target: "Account" }, required: true, indexed: true },
    { name: "code", type: { kind: "text", maxLength: 32 }, required: true, unique: true },
    { name: "title", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    {
      name: "department",
      type: { kind: "enum", values: ["arts", "sciences", "engineering", "business", "humanities", "other"] },
      required: true,
      default: { kind: "literal", value: "other" },
      indexed: true,
    },
    { name: "credits", type: { kind: "decimal", precision: 4, scale: 1, min: 0 }, required: true },
    { name: "capacity", type: { kind: "integer", min: 0 }, required: true, default: { kind: "literal", value: 30 } },
    { name: "campus", type: { kind: "text", maxLength: 64 }, indexed: true },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "open", "closed", "archived"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["department", "state"] }],
};

/** A student of the institution (core `Account`). Name/email/DOB are PII. */
export const STUDENT_ENTITY: Entity = {
  name: "Student",
  traits: [...AUDITABLE],
  fields: [
    { name: "account_id", type: { kind: "reference", target: "Account" }, required: true, indexed: true },
    { name: "student_number", type: { kind: "text", maxLength: 32 }, required: true, unique: true },
    { name: "given_name", type: { kind: "text", maxLength: 100 }, required: true },
    { name: "family_name", type: { kind: "text", maxLength: 100 }, required: true, indexed: true },
    { name: "email", type: { kind: "email" }, classification: "pii" },
    { name: "date_of_birth", type: { kind: "date" }, classification: "pii" },
    {
      name: "enrollment_status",
      type: { kind: "enum", values: ["prospective", "active", "graduated", "withdrawn"] },
      required: true,
      default: { kind: "literal", value: "prospective" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["account_id", "enrollment_status"] }],
};

/** A student's enrollment in a course — its own lifecycle; the grade is a FERPA record. */
export const ENROLLMENT_ENTITY: Entity = {
  name: "Enrollment",
  traits: [...AUDITABLE],
  fields: [
    { name: "student_id", type: { kind: "reference", target: "Student" }, required: true, indexed: true },
    { name: "course_id", type: { kind: "reference", target: "Course" }, required: true, indexed: true },
    { name: "invoice_id", type: { kind: "reference", target: "Invoice" }, indexed: true },
    { name: "term", type: { kind: "text", maxLength: 20 }, required: true, indexed: true },
    {
      name: "state",
      type: { kind: "enum", values: ["enrolled", "in_progress", "completed", "withdrawn", "failed"] },
      required: true,
      default: { kind: "literal", value: "enrolled" },
      indexed: true,
    },
    {
      name: "grade",
      type: { kind: "text", maxLength: 4 },
      // A grade is a FERPA-protected education record — redacted by default + flagged
      // for at-rest encryption (the regulated path on a non-health domain).
      classification: "regulated",
    },
    { name: "enrolled_at", type: { kind: "datetime" }, indexed: true },
  ],
  indexes: [{ fields: ["course_id", "state"] }],
};

/** Coursework within a course. */
export const ASSIGNMENT_ENTITY: Entity = {
  name: "Assignment",
  traits: [...AUDITABLE],
  fields: [
    { name: "course_id", type: { kind: "reference", target: "Course" }, required: true, indexed: true },
    { name: "title", type: { kind: "text", maxLength: 200 }, required: true },
    {
      name: "category",
      type: { kind: "enum", values: ["homework", "quiz", "exam", "project", "participation"] },
      required: true,
      default: { kind: "literal", value: "homework" },
      indexed: true,
    },
    { name: "due_date", type: { kind: "date" }, indexed: true },
    { name: "max_points", type: { kind: "decimal", precision: 6, scale: 2, min: 0 }, required: true },
    { name: "weight", type: { kind: "decimal", precision: 5, scale: 4, min: 0 } },
  ],
  indexes: [{ fields: ["course_id", "due_date"] }],
};

export const ERP_EDUCATION_ENTITIES: readonly Entity[] = [
  COURSE_ENTITY,
  STUDENT_ENTITY,
  ENROLLMENT_ENTITY,
  ASSIGNMENT_ENTITY,
];
