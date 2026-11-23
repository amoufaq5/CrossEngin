"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";

import { LOGIN_PATH } from "@/lib/session";

/**
 * A prospective customer asks for a workspace (ADR-0464). Nothing is created by this form: the
 * request waits until a platform operator approves it, and the password is then handed over out of
 * band, because this deployment has no mail channel.
 */

interface Terms {
  readonly open: boolean;
  readonly termsVersion: string | null;
  readonly termsUrl: string | null;
  readonly privacyUrl: string | null;
  readonly ttlHours?: number | null;
  readonly retentionDays?: number | null;
}

type TermsState =
  | { readonly kind: "loading" }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "closed" }
  | {
      readonly kind: "open";
      readonly version: string;
      readonly termsUrl: string;
      readonly privacyUrl: string;
      readonly ttlHours: number | null;
      readonly retentionDays: number | null;
    };

type FieldName = "companyName" | "contactName" | "email" | "requestedSlug" | "message";

/** The server's slug rule, so a typo is caught before it costs a round trip. The server decides. */
const SLUG_RE = /^[a-z][a-z0-9-]{1,48}$/;

/** Laxer than the server's check, so it can never refuse an address the server would accept. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MESSAGE_MAX = 2000;

function readTerms(raw: unknown): TermsState {
  if (raw === null || typeof raw !== "object") return { kind: "closed" };
  const t = raw as Partial<Terms>;
  if (t.open !== true) return { kind: "closed" };
  if (typeof t.termsVersion !== "string" || typeof t.termsUrl !== "string" || typeof t.privacyUrl !== "string") {
    return { kind: "closed" };
  }
  return {
    kind: "open",
    version: t.termsVersion,
    termsUrl: t.termsUrl,
    privacyUrl: t.privacyUrl,
    ttlHours: wholeOrNull(t.ttlHours),
    retentionDays: wholeOrNull(t.retentionDays),
  };
}

function wholeOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : null;
}

function plural(n: number, unit: string): string {
  return `${n.toString()} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * The retention sentence, from the figures this deployment reports. A server that does not report
 * one (an older build) gets "a limited time" rather than a number written into the page, because
 * the notice is a statement about what this deployment does and a figure nobody read from it is a
 * statement nobody checked.
 */
function retentionSentence(retentionDays: number | null, ttlHours: number | null): string {
  const decided = retentionDays === null ? "a limited time after that decision" : `${plural(retentionDays, "day")} after that decision`;
  const undecided = ttlHours === null ? "after a limited time" : `after ${plural(ttlHours, "hour")}`;
  return `A request nobody decides is deleted ${undecided}. One that is approved or declined is deleted ${decided}; if it is approved, your name and email address are used for your workspace account.`;
}

export default function RequestAccessPage(): ReactElement {
  const [terms, setTerms] = useState<TermsState>({ kind: "loading" });
  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [requestedSlug, setRequestedSlug] = useState("");
  const [message, setMessage] = useState("");
  const [accepted, setAccepted] = useState(false);
  // The honeypot. A person never sees it; a form-filling bot does, and the server answers a filled
  // one exactly as it answers a real request, storing nothing.
  // Named so a form-filling bot reads it as a real field and an autofill heuristic does not (a
  // `website` field is one a browser may fill for a person, which would silently drop their request).
  const [honeypot, setHoneypot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ReadonlySet<FieldName>>(new Set());
  const [received, setReceived] = useState<string | null>(null);

  const loadTerms = useCallback(async (): Promise<void> => {
    setTerms({ kind: "loading" });
    try {
      const res = await fetch("/api/request-access/terms", { headers: { accept: "application/json" } });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          body !== null && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
            ? (body as { message: string }).message
            : "The server could not be reached. Try again shortly.";
        setTerms({ kind: "unreachable", message: msg });
        return;
      }
      setTerms(readTerms(body));
    } catch {
      setTerms({ kind: "unreachable", message: "Could not reach the server. Check your connection and try again." });
    }
  }, []);

  useEffect(() => {
    void loadTerms();
  }, [loadTerms]);

  function validate(): ReadonlySet<FieldName> {
    const bad = new Set<FieldName>();
    if (companyName.trim() === "" || companyName.trim().length > 200) bad.add("companyName");
    if (contactName.trim() === "" || contactName.trim().length > 200) bad.add("contactName");
    if (!EMAIL_RE.test(email.trim()) || email.trim().length > 254) bad.add("email");
    if (requestedSlug.trim() !== "" && !SLUG_RE.test(requestedSlug.trim())) bad.add("requestedSlug");
    if (message.length > MESSAGE_MAX) bad.add("message");
    return bad;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || terms.kind !== "open") return;
    const bad = validate();
    setFieldErrors(bad);
    if (bad.size > 0) {
      setError("Please fix the highlighted fields.");
      return;
    }
    if (!accepted) {
      setError("Accept the terms to send the request.");
      return;
    }
    setBusy(true);
    setError(null);

    // Built up rather than sent with empty strings: the server parses the body strictly, and an
    // optional field left blank is a field not supplied.
    const body: Record<string, unknown> = {
      companyName: companyName.trim(),
      contactName: contactName.trim(),
      email: email.trim(),
      termsVersion: terms.version,
      termsAccepted: true,
    };
    if (requestedSlug.trim() !== "") body["requestedSlug"] = requestedSlug.trim();
    if (message.trim() !== "") body["message"] = message;
    if (honeypot !== "") body["ce_hp_extra"] = honeypot;

    let res: Response;
    try {
      res = await fetch("/api/request-access", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setBusy(false);
      return;
    }

    const answer: unknown = await res.json().catch(() => null);
    const doc = answer !== null && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
    const text = typeof doc["message"] === "string" ? doc["message"] : "Your request could not be submitted.";
    if (res.status === 202) {
      setReceived(text);
      setBusy(false);
      return;
    }
    const code = typeof doc["code"] === "string" ? doc["code"] : "";
    if (code === "terms_changed") {
      // The version on screen is stale; the customer has to see and accept the current one.
      setAccepted(false);
      void loadTerms();
    }
    if (code === "intake_closed") setTerms({ kind: "closed" });
    if (code === "slug_reserved") setFieldErrors(new Set<FieldName>(["requestedSlug"]));
    const fields = Array.isArray(doc["fields"]) ? (doc["fields"] as readonly unknown[]) : [];
    const known = fields.filter(
      (f): f is FieldName =>
        f === "companyName" || f === "contactName" || f === "email" || f === "requestedSlug" || f === "message",
    );
    if (known.length > 0) setFieldErrors(new Set(known));
    const retry = res.headers.get("retry-after");
    setError(retry !== null && /^\d+$/.test(retry) ? `${text} (retry in about ${retry} s)` : text);
    setBusy(false);
  }

  const invalid = (f: FieldName): boolean => fieldErrors.has(f);

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-black text-white shadow-tile">
            CE
          </span>
          <span className="text-[15px] font-extrabold tracking-tight text-ink">
            CrossEngin <span className="font-semibold text-ink-muted">Operate</span>
          </span>
        </div>

        <div className="card p-6">
          <h1 className="text-lg font-bold text-ink">Request access</h1>

          {terms.kind === "loading" && <p className="mt-4 text-sm text-ink-faint">Loading…</p>}

          {terms.kind === "unreachable" && (
            <div className="mt-4">
              <p className="text-sm text-red-600" role="alert">
                {terms.message}
              </p>
              <button type="button" onClick={() => void loadTerms()} className="btn-primary mt-4">
                Try again
              </button>
            </div>
          )}

          {terms.kind === "closed" && (
            <p className="mt-4 text-sm text-ink-muted">Sign-up is not open on this deployment.</p>
          )}

          {terms.kind === "open" && received !== null && (
            <p className="mt-4 text-sm text-emerald-700" role="status">
              {received}
            </p>
          )}

          {terms.kind === "open" && received === null && (
            <form onSubmit={(e) => void submit(e)} noValidate>
              <p className="mt-1 text-xs text-ink-faint">
                Tell us who you are and we will set up a workspace. Nothing is created until a person
                reviews the request.
              </p>

              <div className="mt-5 space-y-5">
                <div>
                  <label htmlFor="ra-company" className="label">
                    Company <span className="text-brand-600">*</span>
                  </label>
                  <input
                    id="ra-company"
                    className="field"
                    autoComplete="organization"
                    maxLength={200}
                    aria-invalid={invalid("companyName")}
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                  />
                </div>

                <div>
                  <label htmlFor="ra-contact" className="label">
                    Your name <span className="text-brand-600">*</span>
                  </label>
                  <input
                    id="ra-contact"
                    className="field"
                    autoComplete="name"
                    maxLength={200}
                    aria-invalid={invalid("contactName")}
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                  />
                </div>

                <div>
                  <label htmlFor="ra-email" className="label">
                    Work email <span className="text-brand-600">*</span>
                  </label>
                  <input
                    id="ra-email"
                    type="email"
                    className="field"
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={254}
                    aria-invalid={invalid("email")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                <div>
                  <label htmlFor="ra-slug" className="label">
                    Workspace name
                  </label>
                  <input
                    id="ra-slug"
                    className="field"
                    placeholder="acme-corp"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={49}
                    aria-invalid={invalid("requestedSlug")}
                    value={requestedSlug}
                    onChange={(e) => setRequestedSlug(e.target.value)}
                  />
                  <p className={`mt-1 text-xs ${invalid("requestedSlug") ? "text-brand-600" : "text-ink-faint"}`}>
                    Optional. Lower-case letters, digits and hyphens, starting with a letter. You sign in
                    with it.
                  </p>
                </div>

                <div>
                  <label htmlFor="ra-message" className="label">
                    Anything we should know
                  </label>
                  <textarea
                    id="ra-message"
                    className="field min-h-[5rem]"
                    maxLength={MESSAGE_MAX}
                    aria-invalid={invalid("message")}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-ink-faint">Optional.</p>
                </div>

                {/* The honeypot. Visually hidden rather than `display:none`, which some bots skip;
                    out of the tab order and hidden from assistive technology, so no person fills it. */}
                <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
                  <label htmlFor="ra-extra">Leave this field empty</label>
                  <input
                    id="ra-extra"
                    name="ce_hp_extra"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={honeypot}
                    onChange={(e) => setHoneypot(e.target.value)}
                  />
                </div>
              </div>

              <div className="mt-6 rounded-lg border border-line bg-surface-soft px-4 py-3 text-xs text-ink-muted">
                <p className="font-semibold text-ink">How we use these details</p>
                <p className="mt-1">
                  We collect your company name, your name and your email address, and the workspace name
                  and message if you give them. We use them only to review this request and set up your
                  workspace.
                </p>
                <p className="mt-1">{retentionSentence(terms.retentionDays, terms.ttlHours)}</p>
                <p className="mt-1">
                  Read the{" "}
                  <a href={terms.termsUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 underline">
                    terms
                  </a>{" "}
                  and the{" "}
                  <a href={terms.privacyUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 underline">
                    privacy notice
                  </a>
                  .
                </p>
              </div>

              <label className="mt-4 flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  required
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span>I accept the terms (version {terms.version}).</span>
              </label>

              {error !== null && (
                <p className="mt-4 text-sm text-red-600" role="alert">
                  {error}
                </p>
              )}

              <button type="submit" disabled={busy || !accepted} className="btn-primary mt-6 w-full">
                {busy ? "Sending…" : "Request access"}
              </button>
            </form>
          )}

          <p className="mt-6 text-center text-xs text-ink-faint">
            Already have a workspace?{" "}
            <Link href={LOGIN_PATH} className="font-medium text-brand-600 hover:text-brand-700">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
