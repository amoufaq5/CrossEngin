import type { Relation } from "@crossengin/types/meta-schema";

export const ACCOUNT_PATIENTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "patients",
  to: "Patient",
  onDelete: "restrict",
};

export const PATIENT_ENCOUNTERS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Patient",
  field: "encounters",
  to: "Encounter",
  onDelete: "restrict",
};

export const ENCOUNTER_OBSERVATIONS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Encounter",
  field: "observations",
  to: "Observation",
  onDelete: "cascade",
};

export const ERP_HEALTHCARE_RELATIONS: readonly Relation[] = [
  ACCOUNT_PATIENTS_RELATION,
  PATIENT_ENCOUNTERS_RELATION,
  ENCOUNTER_OBSERVATIONS_RELATION,
];
