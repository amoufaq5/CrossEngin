# ADR-0001: Platform Positioning and Brand Architecture

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002, ADR-0004, ADR-0005, ADR-0024 |

## Context

CrossEngin began as an ERP project for the pharmaceutical and healthcare sector. Over the course of design conversations, the scope expanded to a meta-application platform serving:

1. Commercial enterprises across multiple verticals (healthcare, retail, construction, professional services, plus seven more).
2. Government and public-sector digitalization (procurement, citizen services, licensing, tax, courts, utilities).
3. National-scale healthcare digitalization (ministry platforms, EMR rollouts, registries).
4. Education (K-12, university lifecycle, vocational training).
5. NGOs, non-profits, faith-based organizations (programs, grants, M&E, donor CRM).
6. Bespoke applications for tenants and channel partners.

This expansion forces a fundamental question: **what is CrossEngin, as a product and as a brand?** Without an answer:

- Engineering decisions get pulled in conflicting directions (ERP-shaped vs. platform-shaped abstractions).
- Marketing has no way to position the product distinctly to different buyer types.
- Sales conversations get muddled — a procurement officer at a ministry hears "ERP" and mentally exits.
- Hiring and partnerships lack a north star.
- Pricing has no anchor — flat-rate ERP, usage-based platform, enterprise sales motion, or self-service SaaS?

The team building CrossEngin is solo-to-duo. Brand and positioning ambiguity is a luxury we cannot afford; every conversation must reinforce a single coherent answer.

Three architectural realities constrain the brand decision:

1. **One kernel.** All target families share the same substrate (entities, relations, workflows, audit, RBAC). Splitting into multiple engineering codebases would be wasteful and fatal to a small team.
2. **One AI Architect.** The conversational layer is general-purpose: it interviews any tenant about any business, regulation, mission, or process and produces a manifest. The same agent serves all families.
3. **Vertical specificity matters for buying.** A community pharmacist evaluating "an AI-native application platform" will pass. The same pharmacist evaluating "a pharmacy management system that can be customized in 15 minutes" will engage. Buyers identify with their industry, not with platforms.

The brand architecture must reconcile these: **one engineering reality, many buyer-facing identities, no fragmentation of substrate.**

## Decision

CrossEngin uses a **three-layer brand architecture** with one platform brand, five app-family brands, and two distribution brands.

### Layer 1 — Platform substrate

**CrossEngin Core** is the substrate: the kernel, the AI Architect, the workflow engine, the integration mesh, the design system, and all supporting infrastructure (jobs, files, search, observability, billing, compliance, reporting).

CrossEngin Core is never sold alone. It is the engineering reality on which everything else runs.

### Layer 2 — App families

Five app families, each named for the verb that captures its buyer's intent:

| Sub-brand | Verb | Buyer | First target manifest |
|---|---|---|---|
| **CrossEngin Operate** | "operate a business" | Mid-market commercial enterprises | Pharma + Healthcare (community pharmacy → hospital → manufacturer) |
| **CrossEngin Govern** | "govern a jurisdiction" | Government agencies, public-sector buyers | E-procurement portal |
| **CrossEngin Heal** | "heal a population" | Ministries of health, multi-org healthcare programs | Vaccination registry or regional EMR coordination |
| **CrossEngin Educate** | "educate students" | Schools, universities, training providers | University student lifecycle |
| **CrossEngin Serve** | "serve a mission" | NGOs, non-profits, faith-based organizations | Program + grant management with M&E |

Each family aggregates one or more target families from the 13-family map (see [vision.md](../vision.md), section 5):

- **Operate** = Families 1–4, 9–13 (commercial verticals)
- **Govern** = Family 5 (government and public sector)
- **Heal** = Family 6 (national/multi-org healthcare digitalization)
- **Educate** = Family 7 (education)
- **Serve** = Family 8 (NGO / non-profit / faith)

The same engineering substrate (Core) powers all five families. The brand distinction is for sales, marketing, packaging, pricing, and customer success — not for engineering.

### Layer 3 — Distribution channels

Two distribution sub-brands:

- **CrossEngin Build** — the self-service builder. Any tenant on any family can spin up bespoke applications through the AI Architect. CrossEngin Build is the user-facing entrance to the platform's customization power. Sold as an add-on or bundled into higher-tier packages.
- **CrossEngin Partner** — the white-label / OEM channel. System integrators, consultancies, and reseller partners distribute CrossEngin under their own brand for their own customers. The substrate is identical; the surface bears the partner's identity with a "Powered by CrossEngin" mark. (Renamed from "Power" — see Open questions below.)

### Naming conventions

- **One word per sub-brand.** Single-syllable preferred, two-syllable acceptable. Distinct meanings, no overlap.
- **Verb-shaped where possible.** Operate, Govern, Heal, Educate, Serve, Build are all verbs. Core is not, and Partner functions as a noun in this context — both communicate role rather than action.
- **No marketing-speak suffixes.** No "Cloud," "Suite," or "Platform" appended to the sub-brand name. The sub-brand stands alone.
- **English-first, internationalizable.** Each word translates cleanly into major regional languages or stands as a recognizable loanword. English is widely understood across our target buyer demographic in our target regions.

### Family-to-vertical mapping rules

Some sub-types appear in multiple families. Rules:

- **Healthcare as commercial entity** (single pharmacy, single hospital) → **Operate**.
- **Healthcare as public-sector or multi-org coordination** (ministry program, national registry) → **Heal**.
- **Education as commercial entity** (private tutoring chain) → **Operate** by default; can be packaged as **Educate** for accreditation-driven institutions.
- **Financial services that are tightly regulated** (banking, large insurance carriers) → out of scope for now; CrossEngin does not target core banking.
- **NGO that operates a commercial enterprise** (e.g., a religious organization running a hospital) → **Operate** for the hospital, **Serve** for the mission/donations side, both on the same tenant.

When in doubt: **who is the buyer and what do they search for?** A ministry health officer searches "national EMR platform" → Heal. A hospital CEO searches "hospital ERP" → Operate. Same kernel, different sub-brand based on buyer's mental model.

### Marketing-tag retention

The category names buyers know — "ERP," "procurement platform," "EMR coordinator," "SIS," "grants management" — remain as SEO and marketing tags attached to the relevant family:

- CrossEngin Operate — "the modern ERP"
- CrossEngin Govern — "the modern e-procurement and licensing platform"
- CrossEngin Heal — "national healthcare digitalization"
- CrossEngin Educate — "the modern student information system"
- CrossEngin Serve — "modern grants and program management for NGOs"

The sub-brand carries identity; the category tag carries discoverability.

## Alternatives considered

### Option A — Single brand, "CrossEngin" only (no sub-brands)

All product surfaces use "CrossEngin." Verticals are positioned as "CrossEngin for Pharmacies," "CrossEngin for Governments."

- **Pros:** Simpler to manage. Single brand to register and protect. Less marketing copy to maintain.
- **Cons:** A government buyer Googling "e-procurement platform" sees "CrossEngin" and learns nothing about whether it's relevant. The "for X" suffix reads as marketing fluff. Hard to differentiate Govern, Heal, Educate at the buyer level.
- **Why not:** Loses the buyer-recognition benefit of named families. Acceptable for a one-vertical company; insufficient for a 13-family platform.

### Option B — Vertical-named separate products (independent brands)

Spin off each family into its own product brand (e.g., "Pharmasol" for pharma, "ProcureFlow" for government). De-emphasize the shared platform.

- **Pros:** Each product brand is highly specific to its buyer. Easy to acquire one and sell it later.
- **Cons:** Fragments engineering, marketing, support, infrastructure. Each brand needs its own domain, GTM, sales materials. Loses the "AI Architect can build anything" story — which is the central moat.
- **Why not:** Solo-to-duo team cannot maintain 5–8 brands. Also dilutes the platform play, which is the whole point.

### Option C — Generic ERP-only brand

Position CrossEngin as an ERP platform. Govern, Heal, Educate, Serve are not initial brand layers; they emerge later (Year 3+) as ERP families.

- **Pros:** Tight initial scope. ERP is a known buyer category. Easier to position in Year 1.
- **Cons:** Engineering decisions made under "ERP" framing bake in commercial-enterprise assumptions (general ledger, AP/AR, sales orders) that are wrong for government / NGO / healthcare-coordination contexts. Re-positioning later costs years of work.
- **Why not:** The kernel must be general from day one. Brand framing follows engineering reality.

### Option D — "Stack" / "Pack" suffixed sub-brands

Original proposal. Sub-brands like "GovStack," "EduStack," "Impact" (for NGO).

- **Pros:** Reads clearly as "a stack of capabilities for X."
- **Cons:** "Stack" is overloaded in tech marketing. Less distinct than single-word verbs. "Impact" doesn't bind cleanly to NGO/charity in non-English buying contexts.
- **Why not:** Verbs are more memorable and brandable. Decision made in conversation with project owner; documented here for archival reasons.

### Option E — Functional descriptors ("CrossEngin for Business," "CrossEngin for Government")

- **Pros:** Maximally clear what each is for.
- **Cons:** Verbose. Not brandable as standalone words. Reads as marketing copy rather than as a product brand.
- **Why not:** Sacrifices brand identity for clarity. Verbs achieve both.

### Decision

**Verb slate (with one noun for the channel).** CrossEngin Core / Operate / Govern / Heal / Educate / Serve / Build / Partner.

## Consequences

### Positive

- **Buyer recognition.** A government CIO searching for procurement software finds CrossEngin Govern. The brand layer mirrors the buyer's mental model.
- **Marketing pipeline structure.** Each family gets its own landing page, content marketing track, sales materials, and pricing — without fragmenting engineering.
- **Pricing flexibility.** Each family can have its own pricing model. CrossEngin Operate may price per-tenant + per-seat; CrossEngin Govern may price per-project with deployment fees; CrossEngin Heal may price per-million-citizens; CrossEngin Serve may have a non-profit-discount tier.
- **Channel clarity.** CrossEngin Partner gives system integrators a clean white-label path without confusion about what they're reselling. Partner launches Year 2–3 (pulled forward from Year 5) to leverage MENA SI relationships.
- **Hiring and partnerships.** The brand architecture tells potential hires and partners exactly which family they're working in.
- **AI Architect cross-utility.** A CrossEngin Operate tenant (pharmacy chain) that acquires a charity arm doesn't need a new product — they spin up a CrossEngin Serve manifest within the same tenant.

### Negative

- **Brand registration cost.** Each sub-brand (Core, Operate, Govern, Heal, Educate, Serve, Build, Partner) ideally gets a trademark filing in the regions we operate. Approximate cost: USD 1,500–3,000 per word per region. **Decision (2026-05-11):** all trademark filings deferred to Phase 5 launch; we accept the squatter-registration risk during the build year.
- **Marketing surface expansion.** Each family needs its own homepage, demo, pricing, case studies. Mitigation: start with Operate-only marketing; add families when each ships.
- **Buyer confusion if poorly executed.** "What's the difference between Operate and Govern?" must be answerable in one sentence. If marketing copy is sloppy the brand splits become noise.
- **Domain name management.** `crossengin.io` is the primary domain. Sub-brand paths (`/operate`, `/govern`, etc.) handle most navigation; defensive registration of dedicated domains (`crossengin-govern.com`) is wise long-term.

### Neutral

- The engineering codebase has no per-family branching. Same packages, same kernel. Brand exists at the marketing layer.
- Internal communication may use either the family name or the technical name interchangeably ("Govern manifest" or "the procurement pack").

### Reversibility

**Moderate.** Renaming a sub-brand after launch is expensive in marketing assets, customer mental models, and SEO. Renaming before public launch (within Year 1) is straightforward. Adding a new sub-brand later is cheap. Removing one is expensive after customers exist on it.

**Decision lock-in date:** before public launch of CrossEngin Operate (end of Phase 5, ~Month 8 of Year 1).

## Implementation notes

- **Trademark searches.** Run USPTO, EUIPO, and UAE Ministry of Economy trademark searches on all eight sub-brands before Phase 5 marketing site goes live. Resolve conflicts before launch. Filings themselves are deferred to Phase 5 (see Consequences → Brand registration cost).
- **Domain portfolio.** Acquire `crossengin.com` (primary if available) and `crossengin.io` (alternate). Sub-brand subdomains served via `/operate`, `/govern`, etc., on the primary domain unless a sub-brand grows large enough to warrant its own root domain.
- **Internal naming.** Engineering code uses sub-brand names in package or module names where they relate to family-specific manifests (e.g., `manifests/operate-pharma-healthcare/`). The kernel and shared packages use neutral names (`packages/kernel`, `packages/ai-architect`).
- **Style guide.** A brand style guide will define logo treatment, color palette, typography, voice & tone for each sub-brand. Different families may have slightly different visual languages (e.g., Govern may favor a more conservative palette than Build). Common parent visual language across all.
- **Internationalization.** Verb sub-brands ("Operate," "Govern," "Heal," "Educate," "Serve") translate cleanly into major target languages or stand as recognizable English loanwords.

## Open questions

### Resolved (2026-05-11)

- **White-label channel sub-brand:** renamed from "Power" to **"Partner."** Functions as a noun rather than a verb; clearer channel semantics; less ambiguous in MENA-region buyer conversations.
- **Trademark filing scope and timing:** all eight sub-brand filings deferred to Phase 5 launch. Cost-deferred; squatter risk accepted.
- **Domain portfolio:** `crossengin.com` is the primary target if available; `crossengin.io` is the alternate. `.ai` and `.dev` deferred.
- **Per-family pricing differentiation:** confirmed. Operate gets per-tenant flat + AI usage metered. Govern, Heal, Educate, Serve each get their own pricing models, finalized at each family's ship time.
- **Open-source kernel brand:** moot. Per the source-posture decision (everything closed source), there is no open-source kernel.

### Still open

| Question | Owner | Deadline |
|---|---|---|
| Visual identity system: each sub-brand visually distinct, or share a single visual language with accents? | _pending hire_ | Phase 4 |
| Specific pricing structure per family beyond Operate (Govern per-project + deployment fee, Heal per-citizen-record, Educate per-student-FTE, Serve non-profit discount tier). | amoufaq5 + commercial hire | Per family at ship time |
| Trademark squatter audit before Phase 5: how often during the build year do we re-check that `CrossEngin Operate`, `CrossEngin Govern`, etc. have not been filed defensively against us? | amoufaq5 | Phase 2 (start cadence) |

## References

- [vision.md](../vision.md), section 4 (sub-brand map) and section 5 (target families).
- ADR-0004 (Manifest specification) — defines what a family-specific manifest looks like in practice.
- ADR-0024 (Repository and migration strategy) — defines how sub-brand boundaries map to engineering code.
- Naming-decision conversation, 2026-05-11.
