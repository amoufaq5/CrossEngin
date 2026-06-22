"use client";

import { useEffect, useState } from "react";

import { getSettings, putSettings } from "@/lib/api";

interface NumberingRow {
  readonly key: string;
  readonly label: string;
  format: string;
  start: string;
  resetPeriod: string;
}

const KNOWN_SEQUENCES: ReadonlyArray<{ key: string; label: string; sample: string }> = [
  { key: "erp.invoice", label: "Invoices", sample: "INV-{YYYY}-{SEQ:5}" },
  { key: "erp.bill", label: "Vendor Bills", sample: "BILL-{YYYY}-{SEQ:5}" },
  { key: "erp.payment", label: "Payments", sample: "PAY-{YYYY}-{SEQ:5}" },
  { key: "erp.purchase_order", label: "Purchase Orders", sample: "PO-{YYYY}-{SEQ:5}" },
  { key: "erp.journal_entry", label: "Journal Entries", sample: "JE-{YYYY}-{SEQ:5}" },
  { key: "erp.expense", label: "Expenses", sample: "EXP-{YYYY}-{SEQ:5}" },
  { key: "erp.goods_receipt", label: "Goods Receipts", sample: "GRN-{YYYY}-{SEQ:5}" },
  { key: "erp.tax_return", label: "Tax Returns", sample: "TAX-{YYYY}-{SEQ:5}" },
];

const RESET_PERIODS = ["", "never", "yearly", "monthly", "daily"];
const DATE_FORMATS = ["", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD.MM.YYYY"];
const NUMBER_FORMATS = ["", "1,234.56", "1.234,56", "1 234,56", "1234.56"];
const ACCOUNTING_STANDARDS = ["", "ifrs", "us_gaap", "local_gaap"];
const ROUNDING_MODES = ["", "half_up", "half_even", "down", "up"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Company = Record<string, string>;
type StrMap = Record<string, string>;

const COMPANY_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "name", label: "Company name" },
  { key: "legalName", label: "Legal name" },
  { key: "taxId", label: "Tax ID" },
  { key: "email", label: "Billing email" },
  { key: "phone", label: "Phone" },
  { key: "addressLine1", label: "Address" },
  { key: "city", label: "City" },
  { key: "country", label: "Country (ISO-2)" },
];

interface FeatureRow {
  key: string;
  enabled: boolean;
}

export default function SettingsPage() {
  const [company, setCompany] = useState<Company>({});
  const [defaults, setDefaults] = useState<StrMap>({});
  const [finance, setFinance] = useState<StrMap>({});
  const [features, setFeatures] = useState<FeatureRow[]>([]);
  const [newFeature, setNewFeature] = useState("");
  const [rows, setRows] = useState<NumberingRow[]>([]);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "ok" | "error"; msg?: string }>({ kind: "idle" });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const s = (await getSettings()) as {
          company?: Company;
          defaults?: Record<string, unknown>;
          finance?: Record<string, unknown>;
          features?: Record<string, boolean>;
          numbering?: Record<string, { format?: string; start?: number; resetPeriod?: string }>;
        };
        setCompany(s.company ?? {});
        setDefaults(toStrMap(s.defaults));
        setFinance(toStrMap(s.finance));
        setFeatures(Object.entries(s.features ?? {}).map(([key, enabled]) => ({ key, enabled })));
        const numbering = s.numbering ?? {};
        setRows(
          KNOWN_SEQUENCES.map((seq) => ({
            key: seq.key,
            label: seq.label,
            format: numbering[seq.key]?.format ?? "",
            start: numbering[seq.key]?.start !== undefined ? String(numbering[seq.key]?.start) : "",
            resetPeriod: numbering[seq.key]?.resetPeriod ?? "",
          })),
        );
      } catch (err) {
        setStatus({ kind: "error", msg: String(err instanceof Error ? err.message : err) });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function updateRow(key: string, patch: Partial<NumberingRow>): void {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addFeature(): void {
    const key = newFeature.trim().toLowerCase().replace(/\s+/g, "_");
    if (key === "" || features.some((f) => f.key === key)) return;
    setFeatures((prev) => [...prev, { key, enabled: true }]);
    setNewFeature("");
  }

  async function save(): Promise<void> {
    setStatus({ kind: "saving" });
    try {
      const payload: Record<string, unknown> = {};

      const cleanCompany: Company = {};
      for (const [k, v] of Object.entries(company)) if (v.trim() !== "") cleanCompany[k] = v.trim();
      if (Object.keys(cleanCompany).length > 0) payload["company"] = cleanCompany;

      const d = buildDefaults(defaults);
      if (Object.keys(d).length > 0) payload["defaults"] = d;

      const fin = buildFinance(finance);
      if (Object.keys(fin).length > 0) payload["finance"] = fin;

      if (features.length > 0) {
        const map: Record<string, boolean> = {};
        for (const f of features) map[f.key] = f.enabled;
        payload["features"] = map;
      }

      const numbering: Record<string, { format?: string; start?: number; resetPeriod?: string }> = {};
      for (const r of rows) {
        const entry: { format?: string; start?: number; resetPeriod?: string } = {};
        if (r.format.trim() !== "") entry.format = r.format.trim();
        if (r.start.trim() !== "" && Number.isFinite(Number(r.start))) entry.start = Number(r.start);
        if (r.resetPeriod !== "") entry.resetPeriod = r.resetPeriod;
        if (Object.keys(entry).length > 0) numbering[r.key] = entry;
      }
      if (Object.keys(numbering).length > 0) payload["numbering"] = numbering;

      await putSettings(payload);
      setStatus({ kind: "ok", msg: "Settings saved." });
    } catch (err) {
      setStatus({ kind: "error", msg: String(err instanceof Error ? err.message : err) });
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-ink">Admin · Settings</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Company profile, regional defaults, finance &amp; tax posture, feature toggles, and document numbering.
        </p>
      </header>

      {loading ? (
        <div className="text-sm text-ink-muted">Loading…</div>
      ) : (
        <div className="space-y-8">
          <Section title="Company profile">
            <div className="grid grid-cols-2 gap-4">
              {COMPANY_FIELDS.map((f) => (
                <Text label={f.label} value={company[f.key] ?? ""} onChange={(v) => setCompany((c) => ({ ...c, [f.key]: v }))} key={f.key} />
              ))}
            </div>
          </Section>

          <Section title="Regional &amp; operational defaults">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <Text label="Default currency (ISO-3)" value={defaults.currency ?? ""} maxLength={3} uppercase onChange={(v) => setD(setDefaults, "currency", v)} />
              <Text label="Locale (e.g. en-US)" value={defaults.locale ?? ""} onChange={(v) => setD(setDefaults, "locale", v)} />
              <Text label="Timezone (IANA)" value={defaults.timezone ?? ""} onChange={(v) => setD(setDefaults, "timezone", v)} />
              <Select label="Fiscal year starts" value={defaults.fiscalYearStartMonth ?? ""} onChange={(v) => setD(setDefaults, "fiscalYearStartMonth", v)}
                options={[{ value: "", label: "default (January)" }, ...MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))]} />
              <Select label="Date format" value={defaults.dateFormat ?? ""} onChange={(v) => setD(setDefaults, "dateFormat", v)}
                options={DATE_FORMATS.map((f) => ({ value: f, label: f === "" ? "default" : f }))} />
              <Select label="Number format" value={defaults.numberFormat ?? ""} onChange={(v) => setD(setDefaults, "numberFormat", v)}
                options={NUMBER_FORMATS.map((f) => ({ value: f, label: f === "" ? "default" : f }))} />
              <Select label="Week starts on" value={defaults.weekStartDay ?? ""} onChange={(v) => setD(setDefaults, "weekStartDay", v)}
                options={[{ value: "", label: "default (Sunday)" }, ...WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))]} />
            </div>
          </Section>

          <Section title="Finance &amp; tax">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <Select label="Accounting standard" value={finance.accountingStandard ?? ""} onChange={(v) => setD(setFinance, "accountingStandard", v)}
                options={ACCOUNTING_STANDARDS.map((a) => ({ value: a, label: a === "" ? "default" : a.replace("_", " ").toUpperCase() }))} />
              <Select label="Rounding mode" value={finance.rounding ?? ""} onChange={(v) => setD(setFinance, "rounding", v)}
                options={ROUNDING_MODES.map((r) => ({ value: r, label: r === "" ? "default" : r.replace("_", " ") }))} />
              <Text label="Default tax jurisdiction" value={finance.defaultTaxJurisdiction ?? ""} onChange={(v) => setD(setFinance, "defaultTaxJurisdiction", v)} />
              <Text label="Payment terms (days)" value={finance.defaultPaymentTermsDays ?? ""} onChange={(v) => setD(setFinance, "defaultPaymentTermsDays", v)} />
              <Toggle label="Multi-currency enabled" checked={finance.multiCurrencyEnabled === "true"} onChange={(b) => setD(setFinance, "multiCurrencyEnabled", b ? "true" : "")} />
              <Toggle label="Prices include tax" checked={finance.pricesIncludeTax === "true"} onChange={(b) => setD(setFinance, "pricesIncludeTax", b ? "true" : "")} />
              <Text label="AR account code" value={finance.arAccountCode ?? ""} onChange={(v) => setD(setFinance, "arAccountCode", v)} />
              <Text label="Revenue account code" value={finance.revenueAccountCode ?? ""} onChange={(v) => setD(setFinance, "revenueAccountCode", v)} />
              <Text label="AP account code" value={finance.apAccountCode ?? ""} onChange={(v) => setD(setFinance, "apAccountCode", v)} />
              <Text label="Expense account code" value={finance.expenseAccountCode ?? ""} onChange={(v) => setD(setFinance, "expenseAccountCode", v)} />
              <Text label="Cash / bank account code" value={finance.cashAccountCode ?? ""} onChange={(v) => setD(setFinance, "cashAccountCode", v)} />
              <Text label="Tax payable (output) code" value={finance.taxPayableAccountCode ?? ""} onChange={(v) => setD(setFinance, "taxPayableAccountCode", v)} />
              <Text label="Input tax code" value={finance.taxInputAccountCode ?? ""} onChange={(v) => setD(setFinance, "taxInputAccountCode", v)} />
              <Text label="FX gain/loss code" value={finance.fxGainLossAccountCode ?? ""} onChange={(v) => setD(setFinance, "fxGainLossAccountCode", v)} />
              <Text label="Unrealized FX code" value={finance.unrealizedFxGainLossAccountCode ?? ""} onChange={(v) => setD(setFinance, "unrealizedFxGainLossAccountCode", v)} />
            </div>
            <p className="mt-3 text-xs text-ink-faint">
              Account codes map to your chart of accounts (LedgerAccount): invoice issue posts AR / revenue / tax-payable; bill approval posts expense / input-tax / AP; a completed payment settles cash against AR/AP, booking any cash-vs-balance gap to FX gain/loss.
            </p>
          </Section>

          <Section title="Feature toggles">
            {features.length === 0 && <p className="mb-3 text-xs text-ink-faint">No feature flags set. Add one below.</p>}
            <div className="space-y-2">
              {features.map((f) => (
                <div key={f.key} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                  <code className="text-sm text-ink">{f.key}</code>
                  <div className="ml-auto flex items-center gap-3">
                    <Toggle label="" checked={f.enabled} onChange={(b) => setFeatures((prev) => prev.map((x) => (x.key === f.key ? { ...x, enabled: b } : x)))} />
                    <button onClick={() => setFeatures((prev) => prev.filter((x) => x.key !== f.key))} className="text-xs font-medium text-brand-600 hover:text-brand-700">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                className="w-64 rounded-lg border border-line px-3 py-1.5 text-sm outline-none focus:border-brand"
                placeholder="feature_id (e.g. beta_reports)"
                value={newFeature}
                onChange={(e) => setNewFeature(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addFeature()}
              />
              <button onClick={addFeature} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-soft">
                Add feature
              </button>
            </div>
          </Section>

          <Section title="Document numbering">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="pb-2 pr-3 font-medium">Document</th>
                  <th className="pb-2 pr-3 font-medium">Format</th>
                  <th className="pb-2 pr-3 font-medium">Start</th>
                  <th className="pb-2 font-medium">Reset</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const seq = KNOWN_SEQUENCES.find((s) => s.key === r.key);
                  return (
                    <tr key={r.key} className="border-t border-line">
                      <td className="py-2 pr-3 font-medium text-ink">{r.label}</td>
                      <td className="py-2 pr-3">
                        <input
                          className="w-44 rounded-lg border border-line px-2 py-1.5 font-mono text-xs outline-none focus:border-brand"
                          placeholder={seq?.sample}
                          value={r.format}
                          onChange={(e) => updateRow(r.key, { format: e.target.value })}
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <input
                          className="w-20 rounded-lg border border-line px-2 py-1.5 text-xs outline-none focus:border-brand"
                          placeholder="1"
                          value={r.start}
                          onChange={(e) => updateRow(r.key, { start: e.target.value })}
                        />
                      </td>
                      <td className="py-2">
                        <select
                          className="rounded-lg border border-line px-2 py-1.5 text-xs outline-none focus:border-brand"
                          value={r.resetPeriod}
                          onChange={(e) => updateRow(r.key, { resetPeriod: e.target.value })}
                        >
                          {RESET_PERIODS.map((p) => (
                            <option key={p} value={p}>
                              {p === "" ? "default" : p}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-ink-faint">
              Numbering tokens: <code className="rounded bg-surface-soft px-1">{"{SEQ:6}"}</code>{" "}
              <code className="rounded bg-surface-soft px-1">{"{YYYY}"}</code>{" "}
              <code className="rounded bg-surface-soft px-1">{"{YY}"}</code>{" "}
              <code className="rounded bg-surface-soft px-1">{"{MM}"}</code>{" "}
              <code className="rounded bg-surface-soft px-1">{"{DD}"}</code>. Blank keeps the manifest default; overrides apply to new documents only.
            </p>
          </Section>

          <div className="flex items-center gap-4">
            <button
              onClick={() => void save()}
              disabled={status.kind === "saving"}
              className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
            >
              {status.kind === "saving" ? "Saving…" : "Save settings"}
            </button>
            {status.kind === "ok" && <span className="text-sm font-medium text-green-600">{status.msg}</span>}
            {status.kind === "error" && <span className="text-sm font-medium text-brand-600">{status.msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- helpers -----------------------------------------------------------------

function toStrMap(obj: Record<string, unknown> | undefined): StrMap {
  const out: StrMap = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    out[k] = typeof v === "boolean" ? (v ? "true" : "") : v === null || v === undefined ? "" : String(v);
  }
  return out;
}

function setD(setter: React.Dispatch<React.SetStateAction<StrMap>>, key: string, value: string): void {
  setter((prev) => ({ ...prev, [key]: value }));
}

function buildDefaults(d: StrMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (d.currency?.trim()) out.currency = d.currency.trim().toUpperCase();
  if (d.locale?.trim()) out.locale = d.locale.trim();
  if (d.timezone?.trim()) out.timezone = d.timezone.trim();
  if (d.fiscalYearStartMonth) out.fiscalYearStartMonth = Number(d.fiscalYearStartMonth);
  if (d.dateFormat) out.dateFormat = d.dateFormat;
  if (d.numberFormat) out.numberFormat = d.numberFormat;
  if (d.weekStartDay !== undefined && d.weekStartDay !== "") out.weekStartDay = Number(d.weekStartDay);
  return out;
}

function buildFinance(f: StrMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.accountingStandard) out.accountingStandard = f.accountingStandard;
  if (f.rounding) out.rounding = f.rounding;
  if (f.defaultTaxJurisdiction?.trim()) out.defaultTaxJurisdiction = f.defaultTaxJurisdiction.trim();
  if (f.defaultPaymentTermsDays?.trim() && Number.isFinite(Number(f.defaultPaymentTermsDays))) {
    out.defaultPaymentTermsDays = Number(f.defaultPaymentTermsDays);
  }
  if (f.multiCurrencyEnabled === "true") out.multiCurrencyEnabled = true;
  if (f.pricesIncludeTax === "true") out.pricesIncludeTax = true;
  if (f.arAccountCode?.trim()) out.arAccountCode = f.arAccountCode.trim();
  if (f.revenueAccountCode?.trim()) out.revenueAccountCode = f.revenueAccountCode.trim();
  if (f.apAccountCode?.trim()) out.apAccountCode = f.apAccountCode.trim();
  if (f.expenseAccountCode?.trim()) out.expenseAccountCode = f.expenseAccountCode.trim();
  if (f.cashAccountCode?.trim()) out.cashAccountCode = f.cashAccountCode.trim();
  if (f.taxPayableAccountCode?.trim()) out.taxPayableAccountCode = f.taxPayableAccountCode.trim();
  if (f.taxInputAccountCode?.trim()) out.taxInputAccountCode = f.taxInputAccountCode.trim();
  if (f.fxGainLossAccountCode?.trim()) out.fxGainLossAccountCode = f.fxGainLossAccountCode.trim();
  if (f.unrealizedFxGainLossAccountCode?.trim()) out.unrealizedFxGainLossAccountCode = f.unrealizedFxGainLossAccountCode.trim();
  return out;
}

// ---- presentational ----------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-white p-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-faint" dangerouslySetInnerHTML={{ __html: title }} />
      {children}
    </section>
  );
}

function Text({
  label,
  value,
  onChange,
  maxLength,
  uppercase,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  uppercase?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      <input
        className={`w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand ${uppercase ? "uppercase" : ""}`}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      <select
        className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-brand" />
      {label && <span className="text-sm text-ink-muted">{label}</span>}
    </label>
  );
}
