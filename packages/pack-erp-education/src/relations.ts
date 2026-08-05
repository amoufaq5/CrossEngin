import type { Relation } from "@crossengin/types/meta-schema";

// Cross-pack: `from` is the core ERP `Account` (the institution / sponsor).
export const ACCOUNT_STUDENTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "students",
  to: "Student",
  onDelete: "cascade",
};

export const STUDENT_ENROLLMENTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Student",
  field: "enrollments",
  to: "Enrollment",
  onDelete: "cascade",
};

export const COURSE_ENROLLMENTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Course",
  field: "enrollments",
  to: "Enrollment",
  onDelete: "restrict",
};

export const ERP_EDUCATION_RELATIONS: readonly Relation[] = [
  ACCOUNT_STUDENTS_RELATION,
  STUDENT_ENROLLMENTS_RELATION,
  COURSE_ENROLLMENTS_RELATION,
];
