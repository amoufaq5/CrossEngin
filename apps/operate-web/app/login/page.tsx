"use client";
import { useState } from "react";
export default function LoginPage() {
  const [credential, setCredential] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="mx-auto my-20 max-w-md space-y-5 rounded-xl border bg-white p-8" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const res = await fetch("/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential }) });
      if (!res.ok) throw new Error("Sign-in failed. Check your personal access credential with your administrator.");
      setCredential(""); window.location.assign("/");
    } catch (err) { setError(err instanceof Error ? err.message : "Sign-in failed"); }
    finally { setBusy(false); }
  }}>
    <h1 className="text-2xl font-semibold">Sign in to CrossEngin</h1>
    <p className="text-sm text-slate-600">Use the personal access credential issued by your administrator. Access is limited to your assigned company and role.</p>
    <label className="block text-sm">Personal access credential<input className="mt-2 w-full rounded border p-3" type="password" autoComplete="off" required value={credential} onChange={e => setCredential(e.target.value)} /></label>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button disabled={busy} className="rounded bg-slate-900 px-5 py-3 text-white">{busy ? "Signing in…" : "Sign in"}</button>
  </form>;
}
