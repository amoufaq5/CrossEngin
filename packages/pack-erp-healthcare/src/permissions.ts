import type { EntityPermissions } from "@crossengin/auth";

const ALL_CLINICAL = ["clinical_admin", "clinician", "front_desk", "hipaa_auditor"];
const CLINICAL_STAFF = ["clinical_admin", "clinician"];
const SCHEDULERS = ["clinical_admin", "clinician", "front_desk"];
const ADMIN_ONLY = ["clinical_admin"];

// The read set for every field the front desk is withheld from. Derived from CLINICAL_STAFF rather
// than retyped, so `update: CLINICAL_STAFF ⊆ read` holds by construction on all five of them.
const CLINICAL_STAFF_AND_AUDITOR = [...CLINICAL_STAFF, "hipaa_auditor"];

export const PATIENT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CLINICAL },
  read: { roles: ALL_CLINICAL },
  create: { roles: SCHEDULERS },
  update: { roles: SCHEDULERS },
  delete: { roles: ADMIN_ONLY },
  fields: {
    // The registrar sets the number they were handed on paper and can neither read it back nor
    // overwrite it afterwards — a blind overwrite would destroy an identifier they cannot see.
    mrn: {
      read: { roles: CLINICAL_STAFF_AND_AUDITOR },
      update: { roles: CLINICAL_STAFF },
      create: { roles: SCHEDULERS },
    },
    // Demographics keep front_desk on both arms: the desk greets the patient and verifies identity
    // by date of birth, so withholding these would break reception rather than protect anyone.
    given_name: { read: { roles: ALL_CLINICAL }, update: { roles: SCHEDULERS } },
    family_name: { read: { roles: ALL_CLINICAL }, update: { roles: SCHEDULERS } },
    date_of_birth: { read: { roles: ALL_CLINICAL }, update: { roles: SCHEDULERS } },
    // Set at registration, corrected only clinically — mrn's shape on a clinical attribute.
    sex: {
      read: { roles: CLINICAL_STAFF_AND_AUDITOR },
      update: { roles: CLINICAL_STAFF },
      create: { roles: SCHEDULERS },
    },
    email: { read: { roles: ALL_CLINICAL }, update: { roles: SCHEDULERS } },
    phone: { read: { roles: ALL_CLINICAL }, update: { roles: SCHEDULERS } },
  },
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
  fields: {
    // The complaint is clinical narrative, not scheduling data, so the desk that books the visit
    // does not see it. Nothing is lost at create: the field is optional.
    chief_complaint: {
      read: { roles: CLINICAL_STAFF_AND_AUDITOR },
      update: { roles: CLINICAL_STAFF },
    },
  },
};

// Observations carry PHI: only clinical staff may write; auditors read.
export const OBSERVATION_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CLINICAL },
  read: { roles: ALL_CLINICAL },
  create: { roles: CLINICAL_STAFF },
  update: { roles: CLINICAL_STAFF },
  delete: { roles: ADMIN_ONLY },
  fields: {
    value_quantity: {
      read: { roles: CLINICAL_STAFF_AND_AUDITOR },
      update: { roles: CLINICAL_STAFF },
    },
    value_text: {
      read: { roles: CLINICAL_STAFF_AND_AUDITOR },
      update: { roles: CLINICAL_STAFF },
    },
  },
};

export const ERP_HEALTHCARE_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Patient: PATIENT_PERMISSIONS,
  Encounter: ENCOUNTER_PERMISSIONS,
  Observation: OBSERVATION_PERMISSIONS,
};
