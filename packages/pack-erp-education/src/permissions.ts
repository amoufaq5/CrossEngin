import type { EntityPermissions } from "@crossengin/auth";

const ALL_EDU = ["edu_admin", "registrar", "instructor", "ferpa_auditor"];
const REGISTRARS = ["edu_admin", "registrar"];
const GRADERS = ["edu_admin", "registrar", "instructor"];
const ADMIN_ONLY = ["edu_admin"];

export const STUDENT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_EDU },
  read: { roles: ALL_EDU },
  create: { roles: REGISTRARS },
  update: { roles: REGISTRARS },
  delete: { roles: ADMIN_ONLY },
};

export const COURSE_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_EDU },
  read: { roles: ALL_EDU },
  create: { roles: REGISTRARS },
  update: { roles: REGISTRARS },
  delete: { roles: ADMIN_ONLY },
};

export const ENROLLMENT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_EDU },
  read: { roles: ALL_EDU },
  create: { roles: GRADERS },
  update: { roles: GRADERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    activate: { roles: GRADERS },
    complete: { roles: GRADERS },
    withdraw: { roles: REGISTRARS },
    fail: { roles: GRADERS },
  },
  // A recorded grade is a FERPA education record — only the registrar +
  // instructor (and admin) may write it; auditors read but never edit.
  fields: {
    grade: {
      read: { roles: ALL_EDU },
      update: { roles: GRADERS },
    },
  },
};

export const ERP_EDUCATION_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Student: STUDENT_PERMISSIONS,
  Course: COURSE_PERMISSIONS,
  Enrollment: ENROLLMENT_PERMISSIONS,
};
