import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_EDU_ADMIN: RoleDefinition = {
  name: "edu_admin",
  label: { en: "Education Administrator" },
  description: "Full CRUD on students, courses, and enrollments, including grades.",
};

export const ROLE_REGISTRAR: RoleDefinition = {
  name: "registrar",
  label: { en: "Registrar" },
  description: "Manages student records, course catalog, and enrollments; records grades.",
};

export const ROLE_INSTRUCTOR: RoleDefinition = {
  name: "instructor",
  label: { en: "Instructor" },
  description:
    "Manages enrollments for their courses and posts grades; reads student directory info.",
};

export const ROLE_FERPA_AUDITOR: RoleDefinition = {
  name: "ferpa_auditor",
  label: { en: "FERPA Auditor" },
  description: "Read-only access to students, courses, and enrollments for compliance review.",
};

export const ERP_EDUCATION_ROLES: Readonly<Record<string, RoleDefinition>> = {
  edu_admin: ROLE_EDU_ADMIN,
  registrar: ROLE_REGISTRAR,
  instructor: ROLE_INSTRUCTOR,
  ferpa_auditor: ROLE_FERPA_AUDITOR,
};
