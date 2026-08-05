import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const STUDENT_ENTITY: Entity = {
  name: "Student",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "account_id",
      type: { kind: "reference", target: "Account" },
      required: true,
      indexed: true,
    },
    {
      name: "student_number",
      type: { kind: "text", maxLength: 32 },
      required: true,
      unique: true,
    },
    { name: "full_name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    {
      name: "student_email",
      type: { kind: "email" },
      required: true,
      // Directory contact info — PII under FERPA.
      classification: "pii",
    },
    {
      name: "date_of_birth",
      type: { kind: "date" },
      required: true,
      classification: "pii",
    },
    { name: "enrollment_year", type: { kind: "integer", min: 1900, max: 2200 }, required: true, indexed: true },
    {
      name: "status",
      type: { kind: "enum", values: ["active", "inactive", "graduated", "withdrawn"] },
      required: true,
      default: { kind: "literal", value: "active" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["account_id", "status"] }, { fields: ["full_name"] }],
};

export const COURSE_ENTITY: Entity = {
  name: "Course",
  traits: [],
  fields: [
    {
      name: "course_code",
      type: { kind: "text", maxLength: 32 },
      required: true,
      unique: true,
    },
    { name: "title", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    { name: "credits", type: { kind: "integer", min: 0, max: 12 }, required: true },
    {
      name: "department",
      type: {
        kind: "enum",
        values: ["arts", "sciences", "engineering", "business", "humanities", "other"],
      },
      required: true,
      default: { kind: "literal", value: "other" },
      indexed: true,
    },
    {
      name: "status",
      type: { kind: "enum", values: ["active", "archived"] },
      required: true,
      default: { kind: "literal", value: "active" },
    },
  ],
  indexes: [{ fields: ["department", "status"] }],
};

export const ENROLLMENT_ENTITY: Entity = {
  name: "Enrollment",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "student_id",
      type: { kind: "reference", target: "Student" },
      required: true,
      indexed: true,
    },
    {
      name: "course_id",
      type: { kind: "reference", target: "Course" },
      required: true,
      indexed: true,
    },
    {
      name: "enrollment_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
    },
    {
      name: "term",
      type: { kind: "enum", values: ["fall", "spring", "summer", "winter"] },
      required: true,
      indexed: true,
    },
    {
      name: "grade",
      type: { kind: "text", maxLength: 4 },
      // A recorded grade is a FERPA education record — PII, restricted to
      // registrar + instructor writes (see permissions.ts).
      classification: "pii",
    },
    {
      name: "status",
      type: {
        kind: "enum",
        values: ["enrolled", "active", "completed", "withdrawn", "failed"],
      },
      required: true,
      default: { kind: "literal", value: "enrolled" },
      indexed: true,
    },
    { name: "enrolled_at", type: { kind: "datetime" }, required: true, indexed: true },
  ],
  indexes: [{ fields: ["status", "term"] }],
};

const EDUCATION_MODULES: Readonly<Record<string, string>> = {
  Student: "Student Information",
  Course: "Academics",
  Enrollment: "Academics",
};

export const ERP_EDUCATION_ENTITIES: readonly Entity[] = [
  STUDENT_ENTITY,
  COURSE_ENTITY,
  ENROLLMENT_ENTITY,
].map((e) =>
  EDUCATION_MODULES[e.name] !== undefined ? { ...e, module: EDUCATION_MODULES[e.name] } : e,
);
