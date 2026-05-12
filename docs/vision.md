# CrossEngin — Vision

## Preamble

This document is the north-star concept for **CrossEngin**. It defines what CrossEngin is, who it serves, why it exists, and how it will be built. It is a living document — it will change as we learn — but it should always be the highest-level statement of intent against which every architecture decision is measured.

Subsidiary architecture decisions live in [`adr/`](adr/). Where this document and an accepted ADR conflict, the ADR wins and this document must be updated to match.

This document is **not** a roadmap and **not** a product plan. Roadmaps live in code repositories alongside the work; product plans live on customer-facing surfaces.

---

## 1. The problem

Mid-market businesses, government agencies, NGOs, schools, and bespoke enterprise programs all run the same kind of software underneath: people, places, things, money, time, documents, events, workflows, audits, dashboards, integrations. The names differ — a hospital calls a "thing" a Patient; a procurement portal calls it a Vendor; a charity calls it a Beneficiary — but the substrate is identical.

Today's options for that substrate force a brutal trade-off.

**Heavy ERP (SAP, Oracle, Microsoft Dynamics).** Built in the 1990s and 2000s. Powerful, but capital-intensive to implement: typical mid-market deployments cost USD 500K–5M and take 6–18 months. Customization happens through proprietary languages (ABAP, X++) and certified consultants. Vendor lock-in is total. Buyers know they're overpaying but lack alternatives at scale.

**Mid-market suites (NetSuite, Sage, Acumatica).** Lighter than SAP but still 6–12 month implementations and USD 100K–500K. Customization is awkward — bolt-on apps, scripting layers, no real schema flexibility. Industry verticals are partial; pharmaceutical GxP, multi-specialty hospital workflows, government procurement get half-solutions.

**Open source ERP (Odoo, ERPNext).** Free to download. The cost moves to implementation: USD 50K–200K for a typical deployment because the modules need significant customization for any real vertical. Code-level changes are required for non-trivial workflows. Multi-tenancy is fragile. Compliance packs (21 CFR Part 11, HIPAA, IFRS COA) are either absent or community-maintained.

**Low-code / no-code (Salesforce + Lightning, Microsoft Power Platform, Mendix, OutSystems, Retool, Airtable, Glide).** Fast to start, very expensive at scale (Salesforce + 5 add-on clouds + integration partners + admin team = USD 200K–1M+/year). These platforms make easy things easy and hard things impossible. They work for line-of-business apps; they break down for full ERP, regulated industries, or government-scale work.

**Bespoke development.** A custom build for one organization is expensive (USD 200K–2M+), slow (12–24 months), and begins decaying the moment the build team disperses.

**The gap.** None of these gives the mid-market — a 50-person community pharmacy chain, a 300-person construction company, a 200-clinic ministry of health digitalization program, a 1,000-student vocational training network, a 40-person consulting firm — an option that is:

- Genuinely vertical-specific without a six-month implementation
- Customizable without proprietary languages or expensive consultants
- Multi-tenant SaaS with optional on-prem and BYOC editions
- Compliant by default (GxP, HIPAA, GDPR, SOX, IFRS, country-specific health and procurement laws)
- Built to be reshaped *by a person describing what they need*, not by a developer translating requirements
- Operable at a price point that doesn't require enterprise sales cycles

The standard playbook for the past 30 years has been to build a vertical suite and sell it. We propose a different playbook: **build a platform that builds vertical suites on demand, and then build the lighthouse suites on it ourselves to prove it.**

---

## 2. What CrossEngin is

CrossEngin is an **AI-native application platform**. It has three layers.

**1. Core — the substrate.** A multi-tenant kernel that knows how to provision, run, and govern arbitrary business applications. Meta-schema, dynamic entity engine, workflow runtime, RBAC + ABAC, audit, files, jobs, search, reporting, integration mesh, design system. Never sold alone. Everything else is built on it.

**2. Manifests — the declarations.** Declarative bundles that tell the kernel what application to be. A manifest names the entities, the relations, the workflows, the roles, the views, the forms, the reports, the integrations, the compliance pack. A manifest is data, not code — it can be edited at runtime; the kernel re-provisions to match. Manifests ship in packs (a "vertical pack" like Community Pharmacy or University Student Lifecycle) or are authored ad-hoc by tenants for bespoke needs.

**3. The AI Architect — the conversational layer.** An agent that interviews a tenant — owner, operations lead, compliance officer, system integrator — about their business, regulation, mission, or process; produces a manifest; previews the changes against the tenant's current state; and applies them on approval. The AI Architect is the difference between "you have a kernel and a manifest spec" (interesting but for engineers) and "a community pharmacist describes their workflow and gets a working pharmacy management system" (useful for the world).

The three layers compose into one product: a tenant signs up, talks to the AI Architect about their business, gets a running application within minutes that they can immediately use and continue to customize by conversation.

---

## 3. Architectural premise

Every business, government program, NGO, school, or bespoke enterprise app — at the substrate level — has the same primitives:

- **Entities** — people, places, things, money, time, documents, events.
- **Relationships** — one-to-many, many-to-many, hierarchies, ordered lists, lookups with referential integrity.
- **States and transitions** — state machines describing the lifecycle of every entity.
- **Workflows** — orchestrations of state transitions across multiple entities, with conditions, escalations, SLAs, and human steps.
- **Roles and permissions** — coarse RBAC for what role can do what action; fine-grained ABAC for which records a role can see and edit; row-, field-, and value-level rules.
- **Audit** — an immutable log of who did what to what entity, when, why, with optional e-signatures and retention rules.
- **Documents** — uploads (PDFs, images, scans), generated artifacts (invoices, certificates of analysis, building permits), version history, signatures, OCR.
- **Money or value flow** — prices, taxes, ledgers, invoices for commercial entities; fees, subsidies, budgets, allocations for government; donations, grants, allocations for NGOs.
- **Time** — calendars, schedules, recurrences, SLAs, fiscal periods, holidays.
- **Communication** — notifications (email, SMS, push, in-app), threads, mentions, comments scoped to entities.
- **Reporting** — saved queries, pivots, KPIs, dashboards, scheduled exports.
- **Integration** — inbound and outbound webhooks, OAuth-secured third-party APIs, ETL imports, file drops, EDI/HL7/FHIR/UBL for regulated exchanges.

Every business app is some combination of these primitives.

- A **pharmacy** is people (patients, prescribers, staff) + things (drugs, batches) + money (sales, insurance claims) + time (refill schedules, expiry dates) + documents (prescriptions, batch records, regulatory filings) + workflows (dispensing, ordering, recall) + roles (pharmacist, technician, manager) + integration (drug formularies, insurance clearinghouses).
- A **vaccination registry** is people (citizens, healthcare workers) + things (vaccine doses, batches) + time (schedules, follow-up) + documents (consent, adverse event reports) + workflows (dose administration, recall, adverse-event escalation) + roles (clinician, public-health officer, citizen self-service) + integration (national identity, EHR systems, WHO reporting).
- A **graduate-school admissions system** is people (applicants, evaluators, faculty) + documents (applications, transcripts, recommendations) + workflows (screening, scoring, interviews, decisions) + roles (applicant, evaluator, committee chair, dean) + time (deadlines, decision dates) + integration (test-score services, financial-aid systems).
- A **construction project tracker** is people (engineers, foremen, subs, owners) + things (drawings, RFIs, change orders, materials) + money (budgets, invoices, retainage) + time (schedules, milestones) + documents (drawings, contracts, daily logs, photos) + workflows (submittal review, RFI loops, change orders, punch lists) + roles (project manager, superintendent, owner, subcontractor) + integration (BIM, accounting, payroll).

The kernel knows nothing about pharmacies, registries, admissions, or construction. The kernel knows about entities, relations, states, workflows, roles, audits. The pharmacy-ness, registry-ness, admissions-ness, construction-ness lives in the manifest.

This is why **one kernel handles all of them**. It is also why **the AI Architect is the moat**: the kernel and the manifest spec are just an exotic toolkit; the AI Architect turns the toolkit into accessibility — anyone who can describe their business gets a working application.

---

## 4. The eight sub-brands

| Sub-brand | Layer | Role |
|---|---|---|
| **CrossEngin Core** | Substrate | Kernel, AI Architect, workflow engine, integration mesh, design system. Never sold alone. |
| **CrossEngin Operate** | App family | ERP family: four commercial verticals × N sub-tiers. The first family and the lighthouse. |
| **CrossEngin Govern** | App family | Government and public sector: procurement, citizen services, licensing, tax, courts, utilities. |
| **CrossEngin Heal** | App family | National and multi-org healthcare digitalization: ministry platforms, EMR rollouts, registries, claims. |
| **CrossEngin Educate** | App family | Education: K-12, university student lifecycle, vocational training, libraries, research-grant administration. |
| **CrossEngin Serve** | App family | NGOs, non-profits, faith-based organizations: programs, grants, M&E, donor CRM. |
| **CrossEngin Build** | Distribution | Self-service app builder for tenants and partners: AI-Architect-driven creation of bespoke apps alongside packaged verticals. |
| **CrossEngin Partner** | Distribution | White-label and OEM channel for system integrators and consultancies who deliver CrossEngin under their own brand. |

The five app-family sub-brands (Operate, Govern, Heal, Educate, Serve) are organized by **buyer type**, not by technical capability. The same kernel powers all of them; the same AI Architect speaks to all their tenants; the same compliance packs are shared across families where they apply. The brand split exists for sales, marketing, and packaging — not for engineering.

CrossEngin Build is the customer-facing entry to the AI Architect for ad-hoc apps. Any tenant on any family can spin up bespoke applications alongside their packaged vertical app.

CrossEngin Partner is the channel mechanism. A system integrator — say, a regional IT consultancy serving a country's health ministries — can package CrossEngin Heal + custom manifests + their own branding and deliver to public-sector buyers under a "Powered by CrossEngin" mark.

---

## 5. Targeted families of organizations

CrossEngin targets **thirteen families** of organizations, covering roughly 150 specific sub-types. The families are not arbitrary; they reflect different buyer journeys, regulatory environments, and compliance expectations.

### Family 1 — Healthcare + Pharma + Life Sciences (Operate / Heal)

**Sub-types:** community pharmacy, pharmacy chain, hospital pharmacy, polyclinic, multi-specialty hospital, diagnostic lab, imaging center, dental clinic and chain, veterinary clinic, optical retail, home-health, telehealth, pharma manufacturer (API and FDF), nutraceutical manufacturer, medical device manufacturer (Class I/II/III), cosmetics GMP manufacturer, CRO, CMO/CDMO, biotech R&D, regulated cannabis (cultivation + dispensary), wholesale pharma distributor, health-insurance TPA.

**Compliance:** 21 CFR Part 11, EU GMP, GxP (GMP, GCP, GLP, GDP, GVP), HIPAA, ICH guidelines, ISO 13485, ISO 9001, country-specific medicine authority registration.

### Family 2 — Retail + F&B + Hospitality + POS (Operate)

**Sub-types:** independent retail, multi-branch retail chain, supermarket, specialty retail (fashion, electronics, books, sports), e-commerce D2C and marketplace, QSR, casual and fine dining, restaurant chain and franchise, café and bakery, cloud kitchen, catering, food truck, hotel (indie and chain), hostel, spa and salon, gym chain, event venue, bar and nightclub, convenience-store chain, duty-free retail.

**Compliance:** PCI-DSS (cards), local food-safety codes (HACCP), labor laws, tax (VAT, sales tax, excise), franchise-disclosure regulations.

### Family 3 — Construction + Real Estate + Facilities Management (Operate)

**Sub-types:** GC residential, GC commercial, civil infrastructure contractor, MEP and specialty trade subcontractors, real-estate developer, property management (residential and commercial), owners' association, real-estate brokerage, listing portal, facilities management provider, cleaning and janitorial, landscaping, pest control, security services, HVAC/elevator/fire-safety maintenance, A&E consultancy, QS/PMC, building-materials trade, ready-mix concrete, steel fabrication, joinery.

**Compliance:** country-specific building codes, occupational health and safety, lien laws, RERA-type real-estate regulators, IFRS for revenue recognition.

### Family 4 — Professional Services + Staffing/ATS + Field Service (Operate)

**Sub-types:** management consultancy, IT consultancy and SI, law firm, accounting and audit, tax advisory, marketing/creative agency, architecture, engineering consultancy, recruiting and staffing, executive search, PEO/outsourced HR, L&D, freelancer marketplace, tutoring, photo/video studio, translation, industrial maintenance, telecom field-tech, ISP installer, plumbing/electrical/handyman dispatch, pool/solar/locksmith/appliance repair.

**Compliance:** professional licensing per discipline, GDPR/HIPAA where data flows in, e-signature laws (eIDAS, ESIGN), client-money trust rules (legal, accounting).

### Family 5 — Government + Public Sector (Govern)

**Sub-types:** e-tendering and procurement portals, vendor master and contract management, citizen-services portals, license and permit issuance, tax administration, customs and border control, land registry and cadastre, vital records, voter registration, court case management, law enforcement records, corrections management, public-transit ticketing, utility (water/electricity/gas) billing, municipal waste, building permit and planning, public-school administration, national ID/e-ID, subsidy and welfare distribution, consular case management, free-zone and customs warehousing.

**Compliance:** country-specific government data protection (often stricter than commercial GDPR), accessibility (WCAG, Section 508), official-language requirements, audit and freedom-of-information regulations.

### Family 6 — Healthcare digitalization at national / multi-org scale (Heal)

Distinct from Family 1, which serves single clinics/hospitals/manufacturers. Family 6 serves the **systems** that coordinate them.

**Sub-types:** ministry-of-health platforms, national EMR/EHR rollouts, primary-health-care network management, vaccination registries, disease-surveillance networks, health-insurance claims platforms, hospital licensing and inspection, national lab networks, drug-registration authorities, telemedicine national rollouts.

**Compliance:** country-specific health data laws (HIPAA-equivalent), WHO reporting standards, ICD-10 / SNOMED-CT / LOINC coding, HL7 FHIR for interoperability.

### Family 7 — Education (Educate)

**Sub-types:** K-12 single school, K-12 chain/district, university student lifecycle (admissions → enrollment → registrar → grades → alumni), vocational training, online learning operator, tutoring chain, library management, research-grant management, test-prep centers.

**Compliance:** FERPA-equivalent student data rules, accreditation bodies, government education ministries.

### Family 8 — NGO / Non-profit / Faith (Serve)

**Sub-types:** international NGO program and grant management with monitoring & evaluation, local charity (donations + cases), religious organizations (members + tithing + events), grant-making foundations, animal welfare and shelters.

**Compliance:** donor-country reporting (USAID, EU, FCDO), tax-exempt status, IFRS for NGOs.

### Family 9 — Financial services adjacent (Operate or Build)

Sub-types lighter than core banking.

**Sub-types:** brokerage back-office, wealth-management practice, microfinance institution, small co-op and credit union, insurance broker and TPA, money-exchange and remittance chain, asset-management back-office, family office.

**Compliance:** KYC/AML, country-specific financial regulators, FATCA/CRS.

### Family 10 — Logistics + Mobility (Operate)

**Sub-types:** 3PL/4PL warehouse, freight forwarder, courier and last-mile, trucking fleet, cold-chain, ride-hail back-office, car rental and leasing, maritime/shipping agent, air-cargo handler.

**Compliance:** country-specific transport regulators, hazmat rules, customs (where applicable).

### Family 11 — Agriculture + Mining + Energy (Operate)

**Sub-types:** farm management (crop and livestock), agro-processor, commodity cooperative, mining concession operations, oilfield services, renewable O&M (solar, wind), grid-storage operations.

**Compliance:** environmental regulators, country-specific resource concession rules, carbon reporting.

### Family 12 — General manufacturing (Operate)

Beyond pharma in Family 1.

**Sub-types:** discrete, process, job-shop, engineer-to-order, contract manufacturing (CMO/CDMO outside pharma), automotive Tier 2/3, textile and apparel, packaging.

**Compliance:** ISO 9001 / 14001 / 45001, country-specific manufacturing licensing, customs and trade.

### Family 13 — Media + Entertainment + Membership + Associations (Operate or Build)

**Sub-types:** film/TV production, music label, sports club and federation, esports organization, digital publisher, talent agency, trade associations, professional licensing bodies, chambers of commerce, private clubs.

**Compliance:** rights management, member-data protection, industry-specific licensing.

---

## 6. The AI Architect as moat

A multi-tenant kernel with a manifest spec is interesting but, by itself, not a defensible product. SAP could have built one (they built ABAP). Salesforce already has one (the object model + Apex). Mendix and OutSystems sell them.

The defensible thing — the thing that turns "platform" into "product anyone can use" — is the **AI Architect**: a conversational layer that takes the toolkit and makes it accessible to people who don't know they're talking to a toolkit.

A community pharmacist describes how they manage prescriptions, insurance claims, narcotic logs, and expiry dates. They get a working pharmacy management system.

A procurement officer at a ministry describes how they want vendor registration, RFP issuance, bid evaluation, contract award, and supplier performance tracking to flow. They get a working e-procurement portal.

A graduate-school admissions director describes the rounds of screening, interview scheduling, decision-making, and applicant communication. They get a working admissions system.

The AI Architect succeeds when these conversations produce a working app **within an hour of first contact** and the resulting app is **honestly fit for production** — not a demo, not a prototype, not a starting point.

To get there, the AI Architect needs:

- A kernel rich enough to express anything a real business needs (otherwise the agent hits walls and produces broken apps).
- A manifest spec dense enough to capture meaningful decisions but constrained enough to validate before applying (otherwise the agent breaks things or applies nonsense).
- A planner-executor agent loop that can think across many steps, iterate, and self-correct.
- A preview-and-approve UX: every change the agent proposes is shown to the user as a structured diff before it touches the live tenant.
- A retrieval-augmented context: the agent reads the tenant's existing manifest, prior conversations, uploaded SOPs, regulatory documents, and similar tenants' configurations (with privacy boundaries) before proposing changes.
- A safety-and-rollback layer: every applied change can be reverted; high-risk operations require explicit secondary confirmation; some operations are forbidden even with confirmation (e.g., disabling audit retention).

The AI Architect is also where CrossEngin's product surface competes with the underlying LLM providers. We will use the best available models — initially via hosted OSS routers (Together, Fireworks) for swap-readiness; eventually self-hosted for cost, data residency, and regulated tenants. This is detailed in ADR-0005 (AI Architect contract) and ADR-0006 (LLM provider router).

---

## 7. Five-year arc

This arc is honest about a solo-or-duo team with no committed customers and no hard deadline. It is the internal plan, not the marketing roadmap.

### Year 1 — Foundation and lighthouse vertical

**Phases 0–5.** Clean up the existing ERP code, build the kernel, build the workflow engine, build the AI Architect v1 (hosted OSS LLM), ship the first CrossEngin Operate vertical (Pharma + Healthcare with four sub-tiers: community pharmacy, polyclinic, hospital, pharma manufacturer), polish, launch SaaS, hunt the first paying customer.

**Goal at end of Year 1:** $1 of recurring revenue, polished public demo, named design partners for the next vertical.

### Year 2 — Second vertical, third vertical, scale

**Phase 6:** Ship CrossEngin Operate Professional Services + Staffing + Field Service. Lighter compute, easier to sell to the consulting/IT companies that will be the first to discover CrossEngin.

**Phase 7:** Begin CrossEngin Operate Construction + Real Estate + FM and Retail + F&B + Hospitality.

**Goal at end of Year 2:** All four CrossEngin Operate verticals exist, **multiple paying customers per vertical**, team grown to 4–6 people funded by revenue.

### Year 3 — Govern, Heal, mobile, on-prem

Ship CrossEngin Govern first manifest (e-procurement portal — easier sale than full citizen services). Ship CrossEngin Heal first manifest (regional EMR rollout or vaccination registry, contingent on landing a public-sector design partner). Ship Capacitor mobile (PWA wrapped with native plugins for BLE scanner, ESC/POS printer, NFC, camera). Ship on-prem edition (Helm charts, license server, offline updates) once a regulated enterprise customer demands it.

### Year 4 — Educate, Serve, BYOC, self-hosted LLM

Ship CrossEngin Educate first manifests (university student lifecycle, K-12 chain administration). Ship CrossEngin Serve first manifest (NGO program + grant management with M&E). Ship BYOC edition (Terraform + Helm + control plane on customer cloud) once enterprise customers in regulated industries demand it. Move AI Architect to self-hosted LLM cluster (likely Qwen 3 or successor on owned or reserved GPUs) for cost, data residency, and regulated-tenant requirements.

### Year 5 — CrossEngin Build, platform velocity

Open CrossEngin Build self-service to all tenants. (CrossEngin Partner channel launches earlier — Year 2–3 — to leverage MENA system-integrator relationships.)

**Goal at end of Year 5:** Team 15–30 people, multi-region SaaS, on-prem and BYOC editions, $10–30M ARR target with healthy gross margins, 50–200 manifests in the public catalog (most contributed by partners using CrossEngin Build).

This arc is conservative. If the AI Architect lands well, growth could be much faster — but designing for conservative growth keeps us honest about runway.

---

## 8. Success metrics

**For the platform:**

- **Time from "tenant describes business" to "tenant has working app":** target < 60 minutes for a simple business, < 1 day for a complex regulated business.
- **AI Architect first-pass accuracy:** fraction of manifests that work without manual correction. Target 80% at v1, 95% at v3.
- **Kernel uptime:** 99.9% Year 1, 99.95% Year 2+.
- **Per-tenant data isolation incidents:** **0**. Any cross-tenant leak is a P0 and a fundamental trust failure.

**For each app family:**

- **Customer satisfaction:** NPS > 50 for active tenants.
- **Time to value:** median first-month tenant should be using > 5 generic-renderer-driven daily workflows within 14 days of signup.
- **Compliance pack coverage:** when a tenant invokes a regulated compliance pack (e.g., 21 CFR Part 11), the resulting app passes a regulator-grade audit checklist with no manual remediation.

**For the business:**

- **Year 1:** $1 of recurring revenue; one polished family; first design partners on the next family.
- **Year 2:** ARR > $500K; team funded by revenue; two families live.
- **Years 3–5:** ARR > $5M, $15M, $30M (conservative trajectory); team 15–30 people; four+ families live; channel partners producing manifests.

These numbers are aspirational floors. Reality will diverge. The goal is the trajectory, not the precise figures.

---

## 9. What CrossEngin is NOT

To stay honest, explicit non-goals:

- **Not a general-purpose programming environment.** CrossEngin Build will let tenants and partners create apps, but it does so through the manifest abstraction, not by writing arbitrary code. If you want a Turing-complete app platform, use Replit or Vercel.
- **Not a low-code drag-and-drop builder for IT departments.** The AI Architect *can* drive everything by conversation. Drag-and-drop is a secondary UX, not the primary one. We are not Mendix.
- **Not a Salesforce competitor on CRM-only deployments.** Where a customer wants CRM-only and uses 5% of Salesforce, our pricing won't beat Salesforce. We are not a single-app SaaS — we win on breadth and compliance.
- **Not an Odoo or ERPNext replacement on open-source-only terms.** We will have an open-source kernel and OSS-licensed manifests, but the SaaS edition with hosted AI Architect is the primary product. We are not a community-maintained ERP.
- **Not a generic "AI agent" platform.** The AI Architect is purpose-built for the kernel + manifest abstraction. It is not a general-purpose autonomous agent. It will not browse the web, write arbitrary code, or operate outside the kernel's surface.
- **Not a national e-government turnkey solution sold to ministries on day one.** CrossEngin Govern starts with single-product manifests (e-procurement, licensing) that deploy in months. We will grow into national-scale capability — we will not pretend to be it from launch.
- **Not a healthcare records vendor competing with Epic or Cerner.** CrossEngin Heal serves national digitalization programs and multi-organization coordination layers, not single-hospital deep EMR systems. We integrate with Epic and Cerner where they exist; we do not replace them.
- **Not a free-tier consumer product.** Free trial yes; free forever no. Our buyers are businesses, agencies, and organizations. They pay because they get real value.

These non-goals will evolve. Each evolution must be a deliberate decision, not a drift.

---

## 10. Resolved decisions and remaining open questions

### Decisions made (2026-05-11 review)

- **Source posture.** Everything closed source (kernel, manifest spec, AI Architect, manifests, compliance packs). Docs (`amoufaq5/CrossEngin`) remain CC-BY 4.0 for architectural transparency.
- **Pricing.** Per-tenant flat tier + AI usage metered for CrossEngin Operate v1; different list pricing models per family (Operate vs. Govern vs. Heal vs. Educate vs. Serve).
- **First region.** UAE / Middle East. Supabase has no UAE region directly; v1 deploys to Frankfurt (eu-central-1) until a UAE-resident contract justifies self-hosted Supabase in-country.
- **LLM provider for v1.** Fireworks (hosted OSS — Qwen / DeepSeek). Anthropic and Together added as routable options through ADR-0006 when accuracy or cost demands shift.
- **Embedding model.** Self-hosted BGE-large-en / BGE-M3 for multilingual retrieval. Requires a GPU container; runtime detailed in ADR-0006.
- **Self-hosted LLM transition.** Triggered by ARR plus regulated-tenant in-region inference demand (likely Year 3+).
- **On-prem and BYOC.** On-prem Year 3, BYOC Year 4 — pulled earlier if a MENA ministry contract requires sovereign deployment.
- **Trademark + brand protection.** All sub-brand trademark filings deferred to Phase 5. `crossengin.com` is the primary domain target if available; `crossengin.io` is the alternate.
- **Regulatory partnerships.** Standards certifications only (SOC 2, ISO 27001, HITRUST). No direct FDA / EMA / national-ministry partnerships in the five-year plan.
- **Compliance pack roadmap.** Pharma + healthcare-led: 21 CFR Part 11, EU GMP, UAE MoH, HIPAA, GDPR.
- **Workforce.** First hire is a senior backend engineer around Year 2 (revenue gated). Subsequent hires (product designer, compliance officer, commercial) sequence with ARR.
- **CrossEngin Partner channel.** Renamed from "Power" to "Partner." Launches Year 2–3 (accelerated from Year 5) to leverage MENA system-integrator relationships.
- **Year 5 ambition.** Independent profitable SaaS company (no acquisition track, no VC growth round, no sovereign-tech partnership track).
- **Geography sequence after ME.** EU (Frankfurt) in Year 2; US in Year 3.
- **AI Architect productization.** Internal to CrossEngin only; no standalone API or add-on SKUs.

### Remaining open questions

- **UAE in-region inference.** When does the first UAE-resident-data tenant arrive, and does it justify self-hosted Supabase + self-hosted LLM in-country before the standard ARR trigger? Revisit when first ME regulated tenant pipelines.
- **On-prem licensing model.** Per-CPU, per-tenant, per-named-user, or flat enterprise. Decide before the first on-prem contract (Year 3).
- **Pricing differentiation depth.** Each family has its own list pricing; the specific structure for Govern (per-project + deployment fee), Heal (per-million-citizen-record), Educate (per-student-FTE), Serve (per-program + non-profit discount) is sketched but not finalized. Decide per family when each ships.
- **Visual identity per sub-brand.** Each sub-brand visually distinct, or shared visual language with accent colors? Decide in Phase 4 design pass.
- **Mid-term funding posture.** Independent profitable target may still warrant opportunistic angel / strategic checks. Revisit at end of Year 1 when first revenue lands.

---

## 11. Glossary

- **Tenant** — A single customer organization with its own isolated logical environment in CrossEngin. Has users, data, manifests, configuration; data fully isolated from other tenants.
- **Manifest** — A declarative bundle defining an application on the kernel. Includes entity definitions, relations, workflows, roles, views, forms, reports, integrations, compliance pack references.
- **Kernel** — The substrate that runs manifests. Provides multi-tenancy, data isolation, dynamic schema provisioning, workflow runtime, RBAC/ABAC, audit, files, jobs, search, reporting, integration plumbing.
- **AI Architect** — The conversational agent that interviews tenants and produces or modifies manifests.
- **Sub-vertical** — A specific sub-type within a family (e.g., "community pharmacy" within Healthcare + Pharma + Life Sciences). Each sub-vertical typically has its own manifest.
- **Vertical pack** — A bundle of related sub-vertical manifests sold as a unit (e.g., Pharma + Healthcare pack covers community pharmacy, polyclinic, hospital, pharma manufacturer).
- **App family** — A go-to-market brand grouping (Operate, Govern, Heal, Educate, Serve, Build, Partner). Distinct from "vertical" — a family contains multiple verticals.
- **Generic renderer** — A UI component that knows how to display a List, Record, Kanban, Calendar, Map, Dashboard, or Form for any entity defined in any manifest, without being hardcoded for that entity.
- **Compliance pack** — A declarative bundle of rules, retention policies, audit hooks, e-signature requirements, validation rules, and required workflows that implement a regulatory standard (e.g., 21 CFR Part 11, HIPAA).
- **Provider router** — The abstraction that routes AI Architect calls to one of several underlying LLM providers (Fireworks at v1; later Anthropic, OpenAI, Together, self-hosted vLLM as routable options).

---

## Status

| Field | Value |
|---|---|
| **Document status** | Draft 2 (decisions incorporated) |
| **Last updated** | 2026-05-11 |
| **Maintainer** | amoufaq5 |
| **Next review** | After ADRs 0006–0025 are accepted |

This document is revised after each batch of accepted ADRs, since each ADR may clarify or contradict a passage here. Where this document and an accepted ADR conflict, the ADR wins and this document is updated to match.
