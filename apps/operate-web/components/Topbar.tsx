export function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-line bg-white/80 px-8 backdrop-blur">
      <div>
        <h1 className="text-lg font-bold text-ink">{title}</h1>
        {subtitle ? <p className="text-sm text-ink-muted">{subtitle}</p> : null}
      </div>
      <div className="flex items-center gap-3">
        <span className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink-muted">
          tenant: demo
        </span>
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
          A
        </span>
      </div>
    </header>
  );
}
