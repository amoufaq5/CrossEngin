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
];

const RESET_PERIODS = ["", "never", "yearly", "monthly", "daily"];

type Company = Record<string, string>;

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

export default function SettingsPage() {
  const [company, setCompany] = useState<Company>({});
  const [currency, setCurrency] = useState("");
  const [rows, setRows] = useState<NumberingRow[]>([]);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "ok" | "error"; msg?: string }>({ kind: "idle" });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const s = (await getSettings()) as {
          company?: Company;
          defaults?: { currency?: string };
          numbering?: Record<string, { format?: string; start?: number; resetPeriod?: string }>;
        };
        setCompany(s.company ?? {});
        setCurrency(s.defaults?.currency ?? "");
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

  async function save(): Promise<void> {
    setStatus({ kind: "saving" });
    try {
      const cleanCompany: Company = {};
      for (const [k, v] of Object.entries(company)) if (v.trim() !== "") cleanCompany[k] = v.trim();
      const numbering: Record<string, { format?: string; start?: number; resetPeriod?: string }> = {};
      for (const r of rows) {
        const entry: { format?: string; start?: number; resetPeriod?: string } = {};
        if (r.format.trim() !== "") entry.format = r.format.trim();
        if (r.start.trim() !== "" && Number.isFinite(Number(r.start))) entry.start = Number(r.start);
        if (r.resetPeriod !== "") entry.resetPeriod = r.resetPeriod;
        if (Object.keys(entry).length > 0) numbering[r.key] = entry;
      }
      const payload: Record<string, unknown> = {};
      if (Object.keys(cleanCompany).length > 0) payload["company"] = cleanCompany;
      if (currency.trim() !== "") payload["defaults"] = { currency: currency.trim().toUpperCase() };
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
          Company profile, defaults, and document numbering. Numbering tokens:{" "}
          <code className="rounded bg-surface-soft px-1">{"{SEQ:6}"}</code>{" "}
          <code className="rounded bg-surface-soft px-1">{"{YYYY}"}</code>{" "}
          <code className="rounded bg-surface-soft px-1">{"{YY}"}</code>{" "}
          <code className="rounded bg-surface-soft px-1">{"{MM}"}</code>{" "}
          <code className="rounded bg-surface-soft px-1">{"{DD}"}</code>.
        </p>
      </header>

      {loading ? (
        <div className="text-sm text-ink-muted">Loading…</div>
      ) : (
        <div className="space-y-8">
          <section className="rounded-xl border border-line bg-white p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-faint">Company profile</h2>
            <div className="grid grid-cols-2 gap-4">
              {COMPANY_FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-muted">{f.label}</span>
                  <input
                    className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
                    value={company[f.key] ?? ""}
                    onChange={(e) => setCompany((c) => ({ ...c, [f.key]: e.target.value }))}
                  />
                </label>
              ))}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-muted">Default currency (ISO-3)</span>
                <input
                  className="w-full rounded-lg border border-line px-3 py-2 text-sm uppercase outline-none focus:border-brand"
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-line bg-white p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-faint">Document numbering</h2>
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
              Leave a field blank to keep the manifest default. Overrides apply to new documents only.
            </p>
          </section>

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
