import { z } from "zod";
import {
  COMPLIANCE_FRAMEWORKS,
  type ComplianceFramework,
} from "@crossengin/access-reviews";

export { COMPLIANCE_FRAMEWORKS };
export type { ComplianceFramework };

export const CONTROL_DOMAINS = [
  "access_governance",
  "data_protection",
  "audit_integrity",
  "resilience",
] as const;
export type ControlDomain = (typeof CONTROL_DOMAINS)[number];

export const EVIDENCE_SOURCE_KINDS = [
  "access_review_campaign",
  "encryption_coverage",
  "forensic_chain",
  "dr_readiness",
] as const;
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

export const FrameworkRefsSchema = z.record(
  z.enum(COMPLIANCE_FRAMEWORKS),
  z.array(z.string().min(1)).min(1),
);
export type FrameworkRefs = z.infer<typeof FrameworkRefsSchema>;

export const ControlDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.]{2,48}$/),
    domain: z.enum(CONTROL_DOMAINS),
    title: z.string().min(1),
    description: z.string().min(1),
    requiredEvidence: z.enum(EVIDENCE_SOURCE_KINDS),
    frameworkRefs: FrameworkRefsSchema,
  })
  .strict();
export type ControlDefinition = z.infer<typeof ControlDefinitionSchema>;

export const DEFAULT_CONTROL_CATALOG: readonly ControlDefinition[] = [
  {
    id: "access.periodic_review",
    domain: "access_governance",
    title: "Periodic access recertification",
    description:
      "Privileged and workforce access is reviewed on a recurring cadence with attested keep/revoke decisions and separation of duties.",
    requiredEvidence: "access_review_campaign",
    frameworkRefs: {
      soc2_type2: ["CC6.1", "CC6.2", "CC6.3"],
      iso27001: ["A.5.18", "A.9.2.5"],
      hipaa_security_rule: [
        "164.308(a)(3)(ii)(B)",
        "164.308(a)(4)(ii)(C)",
      ],
      pci_dss_v4: ["7.2.4", "7.2.5", "7.2.6"],
      gdpr_article_32: ["Art.32.4"],
      cfr_21_part_11: ["11.10(d)", "11.10(g)"],
    },
  },
  {
    id: "data.encryption_at_rest",
    domain: "data_protection",
    title: "Encryption of sensitive data at rest",
    description:
      "Columns classified phi/regulated are stored as ciphertext with the encryption extension provisioned; no plaintext-at-rest drift.",
    requiredEvidence: "encryption_coverage",
    frameworkRefs: {
      soc2_type2: ["CC6.7"],
      iso27001: ["A.8.24"],
      hipaa_security_rule: ["164.312(a)(2)(iv)", "164.312(e)(2)(ii)"],
      pci_dss_v4: ["3.5.1"],
      gdpr_article_32: ["Art.32.1.a"],
      cfr_21_part_11: ["11.10(c)"],
    },
  },
  {
    id: "audit.tamper_evident_log",
    domain: "audit_integrity",
    title: "Tamper-evident audit logging",
    description:
      "Security-relevant events are recorded in a hash-chained, signed log whose integrity verifies end-to-end from the genesis hash.",
    requiredEvidence: "forensic_chain",
    frameworkRefs: {
      soc2_type2: ["CC7.2", "CC7.3"],
      iso27001: ["A.8.15"],
      hipaa_security_rule: ["164.312(b)"],
      pci_dss_v4: ["10.2", "10.3"],
      gdpr_article_32: ["Art.32.1.b"],
      cfr_21_part_11: ["11.10(e)"],
    },
  },
  {
    id: "resilience.dr_readiness",
    domain: "resilience",
    title: "Disaster-recovery readiness",
    description:
      "Backups are verified and unexpired, runbooks are current, and failover/drill RPO/RTO targets are met per DR tier.",
    requiredEvidence: "dr_readiness",
    frameworkRefs: {
      soc2_type2: ["A1.2", "A1.3"],
      iso27001: ["A.5.29", "A.5.30"],
      hipaa_security_rule: ["164.308(a)(7)(ii)(A)", "164.308(a)(7)(ii)(B)"],
      pci_dss_v4: ["12.10.1"],
      gdpr_article_32: ["Art.32.1.c"],
    },
  },
];

export function controlsForFramework(
  framework: ComplianceFramework,
  catalog: readonly ControlDefinition[] = DEFAULT_CONTROL_CATALOG,
): readonly ControlDefinition[] {
  return catalog.filter((c) => c.frameworkRefs[framework] !== undefined);
}

export function frameworkRefsFor(
  control: ControlDefinition,
  framework: ComplianceFramework,
): readonly string[] {
  return control.frameworkRefs[framework] ?? [];
}

export function frameworksCoveredBy(
  control: ControlDefinition,
): readonly ComplianceFramework[] {
  return COMPLIANCE_FRAMEWORKS.filter(
    (f) => control.frameworkRefs[f] !== undefined,
  );
}
