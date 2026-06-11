import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_EDUCATION_ADMIN: RoleDefinition = {
  name: "education_admin",
  label: { en: "Education Administrator" },
  description: "Full CRUD on courses, students, enrollments, and assignments, including PII + grades.",
};

export const ROLE_REGISTRAR: RoleDefinition = {
  name: "registrar",
  label: { en: "Registrar" },
  description: "Manages students + enrollments + course catalog; sees student PII and grades.",
};

export const ROLE_INSTRUCTOR: RoleDefinition = {
  name: "instructor",
  label: { en: "Instructor" },
  description: "Manages their courses + assignments and grades enrollments; sees grades but not student contact PII.",
};

export const ROLE_ADVISOR: RoleDefinition = {
  name: "advisor",
  label: { en: "Student Advisor" },
  description: "Reads students + enrollments for advising; sees student PII but not the FERPA grade record.",
};

export const ERP_EDUCATION_ROLES: Readonly<Record<string, RoleDefinition>> = {
  education_admin: ROLE_EDUCATION_ADMIN,
  registrar: ROLE_REGISTRAR,
  instructor: ROLE_INSTRUCTOR,
  advisor: ROLE_ADVISOR,
};
