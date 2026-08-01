"use client";

import { useEffect, useId, useState } from "react";

import { listRecords } from "@/lib/api";

interface AccountOption {
  readonly code: string;
  readonly name: string;
}

// Shared across every picker instance on the page: the chart of accounts is
// fetched once and the promise cached at module scope, so N pickers cause 1 fetch.
let accountsCache: Promise<readonly AccountOption[]> | null = null;

function loadAccounts(): Promise<readonly AccountOption[]> {
  if (accountsCache === null) {
    accountsCache = listRecords("ledger-accounts", "?limit=500")
      .then((res) => {
        const opts: AccountOption[] = [];
        for (const r of res.data) {
          const code = r["account_code"];
          if (typeof code !== "string" || code.trim() === "") continue;
          const name = typeof r["name"] === "string" ? r["name"] : "";
          opts.push({ code, name });
        }
        opts.sort((a, b) => a.code.localeCompare(b.code));
        return opts;
      })
      .catch(() => {
        // On failure, reset so a later mount can retry; the picker degrades to a
        // plain text input (empty datalist) rather than blocking editing.
        accountsCache = null;
        return [] as readonly AccountOption[];
      });
  }
  return accountsCache;
}

/**
 * A text input for a GL account code that offers autocomplete against the tenant's
 * live chart of accounts (LedgerAccount.account_code) via an attached <datalist>,
 * while still allowing free text. When the current value doesn't match any known
 * code, a subtle "unknown code" hint surfaces the likely typo. The chart of
 * accounts is fetched once and shared across all picker instances.
 */
export function AccountCodePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [accounts, setAccounts] = useState<readonly AccountOption[] | null>(null);
  const listId = useId();

  useEffect(() => {
    let alive = true;
    void loadAccounts().then((opts) => {
      if (alive) setAccounts(opts);
    });
    return () => {
      alive = false;
    };
  }, []);

  const loaded = accounts !== null;
  const known = loaded && accounts.some((a) => a.code === value);
  const showUnknown = loaded && value.trim() !== "" && !known;

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      <input
        className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
        value={value}
        list={listId}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {(accounts ?? []).map((a) => (
          <option key={a.code} value={a.code}>
            {a.name === "" ? a.code : `${a.code} — ${a.name}`}
          </option>
        ))}
      </datalist>
      {showUnknown && <span className="mt-1 block text-xs text-amber-600">unknown code</span>}
    </label>
  );
}
