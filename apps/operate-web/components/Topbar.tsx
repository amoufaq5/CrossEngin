export function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="page-header">
      <div>
        <h1 className="text-lg font-extrabold tracking-tight text-ink">{title}</h1>
        {subtitle ? <p className="text-sm font-medium text-ink-muted">{subtitle}</p> : null}
      </div>
    </header>
  );
}
