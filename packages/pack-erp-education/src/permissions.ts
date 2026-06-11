import type { EntityPermissions } from "@crossengin/auth";

const ALL = ["education_admin", "registrar", "instructor", "advisor"];
const MANAGERS = ["education_admin", "registrar"];
const INSTRUCTORS = ["education_admin", "registrar", "instructor"];
const PII_READERS = ["education_admin", "registrar", "advisor"];
const ADMIN_ONLY = ["education_admin"];

export const COURSE_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL },
  read: { roles: ALL },
  create: { roles: INSTRUCTORS },
  update: { roles: INSTRUCTORS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    publish: { roles: MANAGERS },
    close: { roles: MANAGERS },
    archive: { roles: MANAGERS },
  },
};

export const STUDENT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL },
  read: { roles: ALL },
  create: { roles: MANAGERS },
  update: { roles: MANAGERS },
  delete: { roles: ADMIN_ONLY },
  // PII contact + DOB are readable by admin/registrar/advisor — redacted from
  // instructors (who see students by name, not contact details).
  fields: {
    email: { read: { roles: PII_READERS }, update: { roles: MANAGERS } },
    date_of_birth: { read: { roles: PII_READERS }, update: { roles: MANAGERS } },
  },
};

export const ENROLLMENT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL },
  read: { roles: ALL },
  create: { roles: INSTRUCTORS },
  update: { roles: INSTRUCTORS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    begin: { roles: INSTRUCTORS },
    complete: { roles: INSTRUCTORS },
    fail: { roles: INSTRUCTORS },
    withdraw: { roles: MANAGERS },
  },
  // The FERPA grade is graded + read by admin/registrar/instructor — redacted from
  // advisors (who advise on progress, not the graded record).
  fields: {
    grade: { read: { roles: INSTRUCTORS }, update: { roles: INSTRUCTORS } },
  },
};

export const ASSIGNMENT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL },
  read: { roles: ALL },
  create: { roles: INSTRUCTORS },
  update: { roles: INSTRUCTORS },
  delete: { roles: INSTRUCTORS },
};

export const ERP_EDUCATION_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Course: COURSE_PERMISSIONS,
  Student: STUDENT_PERMISSIONS,
  Enrollment: ENROLLMENT_PERMISSIONS,
  Assignment: ASSIGNMENT_PERMISSIONS,
};
