import type { CompliancePack } from "../../types.js";

export const pack: CompliancePack = {
  meta: {
    id: "gdpr",
    title: "GDPR — General Data Protection Regulation (EU 2016/679)",
    version: "1.0.0",
    regulator: "European Data Protection Board / National Supervisory Authorities (EU)",
    appliesTo: {
      industries: [
        "any-eu-data-subject-processing",
        "saas",
        "healthcare-providers",
        "pharma",
        "ngo",
        "education",
        "government",
      ],
      families: ["operate-pharma-healthcare", "heal", "operate-edu", "operate-public"],
    },
    parameters: {
      dpoName: {
        type: "string",
        required: true,
        helpText:
          "Full name of the Data Protection Officer. Required where Article 37 conditions apply (public authority, large-scale monitoring, special categories).",
      },
      dpoEmail: {
        type: "string",
        required: true,
        helpText:
          "Public contact email for the Data Protection Officer. Must be published in privacy notices per Article 13(1)(b).",
      },
      legalBasis: {
        type: "enum",
        values: [
          "consent",
          "contract",
          "legal_obligation",
          "vital_interests",
          "public_task",
          "legitimate_interests",
        ],
        default: "contract",
        helpText:
          "Primary lawful basis for processing per Article 6(1). Individual processing activities may rely on a different basis recorded on each DataProcessingActivity.",
      },
      dataSubjectRequestResponseDays: {
        type: "integer",
        min: 1,
        max: 30,
        default: 30,
        helpText:
          "Days to respond to a data subject request (access, erasure, rectification, portability). Maximum one month per Article 12(3); extendable by two further months for complex requests.",
      },
      breachNotificationHours: {
        type: "integer",
        min: 1,
        max: 72,
        default: 72,
        helpText:
          "Hours from breach discovery to notify the supervisory authority. Maximum 72 per Article 33(1).",
      },
      requireConsentForCookies: {
        type: "boolean",
        default: true,
        helpText:
          "Require explicit opt-in for non-essential cookies and similar trackers per ePrivacy Directive + EDPB guidelines.",
      },
      allowInternationalTransfers: {
        type: "boolean",
        default: false,
        helpText:
          "Whether personal data may be transferred outside the EEA. If true, the DataProcessingActivity records must declare safeguards under Articles 44-49.",
      },
      defaultRetentionMonths: {
        type: "integer",
        min: 1,
        default: 60,
        helpText:
          "Default retention period (months) applied to personal_data-tagged entities when no specific retention policy overrides. Article 5(1)(e) storage limitation.",
      },
    },
  },
  contributions: {
    entities: [
      {
        name: "DataSubjectRequest",
        fields: [
          { name: "subject_email", type: { kind: "email" }, required: true },
          { name: "subject_id", type: { kind: "uuid" } },
          {
            name: "request_kind",
            type: {
              kind: "enum",
              values: [
                "access",
                "erasure",
                "rectification",
                "portability",
                "restriction",
                "objection",
                "automated_decision_review",
              ],
            },
            required: true,
          },
          {
            name: "submitted_at",
            type: { kind: "datetime" },
            required: true,
            default: { kind: "expression", expression: "now()" },
          },
          {
            name: "completion_deadline",
            type: { kind: "date" },
            required: true,
          },
          {
            name: "status",
            type: {
              kind: "enum",
              values: ["pending", "verifying_identity", "in_progress", "completed", "rejected", "withdrawn"],
            },
            required: true,
            default: { kind: "literal", value: "pending" },
          },
          { name: "response_summary", type: { kind: "long_text" } },
          { name: "legal_basis_for_rejection", type: { kind: "long_text" } },
          { name: "completed_at", type: { kind: "datetime" } },
        ],
        traits: ["auditable"],
      },
      {
        name: "Consent",
        fields: [
          { name: "subject_id", type: { kind: "uuid" }, required: true },
          { name: "purpose", type: { kind: "text", maxLength: 256 }, required: true },
          { name: "consent_text", type: { kind: "long_text" }, required: true },
          {
            name: "legal_basis",
            type: {
              kind: "enum",
              values: [
                "consent",
                "contract",
                "legal_obligation",
                "vital_interests",
                "public_task",
                "legitimate_interests",
              ],
            },
            required: true,
          },
          {
            name: "granted",
            type: { kind: "boolean" },
            required: true,
          },
          {
            name: "granted_at",
            type: { kind: "datetime" },
            required: true,
            default: { kind: "expression", expression: "now()" },
          },
          { name: "withdrawn_at", type: { kind: "datetime" } },
          {
            name: "source",
            type: {
              kind: "enum",
              values: ["web_form", "paper_form", "verbal_recorded", "double_opt_in_email", "in_app"],
            },
            required: true,
          },
          { name: "version", type: { kind: "text", maxLength: 32 }, required: true },
        ],
        traits: ["auditable"],
      },
      {
        name: "DataProcessingActivity",
        fields: [
          { name: "activity_name", type: { kind: "text", maxLength: 256 }, required: true },
          { name: "controller", type: { kind: "text", maxLength: 256 }, required: true },
          { name: "processor", type: { kind: "text", maxLength: 256 } },
          { name: "categories_of_data", type: { kind: "json" }, required: true },
          { name: "categories_of_subjects", type: { kind: "json" }, required: true },
          { name: "recipients", type: { kind: "json" }, required: true },
          {
            name: "legal_basis",
            type: {
              kind: "enum",
              values: [
                "consent",
                "contract",
                "legal_obligation",
                "vital_interests",
                "public_task",
                "legitimate_interests",
              ],
            },
            required: true,
          },
          { name: "retention_period_months", type: { kind: "integer", min: 1 }, required: true },
          { name: "security_measures", type: { kind: "long_text" }, required: true },
          {
            name: "international_transfers",
            type: { kind: "boolean" },
            required: true,
            default: { kind: "literal", value: false },
          },
          { name: "transfer_safeguards", type: { kind: "long_text" } },
        ],
        traits: ["auditable"],
      },
      {
        name: "PersonalDataBreach",
        fields: [
          {
            name: "discovered_at",
            type: { kind: "datetime" },
            required: true,
          },
          { name: "breach_description", type: { kind: "long_text" }, required: true },
          {
            name: "categories_of_data_affected",
            type: { kind: "json" },
            required: true,
          },
          { name: "affected_subjects_count", type: { kind: "integer", min: 0 }, required: true },
          { name: "risk_assessment", type: { kind: "long_text" }, required: true },
          { name: "reported_to_supervisory_authority_at", type: { kind: "datetime" } },
          { name: "notification_to_subjects_at", type: { kind: "datetime" } },
          { name: "remediation_steps", type: { kind: "long_text" }, required: true },
          {
            name: "risk_level",
            type: {
              kind: "enum",
              values: ["low", "moderate", "high"],
            },
            required: true,
          },
        ],
        traits: ["auditable"],
      },
    ],
    traits: [
      {
        name: "personal_data",
        fields: [
          {
            name: "data_class",
            type: { kind: "text", maxLength: 32 },
            required: true,
            default: { kind: "literal", value: "personal_data" },
          },
          {
            name: "legal_basis",
            type: {
              kind: "enum",
              values: [
                "consent",
                "contract",
                "legal_obligation",
                "vital_interests",
                "public_task",
                "legitimate_interests",
              ],
            },
            required: true,
          },
          {
            name: "retention_period_months",
            type: { kind: "integer", min: 1 },
            required: true,
            default: { kind: "literal", value: 60 },
          },
        ],
      },
    ],
  },
};
