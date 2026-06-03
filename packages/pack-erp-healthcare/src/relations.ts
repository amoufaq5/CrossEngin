import type { Relation } from "@crossengin/types/meta-schema";

// Cross-pack: `from` is the core ERP `Account`, proving extension lineage —
// a healthcare-pack relation that resolves only once core is merged in.
export const ACCOUNT_PATIENTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "patients",
  to: "Patient",
  onDelete: "cascade",
};

export const PATIENT_ENCOUNTERS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Patient",
  field: "encounters",
  to: "Encounter",
  onDelete: "cascade",
};

export const ENCOUNTER_OBSERVATIONS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Encounter",
  field: "observations",
  to: "Observation",
  onDelete: "cascade",
};

// Cross-pack: an Encounter optionally bills to a core ERP `Invoice`.
export const ENCOUNTER_INVOICE_RELATION: Relation = {
  kind: "many_to_one",
  from: "Encounter",
  field: "invoice_id",
  to: "Invoice",
  onDelete: "restrict",
};

export const ERP_HEALTHCARE_RELATIONS: readonly Relation[] = [
  ACCOUNT_PATIENTS_RELATION,
  PATIENT_ENCOUNTERS_RELATION,
  ENCOUNTER_OBSERVATIONS_RELATION,
  ENCOUNTER_INVOICE_RELATION,
];
