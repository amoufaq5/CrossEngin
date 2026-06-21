"use client";

import Link from "next/link";

import { Topbar } from "@/components/Topbar";
import { useInbox } from "@/lib/inbox";
import {
  accessibleEntities,
  canAccess,
  groupByModule,
  roleLabel,
  useSchema,
  viewerActions,
} from "@/lib/schema";

export default function DashboardPage() {
  const { schema, loading, error } = useSchema();
  const { items: inboxItems } = useInbox(schema);

  const entities = accessibleEntities(schema);
  const groups = groupByModule(entities);
  const creatable = entities.filter((e) => canAccess(schema, e, "create"));
  const actions = viewerActions(schema);
  const workflowEntities = entities.filter((e) => actions.some((a) => a.entity.name === e.name));

  const viewer = schema?.viewer ?? null;
  const roleName = viewer ? roleLabel(schema, viewer.primaryRole) : null;

  return (
    <>
      <Topbar
        title={roleName ? `Welcome, ${roleName}` : "Dashboard"}
        subtitle={
          viewer
            ? `Your workspace · ${groups.length} departments · ${entities.length} areas you can access`
            : "Manifest-driven enterprise ERP console"
        }
      />
      <div className="px-8 py-6">
        {loading && <p className="text-sm text-ink-muted">Loading schema…</p>}
        {error && (
          <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            Could not load schema: {error}. Is operate-server running?
          </div>
        )}

        {schema && (
          <>
            {inboxItems.length > 0 && (
              <Link
                href="/inbox"
                className="mb-6 flex items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-5 py-4 transition hover:bg-brand-100"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-black text-white">
                  {inboxItems.length}
                </span>
                <div className="leading-tight">
                  <div className="text-sm font-semibold text-brand-700">
                    {inboxItems.length} item{inboxItems.length === 1 ? "" : "s"} awaiting your action
                  </div>
                  <div className="text-xs text-brand-600">Across all departments — open My Inbox →</div>
                </div>
              </Link>
            )}

            <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Departments" value={String(groups.length)} accent />
              <Stat label="Your areas" value={String(entities.length)} />
              <Stat label="You can create" value={String(creatable.length)} />
              <Stat label="Your workflows" value={String(workflowEntities.length)} />
            </section>

            {creatable.length > 0 && (
              <section className="mb-8">
                <SectionHeader title="Quick create" count={creatable.length} />
                <div className="flex flex-wrap gap-2">
                  {creatable.slice(0, 12).map((e) => (
                    <Link
                      key={e.slug}
                      href={`/e/${e.slug}?new=1`}
                      className="rounded-full border border-line bg-white px-3 py-1.5 text-sm text-ink-muted transition hover:border-brand-300 hover:text-brand-700"
                    >
                      + {e.singular}
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {workflowEntities.length > 0 && (
              <section className="mb-8">
                <SectionHeader title="Workflows you own" count={workflowEntities.length} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {workflowEntities.map((e) => {
                    const mine = actions.filter((a) => a.entity.name === e.name);
                    return (
                      <Link key={e.slug} href={`/e/${e.slug}`} className="card group p-4 hover:border-brand-300">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-ink group-hover:text-brand-700">{e.label}</h3>
                          <span className="ml-auto text-ink-faint group-hover:translate-x-0.5">→</span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {mine.slice(0, 4).map((a) => (
                            <span
                              key={a.transition.name}
                              className="rounded bg-surface-soft px-1.5 py-0.5 text-[11px] font-medium text-ink-muted"
                            >
                              {a.transition.label}
                            </span>
                          ))}
                          {mine.length > 4 && (
                            <span className="text-[11px] text-ink-faint">+{mine.length - 4}</span>
                          )}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}

            <SectionHeader title="Your departments" count={groups.length} />
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
                          {canAccess(schema, e, "create") ? " · can create" : " · read-only"}
                        </p>
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
            </div>

            {entities.length === 0 && (
              <div className="rounded-lg border border-line bg-surface-soft px-4 py-6 text-center text-sm text-ink-muted">
                Your role has no assigned areas yet. Contact an administrator.
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink">{title}</h2>
      <span className="text-xs text-ink-faint">{count}</span>
    </div>
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
