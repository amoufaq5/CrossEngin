"use client";

import Link from "next/link";

import { Topbar } from "@/components/Topbar";
import { groupByModule, useSchema } from "@/lib/schema";

export default function DashboardPage() {
  const { schema, loading, error } = useSchema();
  const entities = schema?.entities ?? [];
  const groups = groupByModule(entities);
  const withLifecycle = entities.filter((e) => e.transitions.length > 0).length;

  return (
    <>
      <Topbar title="Dashboard" subtitle="Manifest-driven enterprise ERP console" />
      <div className="px-8 py-6">
        {loading && <p className="text-sm text-ink-muted">Loading schema…</p>}
        {error && (
          <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            Could not load schema: {error}. Is operate-server running?
          </div>
        )}

        {schema && (
          <>
            <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Departments" value={String(groups.length)} accent />
              <Stat label="Entities" value={String(entities.length)} />
              <Stat label="With lifecycle" value={String(withLifecycle)} />
              <Stat label="Generated" value={schema.generatedAt.slice(0, 10)} />
            </section>

            <div className="space-y-7">
              {groups.map((group) => (
                <section key={group.module}>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-brand" />
                    <h2 className="text-sm font-bold uppercase tracking-wide text-ink">{group.module}</h2>
                    <span className="text-xs text-ink-faint">{group.entities.length}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {group.entities.map((e) => (
                      <Link
                        key={e.slug}
                        href={`/e/${e.slug}`}
                        className="card group p-4 transition hover:border-brand-300 hover:shadow-sm"
                      >
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-ink group-hover:text-brand-700">{e.label}</h3>
                          <span className="ml-auto text-ink-faint transition group-hover:translate-x-0.5">→</span>
                        </div>
                        <p className="mt-1.5 text-xs text-ink-faint">
                          {e.fields.length} fields
                          {e.transitions.length > 0 ? ` · ${e.transitions.length} actions` : ""}
                        </p>
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
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
