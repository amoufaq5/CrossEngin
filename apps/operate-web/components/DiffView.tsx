"use client";

export type DiffImpact = "none" | "additive" | "breaking";

export type WarningImpact = "additive" | "breaking";

export interface DiffWarningView {
  readonly code: string;
  readonly impact: WarningImpact;
  readonly message: string;
  readonly entities: ReadonlyArray<string>;
}

export interface FieldChangeView {
  readonly entity: string;
  readonly field: string;
  readonly change: string;
  readonly from: string | null;
  readonly to: string | null;
}

export interface PermissionChangeView {
  readonly entity: string;
  readonly operation: string;
  readonly granted: ReadonlyArray<string>;
  readonly revoked: ReadonlyArray<string>;
}

export interface RelationChangeView {
  readonly change: string;
  readonly label: string;
  readonly detail: string | null;
}

export interface LifecycleChangeView {
  readonly entity: string;
  readonly detail: string;
}

export interface DiffCountsView {
  readonly added: number;
  readonly removed: number;
  readonly modified: number;
  readonly warnings: number;
}

export interface ManifestDiffView {
  readonly comparable: boolean;
  readonly impact: DiffImpact;
  readonly warnings: ReadonlyArray<DiffWarningView>;
  readonly entitiesAdded: ReadonlyArray<string>;
  readonly entitiesRemoved: ReadonlyArray<string>;
  readonly entitiesModified: ReadonlyArray<string>;
  readonly fieldChanges: ReadonlyArray<FieldChangeView>;
  readonly permissionChanges: ReadonlyArray<PermissionChangeView>;
  readonly relationChanges: ReadonlyArray<RelationChangeView>;
  readonly rolesAdded: ReadonlyArray<string>;
  readonly rolesRemoved: ReadonlyArray<string>;
  readonly lifecycleChanges: ReadonlyArray<LifecycleChangeView>;
  readonly counts: DiffCountsView;
}

/**
 * The server sends `change` as an open string. These are the kinds that destroy
 * or reinterpret data already in the live system, so they must read as red even
 * though the diff's overall impact may be summarised as something milder.
 */
const DANGEROUS_CHANGES: ReadonlyArray<string> = [
  "removed",
  "type_changed",
  "narrowed",
  "required_added",
];

const ADDITIVE_CHANGES: ReadonlyArray<string> = ["added"];

function changeTone(change: string): "danger" | "positive" | "neutral" {
  if (DANGEROUS_CHANGES.includes(change)) return "danger";
  if (ADDITIVE_CHANGES.includes(change)) return "positive";
  return "neutral";
}

function changeGlyph(change: string): string {
  const tone = changeTone(change);
  if (tone === "positive") return "+";
  if (tone === "danger") return change === "removed" ? "−" : "~";
  return "~";
}

const CHANGE_CHIP: Readonly<Record<"danger" | "positive" | "neutral", string>> = {
  danger: "bg-brand text-white ring-1 ring-brand-700",
  positive: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/30",
  neutral: "bg-surface-sunken text-ink-muted ring-1 ring-line",
};

function humanize(token: string): string {
  return token.replace(/_/g, " ");
}

export function DiffView({ diff }: { diff: ManifestDiffView }) {
  if (!diff.comparable) {
    return (
      <div className="rounded-xl border border-line bg-surface-soft px-4 py-3">
        <p className="text-sm font-semibold text-ink">This is the first system for this tenant</p>
        <p className="mt-1 text-sm text-ink-muted">
          There is nothing to compare against. Everything in the schema below is new.
        </p>
      </div>
    );
  }

  if (diff.impact === "none") {
    return (
      <div className="rounded-xl border border-line bg-surface-soft px-4 py-3">
        <p className="text-sm font-semibold text-ink">No changes</p>
        <p className="mt-1 text-sm text-ink-muted">
          This proposal matches the currently-active system.
        </p>
      </div>
    );
  }

  const breaking = diff.impact === "breaking";
  const entitiesChanged =
    diff.entitiesAdded.length + diff.entitiesRemoved.length + diff.entitiesModified.length > 0;

  return (
    <div className="space-y-5">
      <div
        className={`rounded-xl px-4 py-3 ${
          breaking ? "bg-brand-50 ring-1 ring-brand-200" : "bg-emerald-50 ring-1 ring-emerald-200"
        }`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
              breaking
                ? "bg-brand text-white ring-1 ring-brand-700"
                : "bg-white text-emerald-700 ring-1 ring-emerald-600/30"
            }`}
          >
            {diff.impact}
          </span>
          <span
            className={`text-sm font-semibold ${breaking ? "text-brand-700" : "text-emerald-800"}`}
          >
            {breaking
              ? "Breaking changes — activating this will alter or remove parts of the live system."
              : "Additive changes only — nothing in the live system is removed or reinterpreted."}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <CountPill label="Added" value={diff.counts.added} />
        <CountPill label="Removed" value={diff.counts.removed} accent={diff.counts.removed > 0} />
        <CountPill label="Modified" value={diff.counts.modified} />
        <CountPill label="Warnings" value={diff.counts.warnings} accent={diff.counts.warnings > 0} />
      </div>

      {diff.warnings.length > 0 && (
        <div>
          <div className="label">Warnings</div>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {diff.warnings.map((w, i) => (
              <WarningRow key={`${w.code}-${i}`} warning={w} />
            ))}
          </ul>
        </div>
      )}

      {entitiesChanged && (
        <div>
          <div className="label">Entities</div>
          <div className="space-y-2 rounded-xl border border-line bg-white px-4 py-3">
            <ChipRow label="Added" names={diff.entitiesAdded} tone="positive" />
            <ChipRow label="Removed" names={diff.entitiesRemoved} tone="danger" />
            <ChipRow label="Modified" names={diff.entitiesModified} tone="neutral" />
          </div>
        </div>
      )}

      {diff.fieldChanges.length > 0 && <FieldChangesTable changes={diff.fieldChanges} />}

      {diff.permissionChanges.length > 0 && (
        <PermissionChanges changes={diff.permissionChanges} />
      )}

      {diff.relationChanges.length > 0 && <RelationChanges changes={diff.relationChanges} />}

      {(diff.rolesAdded.length > 0 || diff.rolesRemoved.length > 0) && (
        <div>
          <div className="label">Roles</div>
          <div className="space-y-2 rounded-xl border border-line bg-white px-4 py-3">
            <ChipRow label="Added" names={diff.rolesAdded} tone="positive" />
            <ChipRow label="Removed" names={diff.rolesRemoved} tone="danger" />
          </div>
        </div>
      )}

      {diff.lifecycleChanges.length > 0 && <LifecycleChanges changes={diff.lifecycleChanges} />}
    </div>
  );
}

function WarningRow({ warning }: { warning: DiffWarningView }) {
  const breaking = warning.impact === "breaking";
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <span
        className={`mt-0.5 inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
          breaking
            ? "bg-brand text-white ring-1 ring-brand-700"
            : "bg-surface-sunken text-ink-muted ring-1 ring-line"
        }`}
      >
        {warning.impact}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${breaking ? "text-brand-700" : "text-ink"}`}>
          {warning.message}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11px] text-ink-faint">{warning.code}</span>
          {warning.entities.map((e) => (
            <span key={e} className="chip">
              {e}
            </span>
          ))}
        </div>
      </div>
    </li>
  );
}

function ChipRow({
  label,
  names,
  tone,
}: {
  label: string;
  names: ReadonlyArray<string>;
  tone: "danger" | "positive" | "neutral";
}) {
  if (names.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <span
        className={`w-20 shrink-0 text-[11px] font-semibold uppercase tracking-wide ${
          tone === "danger" ? "text-brand-700" : "text-ink-faint"
        }`}
      >
        {label}
      </span>
      {names.map((n) => (
        <span
          key={n}
          className={`inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold ${CHANGE_CHIP[tone]}`}
        >
          {n}
        </span>
      ))}
    </div>
  );
}

function FieldChangesTable({ changes }: { changes: ReadonlyArray<FieldChangeView> }) {
  return (
    <div>
      <div className="label">Fields</div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="data-table">
          <thead>
            <tr>
              <th>Entity</th>
              <th>Field</th>
              <th>Change</th>
              <th>From</th>
              <th>To</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c, i) => {
              const tone = changeTone(c.change);
              return (
                <tr key={`${c.entity}-${c.field}-${c.change}-${i}`}>
                  <td className="whitespace-nowrap font-mono text-xs text-ink-muted">{c.entity}</td>
                  <td className="whitespace-nowrap">
                    <span
                      aria-hidden
                      className={`mr-1.5 font-mono text-xs font-black ${
                        tone === "danger"
                          ? "text-brand-600"
                          : tone === "positive"
                            ? "text-emerald-600"
                            : "text-ink-faint"
                      }`}
                    >
                      {changeGlyph(c.change)}
                    </span>
                    <span
                      className={`font-mono text-xs font-semibold ${
                        tone === "danger" ? "text-brand-700" : "text-ink"
                      }`}
                    >
                      {c.field}
                    </span>
                  </td>
                  <td className="whitespace-nowrap">
                    <span
                      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold ${CHANGE_CHIP[tone]}`}
                    >
                      {humanize(c.change)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-ink-muted">
                    {c.from === null ? <span className="text-ink-faint">—</span> : c.from}
                  </td>
                  <td className="whitespace-nowrap text-ink-muted">
                    {c.to === null ? <span className="text-ink-faint">—</span> : c.to}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PermissionChanges({ changes }: { changes: ReadonlyArray<PermissionChangeView> }) {
  return (
    <div>
      <div className="label">Permissions</div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {changes.map((c, i) => (
          <li key={`${c.entity}-${c.operation}-${i}`} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs font-semibold text-ink">{c.entity}</span>
              <span className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">
                {c.operation}
              </span>
            </div>
            <div className="mt-1.5 space-y-1.5">
              {c.granted.length > 0 && (
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <span className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                    Granted
                  </span>
                  {c.granted.map((r) => (
                    <span
                      key={r}
                      className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-600/30"
                    >
                      + {r}
                    </span>
                  ))}
                </div>
              )}
              {c.revoked.length > 0 && (
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <span className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-brand-700">
                    Revoked
                  </span>
                  {c.revoked.map((r) => (
                    <span
                      key={r}
                      className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-0.5 font-mono text-[11px] font-semibold text-white ring-1 ring-brand-700"
                    >
                      <span aria-hidden>−</span>
                      <span className="line-through decoration-white/70">{r}</span>
                    </span>
                  ))}
                </div>
              )}
              {c.granted.length === 0 && c.revoked.length === 0 && (
                <span className="text-xs text-ink-faint">No role changes.</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RelationChanges({ changes }: { changes: ReadonlyArray<RelationChangeView> }) {
  return (
    <div>
      <div className="label">Relations</div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {changes.map((c, i) => {
          const tone = changeTone(c.change);
          return (
            <li
              key={`${c.change}-${c.label}-${i}`}
              className="flex flex-wrap items-baseline gap-2 px-4 py-2"
            >
              <span
                className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-bold ${CHANGE_CHIP[tone]}`}
              >
                {humanize(c.change)}
              </span>
              <span
                className={`font-mono text-xs font-semibold ${
                  tone === "danger" ? "text-brand-700" : "text-ink"
                }`}
              >
                {c.label}
              </span>
              {c.detail !== null && <span className="text-xs text-ink-muted">{c.detail}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LifecycleChanges({ changes }: { changes: ReadonlyArray<LifecycleChangeView> }) {
  return (
    <div>
      <div className="label">Lifecycle</div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {changes.map((c, i) => (
          <li
            key={`${c.entity}-${i}`}
            className="flex flex-wrap items-baseline gap-2 px-4 py-2"
          >
            <span className="font-mono text-xs font-semibold text-ink">{c.entity}</span>
            <span className="text-xs text-ink-muted">{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CountPill({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-1.5 ${
        accent ? "border-brand-200 bg-brand-50" : "border-line bg-surface-soft"
      }`}
    >
      <div className={`text-sm font-black ${accent ? "text-brand-700" : "text-ink"}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}
