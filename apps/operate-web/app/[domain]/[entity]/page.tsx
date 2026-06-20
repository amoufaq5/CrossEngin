import { notFound } from "next/navigation";

import { ResourcePage } from "@/components/ResourcePage";
import { Topbar } from "@/components/Topbar";
import { RESOURCES, findResource } from "@/lib/resources";

export function generateStaticParams() {
  return RESOURCES.map((r) => ({ domain: r.domain, entity: r.slug }));
}

export default function EntityPage({ params }: { params: { domain: string; entity: string } }) {
  const resource = findResource(params.domain, params.entity);
  if (!resource) notFound();

  return (
    <>
      <Topbar title={resource.title} subtitle={`${labelForDomain(resource.domain)} · /v1/${resource.slug}`} />
      <ResourcePage resource={resource} />
    </>
  );
}

function labelForDomain(domain: string): string {
  const map: Record<string, string> = {
    crm: "CRM",
    inventory: "Inventory",
    procurement: "Procurement",
    finance: "Finance",
    hr: "People",
  };
  return map[domain] ?? domain;
}
