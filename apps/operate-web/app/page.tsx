import Link from "next/link";

import { Topbar } from "@/components/Topbar";
import { navGroups, hrefFor } from "@/lib/nav";

export default function DashboardPage() {
  const groups = navGroups();
  const total = groups.reduce((n, g) => n + g.resources.length, 0);

  return (
    <>
      <Topbar title="Dashboard" subtitle="Enterprise ERP — CRM, Inventory, Procurement, Finance, People" />
      <div className="px-8 py-6">
        <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Domains" value={String(groups.length)} accent />
          <Stat label="Entities" value={String(total)} />
          <Stat label="Workflows" value="7" />
          <Stat label="Roles" value="9" />
          <Stat label="Views" value="17" />
        </section>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => (
            <div key={group.key} className="card p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-brand" />
                <h2 className="text-sm font-bold uppercase tracking-wide text-ink">{group.label}</h2>
                <span className="ml-auto text-xs text-ink-faint">{group.resources.length}</span>
              </div>
              <ul className="space-y-1">
                {group.resources.map((res) => (
                  <li key={res.slug}>
                    <Link
                      href={hrefFor(res)}
                      className="flex items-center justify-between rounded-lg px-3 py-1.5 text-sm text-ink-muted transition hover:bg-surface-soft hover:text-ink"
                    >
                      <span>{res.title}</span>
                      <span className="text-ink-faint">→</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`card p-4 ${accent ? "ring-1 ring-brand/20" : ""}`}>
      <div className={`text-2xl font-black ${accent ? "text-brand" : "text-ink"}`}>{value}</div>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}
