export function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-line bg-white/80 px-8 backdrop-blur">
      <div>
        <h1 className="text-base font-semibold text-ink">{title}</h1>
        {subtitle ? <p className="text-sm text-ink-muted">{subtitle}</p> : null}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-ink-faint">tenant: demo</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-sunken text-xs font-medium text-ink-muted">
          A
        </span>
      </div>
    </header>
  );
}
