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
  sort: [{ field: "family_name", direction: "asc" }],
  columns: [
    { field: "mrn", label: { en: "MRN" } },
    { field: "family_name", label: { en: "Family name" } },
    { field: "given_name", label: { en: "Given name" } },
    { field: "date_of_birth", label: { en: "DOB" } },
    { field: "status", label: { en: "Status" } },
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
    { field: "encounter_number", label: { en: "Number" } },
    { field: "patient_id", label: { en: "Patient" } },
    { field: "state", label: { en: "State" } },
    { field: "encounter_type", label: { en: "Type" } },
    { field: "scheduled_at", label: { en: "Scheduled" } },
    { field: "provider_name", label: { en: "Provider" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

export const ERP_HEALTHCARE_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "patient.list": PATIENT_LIST_VIEW,
  "encounter.list": ENCOUNTER_LIST_VIEW,
};
