"use client";

import { useState, type FormEvent, type ReactElement } from "react";

import { NEXT_PARAM, safeNextPath } from "@/lib/session";

/**
 * One generic failure. The API refuses to distinguish an unknown email from a wrong password
 * and `/api/auth/login` refuses to echo its `detail`, so there is one message here too — a
 * third layer narrowing it would be the only one that leaked.
 */
const REFUSED = "Those credentials were not accepted. Check the workspace, email and password.";

export default function LoginPage(): ReactElement {
  const [tenant, setTenant] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    let res: Response;
    try {
      res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        // A POST body, so the password never reaches a URL, a referrer or an access log.
        body: JSON.stringify({ tenant, email, password }),
      });
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setBusy(false);
      return;
    }

    if (!res.ok) {
      const detail = res.status === 502 ? "The API is not reachable. Try again shortly." : REFUSED;
      setError(detail);
      setPassword("");
      setBusy(false);
      return;
    }

    // A FULL DOCUMENT LOAD, not `router.push`. `lib/schema.ts`, `lib/reference-cache.ts` and
    // `lib/subscription.ts` each hold a module-level cache with no invalidation, so a
    // client-side navigation would carry the *previous* principal's entity list, role label,
    // resolved reference labels and subscription banner into the new session — the one
    // browser state a login must not inherit. Reading the destination from
    // `window.location` rather than `useSearchParams()` keeps this page statically
    // prerenderable, and costs nothing because the value is needed once, here.
    const params = new URLSearchParams(window.location.search);
    window.location.href = safeNextPath(params.get(NEXT_PARAM));
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-black text-white shadow-tile">
            CE
          </span>
          <span className="text-[15px] font-extrabold tracking-tight text-ink">
            CrossEngin <span className="font-semibold text-ink-muted">Operate</span>
          </span>
        </div>

        <form onSubmit={(e) => void submit(e)} className="card p-6">
          <h1 className="text-lg font-bold text-ink">Sign in</h1>
          <p className="mt-1 text-xs text-ink-faint">Use your workspace credentials.</p>

          <div className="mt-5 space-y-5">
            <div>
              <label htmlFor="login-tenant" className="label">
                Workspace <span className="text-brand-600">*</span>
              </label>
              <input
                id="login-tenant"
                name="tenant"
                className="field"
                placeholder="acme-corp"
                autoComplete="organization"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
              />
              <p className="mt-1 text-xs text-ink-faint">The workspace slug, or its id.</p>
            </div>

            <div>
              <label htmlFor="login-email" className="label">
                Email <span className="text-brand-600">*</span>
              </label>
              <input
                id="login-email"
                name="email"
                type="email"
                className="field"
                placeholder="you@example.com"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="login-password" className="label">
                Password <span className="text-brand-600">*</span>
              </label>
              <input
                id="login-password"
                name="password"
                type="password"
                className="field"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          {error !== null && (
            <p className="mt-4 text-sm text-red-600" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy} className="btn-primary mt-6 w-full">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
