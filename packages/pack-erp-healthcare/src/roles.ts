import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_CLINICAL_ADMIN: RoleDefinition = {
  name: "clinical_admin",
  label: { en: "Clinical Administrator" },
  description: "Full CRUD on patients, encounters, and observations.",
};

export const ROLE_CLINICIAN: RoleDefinition = {
  name: "clinician",
  label: { en: "Clinician" },
  description:
    "Reads patients, runs encounters, and records observations (PHI).",
};

export const ROLE_FRONT_DESK: RoleDefinition = {
  name: "front_desk",
  label: { en: "Front Desk" },
  description: "Schedules encounters and manages patient demographics.",
};

export const ROLE_HIPAA_AUDITOR: RoleDefinition = {
  name: "hipaa_auditor",
  label: { en: "HIPAA Auditor" },
  description: "Read-only access to clinical records for compliance review.",
};

export const ERP_HEALTHCARE_ROLES: Readonly<Record<string, RoleDefinition>> = {
  clinical_admin: ROLE_CLINICAL_ADMIN,
  clinician: ROLE_CLINICIAN,
  front_desk: ROLE_FRONT_DESK,
  hipaa_auditor: ROLE_HIPAA_AUDITOR,
};
