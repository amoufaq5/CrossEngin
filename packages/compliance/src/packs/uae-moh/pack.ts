import type { CompliancePack } from "../../types.js";

export const pack: CompliancePack = {
  meta: {
    id: "uae-moh",
    title: "UAE MoHAP — Ministry of Health and Prevention Guidelines",
    version: "1.0.0",
    regulator: "UAE Ministry of Health and Prevention (MoHAP) + DHA + DoH-AD",
    appliesTo: {
      industries: [
        "healthcare-providers",
        "pharma",
        "medical-devices",
        "laboratories",
        "telehealth",
      ],
      families: ["operate-pharma-healthcare", "heal"],
    },
    parameters: {
      dataResidency: {
        type: "enum",
        values: ["uae-mainland", "difc", "adgm"],
        default: "uae-mainland",
        required: true,
        helpText:
          "Jurisdiction where health data is hosted at rest. Federal Law No. 2 of 2019 (ICT in Healthcare) requires UAE residency unless explicit MoHAP authorisation permits otherwise.",
      },
      mohRegistrationNumber: {
        type: "string",
        required: true,
        helpText:
          "MoHAP / DHA / DoH facility registration number. Stamped on every patient-facing document.",
      },
      facilityType: {
        type: "enum",
        values: [
          "hospital",
          "polyclinic",
          "specialty_clinic",
          "pharmacy",
          "laboratory",
          "diagnostic_center",
          "telehealth_provider",
        ],
        required: true,
        helpText:
          "Category of licensed healthcare facility. Drives applicable section of MoHAP standards.",
      },
      clinicalRecordRetentionYears: {
        type: "integer",
        min: 25,
        default: 25,
        helpText:
          "Minimum retention period for clinical records. UAE MoHAP guidance: 25 years for adult records; lifetime for paediatric. Use minimum 25 here; per-entity overrides apply for paediatrics.",
      },
      bilingualClinicalDocumentation: {
        type: "boolean",
        default: true,
        helpText:
          "Whether patient-facing clinical documentation must exist in Arabic and English. Required for consent forms; recommended for discharge summaries.",
      },
      practitionerLicenseVerificationRequired: {
        type: "boolean",
        default: true,
        helpText:
          "Whether practitioner licence status must be verified against the MoHAP/DHA/DoH register before each privileged clinical action.",
      },
      medicalDirectorName: {
        type: "string",
        required: true,
        helpText:
          "Licensed medical director accountable for clinical governance. Must hold an active MoHAP/DHA/DoH licence.",
      },
      qualityOfficerName: {
        type: "string",
        required: true,
        helpText:
          "Designated quality officer responsible for adverse-event reporting to the regulator.",
      },
    },
  },
  contributions: {
    entities: [
      {
        name: "PractitionerLicense",
        fields: [
          { name: "practitioner_id", type: { kind: "uuid" }, required: true },
          {
            name: "license_number",
            type: { kind: "text", maxLength: 64 },
            required: true,
            unique: true,
          },
          {
            name: "issuing_authority",
            type: {
              kind: "enum",
              values: ["mohap", "dha", "doh_ad", "sehha"],
            },
            required: true,
          },
          {
            name: "license_kind",
            type: {
              kind: "enum",
              values: [
                "physician",
                "nurse",
                "pharmacist",
                "dentist",
                "specialist_consultant",
                "allied_health",
                "technician",
              ],
            },
            required: true,
          },
          { name: "specialty", type: { kind: "text", maxLength: 128 } },
          { name: "issued_date", type: { kind: "date" }, required: true },
          { name: "expiry_date", type: { kind: "date" }, required: true },
          {
            name: "verification_status",
            type: {
              kind: "enum",
              values: ["verified", "pending", "expired", "suspended", "revoked"],
            },
            required: true,
            default: { kind: "literal", value: "pending" },
          },
          { name: "verified_at", type: { kind: "datetime" } },
        ],
        traits: ["auditable"],
      },
      {
        name: "ClinicalEncounter",
        fields: [
          { name: "patient_id", type: { kind: "uuid" }, required: true },
          { name: "practitioner_id", type: { kind: "uuid" }, required: true },
          {
            name: "encounter_date",
            type: { kind: "datetime" },
            required: true,
          },
          {
            name: "encounter_kind",
            type: {
              kind: "enum",
              values: ["outpatient", "inpatient", "emergency", "telehealth", "home_visit"],
            },
            required: true,
          },
          { name: "chief_complaint_en", type: { kind: "long_text" }, required: true },
          { name: "chief_complaint_ar", type: { kind: "long_text" }, required: true },
          { name: "diagnosis_codes", type: { kind: "json" }, required: true },
          {
            name: "is_paediatric",
            type: { kind: "boolean" },
            required: true,
            default: { kind: "literal", value: false },
          },
          {
            name: "consent_obtained",
            type: { kind: "boolean" },
            required: true,
            default: { kind: "literal", value: false },
          },
        ],
        traits: ["auditable"],
      },
      {
        name: "FacilityRegistration",
        fields: [
          {
            name: "facility_kind",
            type: {
              kind: "enum",
              values: [
                "hospital",
                "polyclinic",
                "specialty_clinic",
                "pharmacy",
                "laboratory",
                "diagnostic_center",
                "telehealth_provider",
              ],
            },
            required: true,
          },
          {
            name: "moh_registration_number",
            type: { kind: "text", maxLength: 64 },
            required: true,
            unique: true,
          },
          { name: "license_expiry", type: { kind: "date" }, required: true },
          {
            name: "medical_director_name",
            type: { kind: "text", maxLength: 256 },
            required: true,
          },
          {
            name: "data_residency_jurisdiction",
            type: {
              kind: "enum",
              values: ["uae-mainland", "difc", "adgm"],
            },
            required: true,
          },
          { name: "registered_at", type: { kind: "date" }, required: true },
          {
            name: "status",
            type: {
              kind: "enum",
              values: ["active", "pending_renewal", "suspended", "deregistered"],
            },
            required: true,
            default: { kind: "literal", value: "active" },
          },
        ],
        traits: ["auditable"],
      },
      {
        name: "AdverseEventReport",
        fields: [
          { name: "encounter_id", type: { kind: "uuid" }, required: true },
          {
            name: "event_kind",
            type: {
              kind: "enum",
              values: [
                "medication_error",
                "device_failure",
                "near_miss",
                "fall",
                "hospital_acquired_infection",
                "procedural_complication",
                "other",
              ],
            },
            required: true,
          },
          { name: "occurred_at", type: { kind: "datetime" }, required: true },
          { name: "discovered_at", type: { kind: "datetime" }, required: true },
          {
            name: "severity",
            type: {
              kind: "enum",
              values: ["minor", "moderate", "severe", "sentinel"],
            },
            required: true,
          },
          { name: "description", type: { kind: "long_text" }, required: true },
          {
            name: "reported_to_regulator_at",
            type: { kind: "datetime" },
          },
          {
            name: "status",
            type: {
              kind: "enum",
              values: ["draft", "under_review", "reported", "closed"],
            },
            required: true,
            default: { kind: "literal", value: "draft" },
          },
        ],
        traits: ["auditable"],
      },
    ],
    traits: [
      {
        name: "uae_clinical_record",
        fields: [
          {
            name: "data_class",
            type: { kind: "text", maxLength: 32 },
            required: true,
            default: { kind: "literal", value: "phi" },
          },
          {
            name: "retention_minimum_years",
            type: { kind: "integer", min: 25 },
            required: true,
            default: { kind: "literal", value: 25 },
          },
          {
            name: "residency_jurisdiction",
            type: {
              kind: "enum",
              values: ["uae-mainland", "difc", "adgm"],
            },
            required: true,
            default: { kind: "literal", value: "uae-mainland" },
          },
          {
            name: "language_arabic_required",
            type: { kind: "boolean" },
            required: true,
            default: { kind: "literal", value: true },
          },
        ],
      },
    ],
  },
};
