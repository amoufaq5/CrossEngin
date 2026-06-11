import type { Relation } from "@crossengin/types/meta-schema";

// Cross-pack: `from` is the core ERP `Account` (the institution).
export const ACCOUNT_COURSES_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "courses",
  to: "Course",
  onDelete: "cascade",
};

export const ACCOUNT_STUDENTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "students",
  to: "Student",
  onDelete: "cascade",
};

export const COURSE_ENROLLMENTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Course",
  field: "enrollments",
  to: "Enrollment",
  onDelete: "cascade",
};

export const STUDENT_ENROLLMENTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Student",
  field: "enrollments",
  to: "Enrollment",
  onDelete: "cascade",
};

export const COURSE_ASSIGNMENTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Course",
  field: "assignments",
  to: "Assignment",
  onDelete: "cascade",
};

// Cross-pack: an Enrollment optionally bills tuition to a core ERP `Invoice`.
export const ENROLLMENT_INVOICE_RELATION: Relation = {
  kind: "many_to_one",
  from: "Enrollment",
  field: "invoice_id",
  to: "Invoice",
  onDelete: "restrict",
};

export const ERP_EDUCATION_RELATIONS: readonly Relation[] = [
  ACCOUNT_COURSES_RELATION,
  ACCOUNT_STUDENTS_RELATION,
  COURSE_ENROLLMENTS_RELATION,
  STUDENT_ENROLLMENTS_RELATION,
  COURSE_ASSIGNMENTS_RELATION,
  ENROLLMENT_INVOICE_RELATION,
];
