import { RESOURCES, type DomainKey, type ResourceConfig } from "./resources";

export interface DomainGroup {
  readonly key: DomainKey;
  readonly label: string;
  readonly resources: readonly ResourceConfig[];
}

const DOMAIN_LABELS: Record<DomainKey, string> = {
  crm: "CRM",
  inventory: "Inventory",
  procurement: "Procurement",
  finance: "Finance",
  hr: "People",
};

const DOMAIN_ORDER: readonly DomainKey[] = ["crm", "inventory", "procurement", "finance", "hr"];

export function navGroups(): readonly DomainGroup[] {
  return DOMAIN_ORDER.map((key) => ({
    key,
    label: DOMAIN_LABELS[key],
    resources: RESOURCES.filter((r) => r.domain === key),
  }));
}

export function hrefFor(resource: ResourceConfig): string {
  return `/${resource.domain}/${resource.slug}`;
}
