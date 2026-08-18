"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Topbar } from "@/components/Topbar";
import { createTenant, PlatformError } from "@/lib/platform";

const TIERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "free", label: "Free" },
  { value: "starter", label: "Starter" },
  { value: "growth", label: "Growth" },
  { value: "enterprise", label: "Enterprise" },
];

const REGIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "eu-central", label: "EU Central" },
  { value: "eu-west", label: "EU West" },
  { value: "us-east", label: "US East" },
  { value: "us-west", label: "US West" },
  { value: "me-uae", label: "Middle East (UAE)" },
  { value: "gcc-ksa", label: "GCC (KSA)" },
  { value: "apac-sg", label: "APAC (Singapore)" },
  { value: "ap-south", label: "AP South" },
];

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export default function NewTenantPage() {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [tier, setTier] = useState<string>("free");
  const [region, setRegion] = useState<string>("eu-central");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ slug?: string; name?: string }>({});

  async function submit() {
    const errs: { slug?: string; name?: string } = {};
    const s = slug.trim();
    const n = name.trim();
    if (s === "") errs.slug = "Slug is required";
    else if (!SLUG_RE.test(s)) errs.slug = "Lowercase letters, digits and hyphens only";
    if (n === "") errs.name = "Name is required";
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      setError("Please fix the highlighted fields.");
      return;
    }

    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const tenant = await createTenant({ slug: s, name: n, tier, region });
      router.push(`/platform/${encodeURIComponent(tenant.id)}`);
    } catch (e) {
      if (e instanceof PlatformError && e.status === 409) {
        // Duplicate slug — flag the field so the fix is obvious.
        setFieldErrors({ slug: e.message || "That slug is already taken." });
        setError("A tenant with that slug already exists.");
      } else if (e instanceof PlatformError && e.status === 400) {
        setError(e.message || "The tenant details were rejected.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setBusy(false);
    }
  }

  return (
    <>
      <Topbar title="New tenant" subtitle="Provision a workspace" />
      <div className="mx-auto max-w-xl px-8 py-6">
        <Link href="/platform" className="mb-4 inline-block text-sm text-ink-muted hover:text-ink">
          ← Platform
        </Link>

        <div className="card p-6">
          <div className="space-y-5">
            <div>
              <label htmlFor="tenant-slug" className="label">
                Slug <span className="text-brand-600">*</span>
              </label>
              <input
                id="tenant-slug"
                className="field"
                placeholder="acme-corp"
                value={slug}
                aria-invalid={fieldErrors.slug !== undefined}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setFieldErrors((p) => ({ ...p, slug: undefined }));
                }}
              />
              {fieldErrors.slug ? (
                <p className="mt-1 text-xs text-red-600">{fieldErrors.slug}</p>
              ) : (
                <p className="mt-1 text-xs text-ink-faint">
                  Unique, URL-safe identifier. Lowercase letters, digits and hyphens.
                </p>
              )}
            </div>

            <div>
              <label htmlFor="tenant-name" className="label">
                Name <span className="text-brand-600">*</span>
              </label>
              <input
                id="tenant-name"
                className="field"
                placeholder="Acme Corporation"
                value={name}
                aria-invalid={fieldErrors.name !== undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  setFieldErrors((p) => ({ ...p, name: undefined }));
                }}
              />
              {fieldErrors.name && <p className="mt-1 text-xs text-red-600">{fieldErrors.name}</p>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="tenant-tier" className="label">
                  Tier
                </label>
                <select
                  id="tenant-tier"
                  className="field"
                  value={tier}
                  onChange={(e) => setTier(e.target.value)}
                >
                  {TIERS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="tenant-region" className="label">
                  Region
                </label>
                <select
                  id="tenant-region"
                  className="field"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                >
                  {REGIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {error && <p className="mt-4 text-sm text-brand-600">{error}</p>}

          <div className="mt-6 flex gap-3">
            <button onClick={() => void submit()} disabled={busy} className="btn-primary">
              {busy ? "Creating…" : "Create tenant"}
            </button>
            <Link href="/platform" className="btn-ghost">
              Cancel
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
