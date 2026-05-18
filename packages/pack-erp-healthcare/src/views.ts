import {
  ListViewSchema,
  type ListView,
  type ViewDeclaration,
} from "@crossengin/views";

export const PATIENT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Patient",
  label: { en: "Patients" },
  permissions: "inherit",
  sort: [{ field: "mrn", direction: "asc" }],
  columns: [
    { field: "mrn", label: { en: "MRN" } },
    { field: "contact_id", label: { en: "Contact" } },
    { field: "date_of_birth", label: { en: "DOB" } },
    { field: "sex_assigned_at_birth", label: { en: "Sex at birth" } },
    { field: "preferred_language", label: { en: "Language" } },
    { field: "active", label: { en: "Active" } },
  ],
  pageSize: 50,
  exportFormats: ["csv"],
});

export const ENCOUNTER_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Encounter",
  label: { en: "Encounters" },
  permissions: "inherit",
  sort: [{ field: "scheduled_at", direction: "desc" }],
  columns: [
    { field: "patient_id", label: { en: "Patient" } },
    { field: "encounter_class", label: { en: "Class" } },
    { field: "state", label: { en: "State" } },
    { field: "scheduled_at", label: { en: "Scheduled at" } },
    { field: "provider_name", label: { en: "Provider" } },
    { field: "location", label: { en: "Location" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

export const OBSERVATION_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Observation",
  label: { en: "Observations" },
  permissions: "inherit",
  sort: [{ field: "recorded_at", direction: "desc" }],
  columns: [
    { field: "patient_id", label: { en: "Patient" } },
    { field: "encounter_id", label: { en: "Encounter" } },
    { field: "code", label: { en: "Code" } },
    { field: "display_label", label: { en: "Observation" } },
    { field: "value_quantity", label: { en: "Value" } },
    { field: "unit", label: { en: "Unit" } },
    { field: "status", label: { en: "Status" } },
    { field: "recorded_at", label: { en: "Recorded at" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

export const ERP_HEALTHCARE_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "patient.list": PATIENT_LIST_VIEW,
  "encounter.list": ENCOUNTER_LIST_VIEW,
  "observation.list": OBSERVATION_LIST_VIEW,
};
