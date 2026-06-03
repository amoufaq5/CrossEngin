import type { EntityPermissions } from "@crossengin/auth";

const ALL_CLINICAL = ["clinical_admin", "clinician", "front_desk", "hipaa_auditor"];
const CLINICAL_STAFF = ["clinical_admin", "clinician"];
const SCHEDULERS = ["clinical_admin", "clinician", "front_desk"];
const ADMIN_ONLY = ["clinical_admin"];

export const PATIENT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CLINICAL },
  read: { roles: ALL_CLINICAL },
  create: { roles: SCHEDULERS },
  update: { roles: SCHEDULERS },
  delete: { roles: ADMIN_ONLY },
};

export const ENCOUNTER_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CLINICAL },
  read: { roles: ALL_CLINICAL },
  create: { roles: SCHEDULERS },
  update: { roles: CLINICAL_STAFF },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    check_in: { roles: SCHEDULERS },
    complete: { roles: CLINICAL_STAFF },
    cancel: { roles: SCHEDULERS },
    mark_no_show: { roles: SCHEDULERS },
  },
};

// Observations carry PHI: only clinical staff may write; auditors read.
export const OBSERVATION_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CLINICAL },
  read: { roles: ALL_CLINICAL },
  create: { roles: CLINICAL_STAFF },
  update: { roles: CLINICAL_STAFF },
  delete: { roles: ADMIN_ONLY },
};

export const ERP_HEALTHCARE_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Patient: PATIENT_PERMISSIONS,
  Encounter: ENCOUNTER_PERMISSIONS,
  Observation: OBSERVATION_PERMISSIONS,
};
