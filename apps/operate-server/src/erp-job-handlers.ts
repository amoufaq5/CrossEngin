import { resolvedFieldNames } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel";
import {
  approveClassTransitions,
  isApproveClassTransition,
  parseDecimal,
  ReadCeilingExceeded,
  type EntityRecord,
  type ListFilter,
  type SettingsStore,
  type SystemEntityAccess,
  type SystemWriteResult,
  type TenantEntityAccess,
  TenantNotWritable,
  TenantStandingUnknown,
  type TenantStandingReader,
} from "@crossengin/operate-runtime";
import type { JobHandlerContext, JobHandlerProvider, JobHandlerResult } from "@crossengin/workflow-runtime-pg";

/**
 * Real handlers for the `erp-core` job declarations whose work the shipped entities can express,
 * and the stated reason for every one they cannot.
 *
 * **Every write goes through the gateway's own handlers**, never the store: a job holds a
 * `TenantEntityAccess` from `@crossengin/operate-runtime`'s system writer, which dispatches to the
 * very handler a request is served by. So the double-entry guard refuses an unbalanced depreciation
 * entry, the document locks hold, a state moves only by a transition, the recognition GL posting a
 * transition triggers is posted, and the audit row is written in the write's own transaction —
 * filed under the job run, naming no person. Authority is the deployment's `--job-actor-role`,
 * checked against the manifest's grants like any principal's.
 *
 * Every handler is **idempotent by a marker on the record it writes**, because the queue retries a
 * failed run and a re-run of a half-finished one must finish it rather than repeat it: a
 * depreciation entry's memo, an invoice's notes, a stock movement's reference, a reorder PO's notes.
 */

/** Rows one read may return before the run refuses rather than act on a prefix (ADR-0367). */
export const JOB_READ_CEILING = 20_000;

/** Why a declared job has no handler in this binary. */
export interface JobHandlerAbsence {
  readonly jobId: string;
  readonly reason: string;
}

/**
 * The `erp-core` declarations this binary deliberately serves with no handler, each with the fact
 * that decides it. Written down so the boot line can say *why* rather than only *that*, and so a
 * handler is never added for one of them by someone reading "unserved" as "unfinished".
 */
export const ERP_JOB_ABSENCES: Readonly<Record<string, string>> = Object.freeze({
  "erp-core-payment-gateway-sync":
    "polls a payment gateway (Stripe/Adyen) for settled transactions; no gateway reconciliation client exists in this repository",
  "erp-core-bank-statement-import":
    "imports bank statement lines from a banking integration (Plaid/MT940); no banking client exists in this repository",
  "erp-core-fx-rate-refresh":
    "pulls rates from an external rates provider; no rates client exists in this repository",
  "erp-core-shipment-tracking-sync":
    "polls carrier APIs (FedEx/DHL/UPS); no carrier client exists in this repository",
  "erp-core-tax-calculation":
    "calls an external tax engine (Avalara/TaxJar); no tax-engine client exists in this repository",
  "erp-core-einvoice-submission":
    "submits to a clearance portal (Peppol/ZATCA/SAT); no clearance client exists in this repository, and its event name has no producer",
  "erp-core-crm-lead-enrichment":
    "calls a firmographics provider (Clearbit/ZoomInfo); no enrichment client exists in this repository",
  "erp-core-payroll-disbursement":
    "pushes disbursements to a payroll/banking provider; no such client exists, the pack declares no Payroll entity, and its event name has no producer",
  "erp-core-payment-received-handler":
    "its work — applying a payment to the invoice it names and marking the invoice paid once covered — is already done in the same transaction as the Payment write by paymentApplicationEffect, so a handler would apply every payment twice; its event name also has no producer",
});

type Operation = { readonly entity: string; readonly transition: string };

interface HandlerRequirements {
  /** Entity → the fields the handler reads or writes on it. */
  readonly fields: Readonly<Record<string, readonly string[]>>;
  /** Lifecycle transitions the handler fires. */
  readonly transitions: readonly Operation[];
  /** Entities whose records the handler creates, which a person may later have to approve. */
  readonly creates: readonly string[];
}

/** What a handler in this module actually performs, where its declaration promises more. */
const PARTIAL_COVERAGE: Readonly<Record<string, string>> = Object.freeze({
  "erp-core-overdue-invoice-reminder":
    "moves past-due invoices to 'overdue'; the reminder email its description promises is NOT sent — an account's billing_email is not a notification recipient and no channel addresses it",
  "erp-core-depreciation-run":
    "posts straight-line depreciation only; an asset declared declining_balance or units_of_production is counted and skipped, and the run refuses until the tenant's depreciationExpenseAccountCode and accumulatedDepreciationAccountCode settings name real accounts; a missed month is caught up only after the asset's latest posted one and at most 12 months back, and a month closed before its charge posted is posted in the run's own month",
  "erp-core-sales-order-to-invoice":
    "needs each tenant's finance.defaultPaymentTermsDays: an Account carries no payment terms, so that setting is the invoice's only due_date, and an order of a tenant without it fails payment_terms_unconfigured with nothing written",
  "erp-core-work-order-completion":
    "writes the issue and receipt stock movements, which move each StockLevel and post at standard cost against the inventory variance account (there is no work-in-progress account); a component issue that would take stock below zero is refused unless the tenant's inventory.allowNegativeStock is set, and the finished good is then not received until a later run consumes it, and an item with no standard_cost moves quantity and posts nothing",
});

const REQUIREMENTS: Readonly<Record<string, HandlerRequirements>> = Object.freeze({
  "erp-core-overdue-invoice-reminder": {
    fields: { Invoice: ["state", "due_date"] },
    transitions: [{ entity: "Invoice", transition: "mark_overdue" }],
    creates: [],
  },
  "erp-core-depreciation-run": {
    fields: {
      FixedAsset: [
        "state",
        "acquisition_date",
        "acquisition_cost",
        "depreciation_method",
        "useful_life_months",
        "salvage_value",
      ],
      JournalEntry: ["entry_date", "source", "memo", "state"],
      JournalLine: ["journal_entry_id", "ledger_account_id", "debit", "credit", "currency", "description"],
      LedgerAccount: ["account_code"],
    },
    transitions: [{ entity: "JournalEntry", transition: "post" }],
    creates: ["JournalEntry", "JournalLine"],
  },
  "erp-core-inventory-reorder": {
    fields: {
      Item: ["status", "reorder_point", "reorder_quantity", "name"],
      StockLevel: ["item_id", "quantity_on_hand", "quantity_reserved", "quantity_incoming"],
      PurchaseOrder: ["vendor_id", "state", "order_date", "currency", "notes", "subtotal", "total"],
      PurchaseOrderLine: ["purchase_order_id", "item_id", "quantity", "unit_price", "received_quantity", "line_total"],
    },
    transitions: [],
    creates: ["PurchaseOrder", "PurchaseOrderLine"],
  },
  "erp-core-sales-order-to-invoice": {
    fields: {
      SalesOrder: ["account_id", "state", "currency", "tax_total"],
      SalesOrderLine: ["sales_order_id", "description", "quantity", "fulfilled_quantity", "unit_price"],
      Invoice: ["account_id", "currency", "issue_date", "subtotal", "tax_total", "total", "notes"],
      InvoiceLine: ["invoice_id", "position", "description", "quantity", "unit_price", "line_total"],
    },
    transitions: [{ entity: "SalesOrder", transition: "invoice" }],
    creates: ["Invoice", "InvoiceLine"],
  },
  "erp-core-work-order-completion": {
    fields: {
      WorkOrder: ["state", "item_id", "bom_id", "warehouse_id", "completed_quantity"],
      BillOfMaterials: ["output_quantity"],
      BomLine: ["bom_id", "component_item_id", "quantity", "scrap_pct"],
      StockMovement: ["item_id", "warehouse_id", "movement_type", "quantity", "reference", "reason", "occurred_at"],
    },
    transitions: [],
    creates: ["StockMovement"],
  },
});

/** Which declarations of this manifest this binary will serve, and why each other one is not. */
export interface ErpJobCoverage {
  readonly handled: readonly string[];
  readonly declined: readonly JobHandlerAbsence[];
  /** Served declarations whose handler does less than the declaration's description says. */
  readonly partial: readonly JobHandlerAbsence[];
  readonly actorRoles: readonly string[];
}

export interface ErpJobCoverageOptions {
  /**
   * `--segregation-of-duties`. Required, because it decides what a job may finish: a record a job
   * writes has no recorded creator (a job names no person), and `makerCheckerRefusal` answers
   * `maker_checker_unverifiable` for such a record **whoever fires the approve-class transition** —
   * the job, and every person after it. A draft left "for a person to post" could never be posted.
   */
  readonly segregationOfDuties: boolean;
}

/**
 * Pure: decided from the manifest and the actor roles alone, so it can be asked before anything is
 * compiled and gives one answer on every replica of one deployment — which is what lets the
 * producers enqueue only what this binary serves without starving a worker tier.
 *
 * A requirement is checked over the resolved field set and the lifecycle transitions, so a pack
 * that replaces `WorkOrder` with one lacking `completed_quantity` (`erp-construction` does) declines
 * the handler by name instead of failing every run with a 422.
 */
export function erpJobCoverage(
  manifest: Manifest,
  actorRoles: readonly string[],
  options: ErpJobCoverageOptions,
): ErpJobCoverage {
  const approveClass = options.segregationOfDuties ? approveClassTransitions(manifest) : [];
  const declared = new Set(Object.keys(manifest.jobs ?? {}));
  const handled: string[] = [];
  const declined: JobHandlerAbsence[] = [];
  const partial: JobHandlerAbsence[] = [];
  const roleNames = new Set(Object.keys(manifest.roles ?? {}));
  const undeclaredRole = actorRoles.filter((r) => !roleNames.has(r));
  for (const jobId of [...declared].sort()) {
    const absence = ERP_JOB_ABSENCES[jobId];
    if (absence !== undefined) {
      declined.push({ jobId, reason: absence });
      continue;
    }
    const requirements = REQUIREMENTS[jobId];
    if (requirements === undefined) continue;
    if (actorRoles.length === 0 || undeclaredRole.length === actorRoles.length) {
      declined.push({
        jobId,
        reason: `--job-actor-role names no role this manifest declares (${actorRoles.join(", ") || "none"}), so no write a job made could be authorized`,
      });
      continue;
    }
    const missing = missingRequirements(manifest, requirements);
    if (missing.length > 0) {
      declined.push({ jobId, reason: `this manifest does not declare ${missing.join(", ")}` });
      continue;
    }
    if (options.segregationOfDuties) {
      const fired = requirements.transitions.filter((t) => isApproveClassTransition(t.entity, t.transition));
      if (fired.length > 0) {
        declined.push({
          jobId,
          reason:
            `--segregation-of-duties refuses ${fired.map((t) => `${t.entity}.${t.transition}`).join(", ")} to a job:` +
            " a job names no person, and what it would draft would record no creator, which the maker-checker" +
            " rule refuses for every person afterwards too (maker_checker_unverifiable) — so nothing is drafted",
        });
        continue;
      }
    }
    handled.push(jobId);
    const notes: string[] = [];
    const note = PARTIAL_COVERAGE[jobId];
    if (note !== undefined) notes.push(note);
    const unapprovable = approveClass.filter((q) => requirements.creates.includes(q.slice(0, q.indexOf("."))));
    if (unapprovable.length > 0) {
      notes.push(
        `under --segregation-of-duties the records it creates name no creator, so ${unapprovable.join(", ")}` +
          " refuses them for every person (maker_checker_unverifiable); a person must re-enter one to approve it",
      );
    }
    if (notes.length > 0) partial.push({ jobId, reason: notes.join("; ") });
  }
  return { handled, declined, partial, actorRoles };
}

function missingRequirements(manifest: Manifest, req: HandlerRequirements): string[] {
  const missing: string[] = [];
  const byName = new Map((manifest.entities ?? []).map((e) => [e.name, e]));
  for (const [entity, fields] of Object.entries(req.fields)) {
    const decl = byName.get(entity);
    if (decl === undefined) {
      missing.push(`entity ${entity}`);
      continue;
    }
    const names = resolvedFieldNames(decl, manifest.traits ?? []);
    for (const f of fields) if (!names.has(f)) missing.push(`${entity}.${f}`);
  }
  for (const { entity, transition } of req.transitions) {
    const found = Object.values(manifest.workflows ?? {}).some(
      (wf) => wf.kind === "entityLifecycle" && wf.entity === entity && wf.transitions.some((t) => t.name === transition),
    );
    if (!found) missing.push(`transition ${entity}.${transition}`);
  }
  return missing;
}

/** Where a run finds its tenant's entity layer: the deployment's gateway, or the tenant's own. */
export type JobAccessResolution =
  | { readonly kind: "access"; readonly access: SystemEntityAccess }
  | { readonly kind: "unavailable"; readonly reason: string; readonly retryable: boolean };

export type JobAccessResolver = (tenantId: string) => Promise<JobAccessResolution>;

export interface ErpJobProvidersInput {
  readonly coverage: ErpJobCoverage;
  /**
   * Asked per run, because a tenant serving its own activated manifest is served by its own
   * compiled gateway (ADR-0314): a job writing through the deployment's would write that tenant's
   * rows under another manifest's grants and guards.
   */
  readonly resolveAccess: JobAccessResolver;
  /**
   * Whether the run's tenant may be written. Required and asked first, before the run reads
   * anything (ADR-0469): a run for a `suspended`, `archived` or `pending_deletion` tenant is still
   * *claimed* — so it is finalized and reported, never silently skipped — and then refused here,
   * non-retryably, because the tenant's state is a fact the next attempt would meet again.
   */
  readonly tenantStanding: TenantStandingReader;
  readonly settings: SettingsStore;
  readonly now?: () => Date;
}

interface Run {
  readonly ctx: JobHandlerContext;
  readonly access: TenantEntityAccess;
  readonly at: Date;
  readonly settings: SettingsStore;
  readonly tally: Tally;
}

/** A sweep's outcome per record, so one refused record does not stop the others being written. */
class Tally {
  readonly counts: Record<string, number> = {};
  readonly refused: { readonly where: string; readonly status: number; readonly error: string }[] = [];

  count(key: string, n = 1): void {
    this.counts[key] = (this.counts[key] ?? 0) + n;
  }

  refuse(where: string, r: Extract<SystemWriteResult, { kind: "refused" }>): void {
    this.refused.push({ where, status: r.status, error: r.error });
  }
}

type Impl = (run: Run) => Promise<JobHandlerResult | null>;

const IMPLEMENTATIONS: Readonly<Record<string, Impl>> = Object.freeze({
  "erp-core-overdue-invoice-reminder": overdueInvoices,
  "erp-core-depreciation-run": depreciationRun,
  "erp-core-inventory-reorder": inventoryReorder,
  "erp-core-sales-order-to-invoice": salesOrderToInvoice,
  "erp-core-work-order-completion": workOrderCompletion,
});

/** The job ids this module has an implementation for — the domain `erpJobCoverage` decides over. */
export const ERP_JOB_HANDLER_IDS: readonly string[] = Object.freeze(Object.keys(IMPLEMENTATIONS).sort());

export function buildErpJobProviders(input: ErpJobProvidersInput): readonly JobHandlerProvider[] {
  const now = input.now ?? (() => new Date());
  return input.coverage.handled.map((jobId): JobHandlerProvider => {
    const impl = IMPLEMENTATIONS[jobId];
    if (impl === undefined) throw new Error(`no implementation for covered job ${jobId}`);
    return {
      serves: "job",
      jobId,
      handler: async (ctx) => {
        let resolved: JobAccessResolution;
        try {
          resolved = await input.resolveAccess(ctx.tenantId);
        } catch {
          return failed("tenant_gateway_unresolved", "the tenant's gateway could not be resolved", true);
        }
        if (resolved.kind === "unavailable") {
          return failed("tenant_gateway_unavailable", resolved.reason, resolved.retryable);
        }
        const access = resolved.access.forTenant(ctx.tenantId, {
          roles: input.coverage.actorRoles,
          origin: { kind: "job", jobId: ctx.jobDefinitionId, runId: ctx.runId },
          standing: input.tenantStanding,
        });
        const tally = new Tally();
        try {
          // Asked once up front so a blocked tenant's run reads nothing; every write asks again, so a
          // tenant whose state changes while the run is under way stops being written at that write.
          await access.assertWritable();
          const early = await impl({ ctx, access, at: fireTime(ctx, now), settings: input.settings, tally });
          return early ?? conclude(tally);
        } catch (err) {
          if (err instanceof TenantNotWritable) {
            // The code and the message carry the lifecycle state's name and nothing from any row.
            // Writes made before a mid-run state change stay made, and the markers on them make a
            // later run — once the tenant is writable again — finish rather than repeat the work.
            return failed("tenant_not_writable", err.message, false);
          }
          if (err instanceof TenantStandingUnknown) {
            return failed("tenant_standing_unknown", "the tenant's lifecycle state could not be read", true);
          }
          // A ceiling is a property of the tenant's data and will be there next attempt too, so it
          // is a non-retryable failure rather than a throw — a throw is retried up to the job's
          // attempt ceiling, re-reading the same 20,000 rows each time for an answer that cannot change.
          if (err instanceof ReadCeilingExceeded) {
            return failed("read_ceiling_exceeded", err.message, false);
          }
          throw err;
        }
      },
    };
  });
}

function failed(code: string, message: string, retryable: boolean): JobHandlerResult {
  return { status: "failed", error: { code, message }, retryable };
}

/**
 * A sweep that wrote what it could and was refused on some records fails, naming each refusal by
 * record and code — never by value. A refusal at 5xx is retried; a 4xx is a fact about the data
 * that a retry would meet again. The writes that landed stay landed and the markers make the retry
 * skip them.
 */
function conclude(tally: Tally): JobHandlerResult {
  if (tally.refused.length === 0) return { status: "completed", output: tally.counts };
  const transient = tally.refused.some((r) => r.status >= 500);
  const shown = tally.refused
    .slice(0, 5)
    .map((r) => `${r.where} ${r.status.toString()} ${r.error}`)
    .join("; ");
  const more = tally.refused.length > 5 ? ` (+${(tally.refused.length - 5).toString()} more)` : "";
  return failed(
    transient ? "writes_failed" : "writes_refused",
    `${tally.refused.length.toString()} write(s) refused: ${shown}${more}; done: ${JSON.stringify(tally.counts)}`,
    transient,
  );
}

function fireTime(ctx: JobHandlerContext, now: () => Date): Date {
  const trigger = ctx.trigger;
  if (trigger !== null && typeof trigger === "object") {
    const fireAt = (trigger as { fireAt?: unknown }).fireAt;
    if (typeof fireAt === "string") {
      const t = new Date(fireAt);
      if (!Number.isNaN(t.getTime())) return t;
    }
  }
  return now();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function str(r: EntityRecord | null | undefined, field: string): string | null {
  const v = r?.[field];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A decimal at `scale` as integer units, rounded half away from zero; null when not a numeral. */
export function units(value: unknown, scale: number): bigint | null {
  if (value === null || value === undefined) return null;
  const d = parseDecimal(value);
  if (d === null) return null;
  let u = d.units;
  if (d.scale < scale) u = u * 10n ** BigInt(scale - d.scale);
  else if (d.scale > scale) u = divRound(u, 10n ** BigInt(d.scale - scale));
  return d.negative ? -u : u;
}

/** `a / b` for non-negative `a` and positive `b`, rounded half away from zero. */
function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b) * 2n >= b ? q + 1n : q;
}

/** `a * b`, each at its own scale, rounded to `scale`. */
function mul(a: bigint, aScale: number, b: bigint, bScale: number, scale: number): bigint {
  const raw = a * b;
  const from = aScale + bScale;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const r = from > scale ? divRound(abs, 10n ** BigInt(from - scale)) : abs * 10n ** BigInt(scale - from);
  return negative ? -r : r;
}

export function renderUnits(u: bigint, scale: number): string {
  const negative = u < 0n;
  const text = (negative ? -u : u).toString().padStart(scale + 1, "0");
  const body = scale === 0 ? text : `${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
  return negative ? `-${body}` : body;
}

function aborted(run: Run): JobHandlerResult | null {
  return run.ctx.signal.aborted ? failed("cancelled", "the run was cancelled while it ran", false) : null;
}

async function readAll(run: Run, entity: string, filters: readonly ListFilter[], computing: string) {
  return run.access.readAll(entity, { filters }, { ceiling: JOB_READ_CEILING, computing });
}

// ---- overdue invoices ---------------------------------------------------------------------------

async function overdueInvoices(run: Run): Promise<JobHandlerResult | null> {
  const today = isoDate(run.at);
  const due = await readAll(
    run,
    "Invoice",
    [
      { field: "state", value: "sent" },
      { field: "due_date", op: "lt", value: today },
    ],
    "the invoices past their due date",
  );
  for (const inv of due) {
    const stop = aborted(run);
    if (stop !== null) return stop;
    const id = str(inv, "id");
    if (id === null) continue;
    const r = await run.access.transition("Invoice", id, "mark_overdue");
    if (r.kind === "written") run.tally.count("marked_overdue");
    else if (r.status === 409) run.tally.count("moved_by_someone_else");
    else run.tally.refuse(`Invoice ${id} mark_overdue`, r);
  }
  run.tally.count("examined", due.length);
  return null;
}

// ---- depreciation -------------------------------------------------------------------------------

/** The month before the fire month, as `YYYY-MM`, and its last day. */
export function depreciationPeriod(at: Date): { readonly key: string; readonly year: number; readonly month: number; readonly endDate: string } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth(); // 0-based: the previous month is m, 1-based
  const year = m === 0 ? y - 1 : y;
  const month = m === 0 ? 12 : m;
  const endDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { key: `${year.toString()}-${String(month).padStart(2, "0")}`, year, month, endDate };
}

/**
 * One period's straight-line charge, in units at scale 2, or null when the asset is not
 * depreciating in that period.
 *
 * The convention is the first full month: an asset acquired in March is first charged for April,
 * and charged for exactly `life` months. Each month carries `round(depreciable / life)` and the last
 * carries the remainder, so the charges sum to the depreciable amount exactly — rounding is not
 * allowed to leave a cent on the books or take one too many.
 */
export function straightLineCharge(input: {
  readonly acquisitionDate: string;
  readonly cost: bigint;
  readonly salvage: bigint;
  readonly lifeMonths: number;
  readonly year: number;
  readonly month: number;
}): bigint | null {
  const acq = /^(\d{4})-(\d{2})-\d{2}$/.exec(input.acquisitionDate);
  if (acq === null || input.lifeMonths <= 0) return null;
  const k = input.year * 12 + input.month - (Number(acq[1]) * 12 + Number(acq[2]));
  if (k < 1 || k > input.lifeMonths) return null;
  const depreciable = input.cost - input.salvage;
  if (depreciable <= 0n) return null;
  const life = BigInt(input.lifeMonths);
  const monthly = divRound(depreciable, life);
  const before = monthly * BigInt(k - 1);
  const remaining = depreciable - before;
  const charge = k === input.lifeMonths ? remaining : monthly < remaining ? monthly : remaining;
  return charge > 0n ? charge : null;
}

const DEPRECIATING_STATES = new Set(["in_service", "under_maintenance"]);

/**
 * How many periods back a run reaches for an asset's missed charges, at most. Bounded, because the
 * lookup is a read of every depreciation entry in the window, which is up to one entry per asset per
 * period — see {@link depreciationCatchUpWindow} for how the window shrinks with the asset count.
 */
export const DEPRECIATION_CATCH_UP_PERIODS = 12;

/**
 * The catch-up window for a tenant holding `assets` fixed assets: as many periods as keep the window's
 * entries under `JOB_READ_CEILING`, between one and {@link DEPRECIATION_CATCH_UP_PERIODS}. A fixed
 * twelve made the entry read exceed the ceiling at 1,667 assets, so a tenant whose single-period run
 * worked failed the whole run `read_ceiling_exceeded`; at one period the read is the old one. Counted
 * over every asset rather than the eligible ones, since a disposed asset's entries sit in the window too.
 */
export function depreciationCatchUpWindow(assets: number): number {
  return Math.max(1, Math.min(DEPRECIATION_CATCH_UP_PERIODS, Math.floor(JOB_READ_CEILING / Math.max(1, assets))));
}

type DepreciationPeriod = ReturnType<typeof depreciationPeriod>;

/** The period `n` months before `p` (negative `n` moves forward). */
export function shiftDepreciationPeriod(p: DepreciationPeriod, n: number): DepreciationPeriod {
  const index = p.year * 12 + (p.month - 1) - n;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return depreciationPeriod(new Date(Date.UTC(year, month, 1)));
}

const MARKER = /\[depreciation:([^:\]]+):(\d{4}-\d{2})\]/;

/**
 * Which periods a run charges an asset for, oldest first.
 *
 * The run's own period always; every period after the asset's latest **posted** entry in the window
 * up to it, which is the catch-up for months a run failed or never ran; and every period holding a
 * **draft** for the asset in the window, which is how a draft a refused run left behind is resumed
 * instead of being orphaned. An asset with no posted entry in the window is charged for the run's
 * period and its drafts only: the job does not assume what was booked before it first ran — a
 * migrated asset's earlier depreciation may be in another system, and back-filling from acquisition
 * would post it twice.
 */
export function depreciationPeriodsDue(
  current: DepreciationPeriod,
  posted: ReadonlySet<string>,
  drafts: ReadonlySet<string>,
  periods: number = DEPRECIATION_CATCH_UP_PERIODS,
): readonly DepreciationPeriod[] {
  const window = Array.from({ length: periods }, (_, i) => shiftDepreciationPeriod(current, i)).reverse();
  let latestPosted = -1;
  window.forEach((p, i) => {
    if (posted.has(p.key)) latestPosted = i;
  });
  const due = window.filter(
    (p, i) => p.key === current.key || drafts.has(p.key) || (latestPosted >= 0 && i > latestPosted),
  );
  // A draft older than the window is still a charge a refused run started and must be finished:
  // the window bounds the *catch-up* read, and a draft is found by its own unbounded read instead
  // (ADR-0469), so it is resumed however far back it sits. Newer-than-current drafts are not charged
  // early; there is no such draft unless a clock moved backwards.
  const first = window[0]?.key ?? current.key;
  const older = [...drafts]
    .filter((key) => key < first && DEPRECIATION_PERIOD_KEY.test(key))
    .sort()
    .map(depreciationPeriodFromKey);
  return [...older, ...due];
}

const DEPRECIATION_PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The period a `YYYY-MM` marker names — the inverse of `depreciationPeriod`'s `key`. */
export function depreciationPeriodFromKey(key: string): DepreciationPeriod {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  // `depreciationPeriod` answers the month *before* the date it is given.
  return depreciationPeriod(new Date(Date.UTC(year, month, 1)));
}

async function depreciationRun(run: Run): Promise<JobHandlerResult | null> {
  const period = depreciationPeriod(run.at);
  const assets = await readAll(run, "FixedAsset", [], "the fixed assets to depreciate");
  const eligible: EntityRecord[] = [];
  for (const asset of assets) {
    if (!DEPRECIATING_STATES.has(str(asset, "state") ?? "")) continue;
    const method = str(asset, "depreciation_method") ?? "straight_line";
    if (method === "none") continue;
    if (method !== "straight_line") {
      run.tally.count(`method_unsupported_${method}`);
      continue;
    }
    const cost = units(asset["acquisition_cost"], 2);
    const life = asset["useful_life_months"];
    if (cost === null || typeof life !== "number" || str(asset, "acquisition_date") === null) {
      run.tally.count("missing_depreciation_basis");
      continue;
    }
    eligible.push(asset);
  }
  if (eligible.length === 0) {
    run.tally.count("charges_due", 0);
    return null;
  }

  // Every depreciation entry in the catch-up window, keyed by the marker's (asset, period) rather
  // than by its date: a catch-up for a closed month is dated into an open one, and a draft a refused
  // run left must be found again whatever date it carries.
  const windowPeriods = depreciationCatchUpWindow(assets.length);
  if (windowPeriods < DEPRECIATION_CATCH_UP_PERIODS) run.tally.count("catch_up_window_periods", windowPeriods);
  const windowStart = shiftDepreciationPeriod(period, windowPeriods - 1);
  const existing = await readAll(
    run,
    "JournalEntry",
    [
      { field: "source", value: "depreciation" },
      { field: "entry_date", op: "gte", value: `${windowStart.key}-01` },
    ],
    "the depreciation entries in the catch-up window",
  );
  // Every depreciation **draft**, however old, read separately and with no date bound (ADR-0469).
  // The window read alone orphaned a draft a refused run left once its period fell out of the window:
  // nothing would ever find it again, so the charge was neither posted nor reported. The population
  // is the drafts refused runs left behind, which is small, and the read still refuses past the
  // ceiling rather than acting on a prefix.
  const strandedDrafts = await readAll(
    run,
    "JournalEntry",
    [
      { field: "source", value: "depreciation" },
      { field: "state", value: "draft" },
    ],
    "the depreciation drafts earlier runs left behind",
  );
  const byMarker = new Map<string, EntityRecord>();
  for (const je of existing) {
    const m = MARKER.exec(str(je, "memo") ?? "");
    if (m !== null) byMarker.set(m[0], je);
  }
  // Merged without overwriting: a draft the window read already found is the same row.
  for (const je of strandedDrafts) {
    const m = MARKER.exec(str(je, "memo") ?? "");
    if (m !== null && !byMarker.has(m[0])) byMarker.set(m[0], je);
  }

  const charges: { readonly asset: EntityRecord; readonly period: DepreciationPeriod; readonly amount: bigint }[] = [];
  for (const asset of eligible) {
    const assetId = str(asset, "id") as string;
    const posted = new Set<string>();
    const drafts = new Set<string>();
    for (const [marker, je] of byMarker) {
      const m = MARKER.exec(marker);
      if (m === null || m[1] !== assetId) continue;
      (str(je, "state") === "draft" ? drafts : posted).add(m[2] as string);
    }
    for (const p of depreciationPeriodsDue(period, posted, drafts, windowPeriods)) {
      const amount = straightLineCharge({
        acquisitionDate: str(asset, "acquisition_date") as string,
        cost: units(asset["acquisition_cost"], 2) as bigint,
        salvage: units(asset["salvage_value"], 2) ?? 0n,
        lifeMonths: asset["useful_life_months"] as number,
        year: p.year,
        month: p.month,
      });
      if (amount !== null) charges.push({ asset, period: p, amount });
    }
  }
  run.tally.count("charges_due", charges.length);
  if (charges.length === 0) return null;

  const settings = await run.settings.get(run.access.tenantId);
  const expenseCode = settings.finance?.depreciationExpenseAccountCode;
  const accumulatedCode = settings.finance?.accumulatedDepreciationAccountCode;
  const expense = expenseCode === undefined ? null : await accountId(run, expenseCode);
  const accumulated = accumulatedCode === undefined ? null : await accountId(run, accumulatedCode);
  if (expense === null || accumulated === null) {
    return failed(
      "depreciation_accounts_unconfigured",
      `${charges.length.toString()} charge(s) are due through ${period.key} and the tenant's finance settings` +
        " do not name both depreciationExpenseAccountCode and accumulatedDepreciationAccountCode as existing" +
        " LedgerAccount codes; nothing was posted",
      false,
    );
  }
  const currency = settings.defaults?.currency;

  for (const { asset, period: p, amount } of charges) {
    const stop = aborted(run);
    if (stop !== null) return stop;
    const assetId = str(asset, "id") as string;
    const marker = `[depreciation:${assetId}:${p.key}]`;
    let entry: EntityRecord | null = byMarker.get(marker) ?? null;
    if (entry !== null && str(entry, "state") !== "draft") {
      run.tally.count("already_posted");
      continue;
    }
    if (entry === null) {
      const created = await run.access.create("JournalEntry", {
        entry_date: p.endDate,
        source: "depreciation",
        memo: `Depreciation ${p.key} — ${str(asset, "name") ?? str(asset, "asset_tag") ?? assetId} ${marker}`,
      });
      if (created.kind !== "written" || created.record === null) {
        if (created.kind === "refused") run.tally.refuse(`FixedAsset ${assetId} entry`, created);
        continue;
      }
      entry = created.record;
    }
    const entryId = str(entry, "id") as string;
    const lines = await readAll(
      run,
      "JournalLine",
      [{ field: "journal_entry_id", value: entryId }],
      "a depreciation entry's lines",
    );
    const has = new Set(lines.map((l) => str(l, "ledger_account_id")));
    const value = renderUnits(amount, 2);
    const wanted: readonly [string, Record<string, unknown>][] = [
      [expense, { debit: value, credit: "0" }],
      [accumulated, { debit: "0", credit: value }],
    ];
    let linesOk = true;
    for (const [account, side] of wanted) {
      if (has.has(account)) continue;
      const line = await run.access.create("JournalLine", {
        journal_entry_id: entryId,
        ledger_account_id: account,
        description: `Depreciation ${p.key}`,
        ...side,
        ...(currency !== undefined ? { currency } : {}),
      });
      if (line.kind === "refused") {
        run.tally.refuse(`JournalEntry ${entryId} line`, line);
        linesOk = false;
      }
    }
    if (!linesOk) continue;
    let posted = await run.access.transition("JournalEntry", entryId, "post");
    // A period that was closed before its charge posted is caught up in the run's own period: the
    // draft is re-dated there and posted, so the expense lands in the first open month instead of
    // never, and the draft does not outlive the refusal. The marker keeps naming the month charged.
    const lateDate = period.endDate;
    if (posted.kind === "refused" && posted.error === "period_locked" && str(entry, "entry_date") !== lateDate) {
      const redated = await run.access.update("JournalEntry", entryId, { entry_date: lateDate });
      if (redated.kind === "refused") {
        run.tally.refuse(`JournalEntry ${entryId} re-date`, redated);
        continue;
      }
      posted = await run.access.transition("JournalEntry", entryId, "post");
      if (posted.kind === "written") run.tally.count("caught_up_into_open_period");
    }
    if (posted.kind === "written") {
      run.tally.count("posted");
      if (p.key !== period.key) run.tally.count("caught_up");
    } else if (posted.status === 409) run.tally.count("moved_by_someone_else");
    else run.tally.refuse(`JournalEntry ${entryId} post`, posted);
  }
  return null;
}

async function accountId(run: Run, code: string): Promise<string | null> {
  const rows = await readAll(run, "LedgerAccount", [{ field: "account_code", value: code }], "a ledger account by code");
  return rows.length === 1 ? str(rows[0], "id") : null;
}

// ---- inventory reorder --------------------------------------------------------------------------

const OPEN_PO_STATES = ["draft", "submitted", "approved"] as const;
const QTY_SCALE = 3;
const PRICE_SCALE = 4;

async function inventoryReorder(run: Run): Promise<JobHandlerResult | null> {
  const items = await readAll(run, "Item", [{ field: "status", value: "active" }], "the active items");
  const watched = items.filter((i) => units(i["reorder_point"], QTY_SCALE) !== null);
  run.tally.count("items_with_reorder_point", watched.length);
  if (watched.length === 0) return null;

  const levels = await readAll(run, "StockLevel", [], "the stock levels");
  const projected = new Map<string, bigint>();
  for (const l of levels) {
    const item = str(l, "item_id");
    if (item === null) continue;
    const p =
      (units(l["quantity_on_hand"], QTY_SCALE) ?? 0n) -
      (units(l["quantity_reserved"], QTY_SCALE) ?? 0n) +
      (units(l["quantity_incoming"], QTY_SCALE) ?? 0n);
    projected.set(item, (projected.get(item) ?? 0n) + p);
  }

  const openPos = await readAll(
    run,
    "PurchaseOrder",
    [{ field: "state", op: "in", value: [...OPEN_PO_STATES] }],
    "the open purchase orders",
  );
  const openPoIds = new Set(openPos.map((p) => str(p, "id")));
  const openPoLines = openPoIds.size === 0 ? [] : await linesOf(run, [...openPoIds].filter((x): x is string => x !== null));
  const onOrder = new Set<string>();
  for (const line of openPoLines) {
    const outstanding = (units(line["quantity"], QTY_SCALE) ?? 0n) - (units(line["received_quantity"], QTY_SCALE) ?? 0n);
    const item = str(line, "item_id");
    if (item !== null && outstanding > 0n) onOrder.add(item);
  }

  const groups = new Map<string, { vendor: string; currency: string; lines: Record<string, unknown>[] }>();
  for (const item of watched) {
    const itemId = str(item, "id") as string;
    const point = units(item["reorder_point"], QTY_SCALE) as bigint;
    const level = projected.get(itemId) ?? 0n;
    if (level >= point) continue;
    run.tally.count("below_reorder_point");
    if (onOrder.has(itemId)) {
      run.tally.count("already_on_order");
      continue;
    }
    const supplier = await lastSupplier(run, itemId);
    if (supplier === null) {
      run.tally.count("no_supplier_history");
      continue;
    }
    const configured = units(item["reorder_quantity"], QTY_SCALE);
    const qty = configured !== null && configured > 0n ? configured : point - level;
    if (qty <= 0n) continue;
    const key = `${supplier.vendor}\u0000${supplier.currency}`;
    const group = groups.get(key) ?? { vendor: supplier.vendor, currency: supplier.currency, lines: [] };
    group.lines.push({
      item_id: itemId,
      description: str(item, "name") ?? itemId,
      quantity: renderUnits(qty, QTY_SCALE),
      unit_price: renderUnits(supplier.unitPrice, PRICE_SCALE),
      line_total: renderUnits(mul(qty, QTY_SCALE, supplier.unitPrice, PRICE_SCALE, 2), 2),
    });
    groups.set(key, group);
  }

  const today = isoDate(run.at);
  const marker = `[reorder:${today}]`;
  for (const group of groups.values()) {
    const stop = aborted(run);
    if (stop !== null) return stop;
    const subtotal = group.lines.reduce((s, l) => s + (units(l["line_total"], 2) ?? 0n), 0n);
    // A previous attempt of this run may have created the header and not every line; finishing that
    // draft rather than opening a second is what makes the retry a retry.
    const reuse = openPos.find(
      (p) =>
        str(p, "state") === "draft" &&
        str(p, "vendor_id") === group.vendor &&
        str(p, "currency") === group.currency &&
        (str(p, "notes") ?? "").includes(marker),
    );
    let poId = reuse === undefined ? null : str(reuse, "id");
    if (poId === null) {
      const po = await run.access.create("PurchaseOrder", {
        vendor_id: group.vendor,
        order_date: today,
        currency: group.currency,
        subtotal: renderUnits(subtotal, 2),
        total: renderUnits(subtotal, 2),
        notes: `Drafted by the reorder-point sweep ${marker}`,
      });
      if (po.kind === "refused" || po.record === null) {
        if (po.kind === "refused") run.tally.refuse(`PurchaseOrder for vendor ${group.vendor}`, po);
        continue;
      }
      poId = str(po.record, "id");
      run.tally.count("purchase_orders_drafted");
    }
    for (const line of group.lines) {
      const r = await run.access.create("PurchaseOrderLine", { purchase_order_id: poId, ...line });
      if (r.kind === "written") run.tally.count("lines_drafted");
      else run.tally.refuse(`PurchaseOrderLine item ${String(line["item_id"])}`, r);
    }
  }
  return null;
}

async function linesOf(run: Run, poIds: readonly string[]): Promise<EntityRecord[]> {
  const out: EntityRecord[] = [];
  for (let i = 0; i < poIds.length; i += 200) {
    out.push(
      ...(await readAll(
        run,
        "PurchaseOrderLine",
        [{ field: "purchase_order_id", op: "in", value: poIds.slice(i, i + 200) }],
        "the open purchase order lines",
      )),
    );
  }
  return out;
}

/**
 * The vendor, currency and price of the latest non-cancelled purchase of an item. `Item` declares
 * no preferred vendor, so the purchase history is the only evidence of who supplies it — and an item
 * never bought is reported rather than drafted against a vendor nobody chose.
 */
async function lastSupplier(
  run: Run,
  itemId: string,
): Promise<{ vendor: string; currency: string; unitPrice: bigint } | null> {
  const lines = await readAll(run, "PurchaseOrderLine", [{ field: "item_id", value: itemId }], "an item's purchase history");
  if (lines.length === 0) return null;
  const poIds = [...new Set(lines.map((l) => str(l, "purchase_order_id")).filter((x): x is string => x !== null))];
  const pos: EntityRecord[] = [];
  for (let i = 0; i < poIds.length; i += 200) {
    pos.push(
      ...(await readAll(run, "PurchaseOrder", [{ field: "id", op: "in", value: poIds.slice(i, i + 200) }], "an item's purchase orders")),
    );
  }
  const byId = new Map(pos.filter((p) => str(p, "state") !== "cancelled").map((p) => [str(p, "id"), p]));
  let best: { po: EntityRecord; line: EntityRecord } | null = null;
  for (const line of lines) {
    const po = byId.get(str(line, "purchase_order_id"));
    if (po === undefined) continue;
    if (best === null || orderKey(po) > orderKey(best.po)) best = { po, line };
  }
  if (best === null) return null;
  const vendor = str(best.po, "vendor_id");
  const currency = str(best.po, "currency");
  const unitPrice = units(best.line["unit_price"], PRICE_SCALE);
  return vendor === null || currency === null || unitPrice === null ? null : { vendor, currency, unitPrice };
}

function orderKey(po: EntityRecord): string {
  return `${str(po, "order_date") ?? ""}|${str(po, "created_at") ?? ""}|${str(po, "id") ?? ""}`;
}

// ---- sales order → invoice ----------------------------------------------------------------------

function eventRecordId(ctx: JobHandlerContext): string | null {
  const input = ctx.input;
  if (input === null || typeof input !== "object") return null;
  const id = (input as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function salesOrderToInvoice(run: Run): Promise<JobHandlerResult | null> {
  const soId = eventRecordId(run.ctx);
  if (soId === null) return failed("event_record_missing", "the event names no sales order id", false);
  const so = await run.access.read("SalesOrder", soId);
  if (so === null) return failed("sales_order_not_found", `sales order ${soId} does not exist in this tenant`, false);
  const state = str(so, "state");
  if (state === "invoiced" || state === "closed") {
    run.tally.count("already_invoiced");
    return null;
  }
  if (state !== "fulfilled") {
    run.tally.count(`skipped_state_${state ?? "unknown"}`);
    return null;
  }

  const lines = [
    ...(await readAll(run, "SalesOrderLine", [{ field: "sales_order_id", value: soId }], "a sales order's lines")),
  ].sort(
    (a, b) => `${str(a, "created_at") ?? ""}|${str(a, "id") ?? ""}`.localeCompare(`${str(b, "created_at") ?? ""}|${str(b, "id") ?? ""}`),
  );
  const fulfilled = lines.filter((l) => (units(l["fulfilled_quantity"], QTY_SCALE) ?? 0n) > 0n);
  if (fulfilled.length === 0) {
    // `fulfilled_quantity` defaults to 0; a shipment entering `shipped` advances it for a stocked
    // item's line, and nothing advances it for a service line or a line with no item — a person
    // does. An order marked fulfilled with none recorded is not evidence of what was delivered, and
    // invoicing the ordered quantity instead would bill a figure nobody confirmed.
    return failed(
      "nothing_fulfilled",
      `sales order ${soId} is 'fulfilled' and none of its lines records a fulfilled_quantity; nothing was invoiced`,
      false,
    );
  }
  const partial = fulfilled.length < lines.length || fulfilled.some((l) => (units(l["fulfilled_quantity"], QTY_SCALE) ?? 0n) < (units(l["quantity"], QTY_SCALE) ?? 0n));
  const soTax = units(so["tax_total"], 2) ?? 0n;
  if (partial && soTax !== 0n) {
    // The order carries tax at the header only, with no rate on any line, so the share of it a
    // partial delivery owes is not recorded anywhere; apportioning it by value would invent a tax
    // figure on a document that is a tax record.
    return failed(
      "partial_fulfilment_tax_unallocable",
      `sales order ${soId} is partly fulfilled and carries header-level tax with no per-line rate; its invoice needs a person`,
      false,
    );
  }

  const invoiceLines = fulfilled.map((l, i) => {
    const qty = units(l["fulfilled_quantity"], QTY_SCALE) as bigint;
    const price = units(l["unit_price"], PRICE_SCALE) ?? 0n;
    return {
      position: i,
      description: str(l, "description") ?? `Line ${(i + 1).toString()}`,
      quantity: renderUnits(qty, QTY_SCALE),
      unit_price: renderUnits(price, PRICE_SCALE),
      line_total: renderUnits(mul(qty, QTY_SCALE, price, PRICE_SCALE, 2), 2),
    };
  });
  const subtotal = invoiceLines.reduce((s, l) => s + (units(l.line_total, 2) ?? 0n), 0n);
  const tax = partial ? 0n : soTax;

  const marker = `[sales_order:${soId}]`;
  const accountIdOf = str(so, "account_id");
  const candidates =
    accountIdOf === null
      ? []
      : await readAll(run, "Invoice", [{ field: "account_id", value: accountIdOf }], "the account's invoices");
  let invoice = candidates.find((i) => (str(i, "notes") ?? "").includes(marker)) ?? null;
  if (invoice === null) {
    // `due_date` is required and this handler sends none: `applySettingsDefaults` fills it from the
    // tenant's payment terms, the only place a customer's terms exist (an Account carries none). So
    // without them the create is a 422 *after* the order was read and the lines computed, named only
    // as `validation_failed`. Asked first and named, and deliberately not defaulted: a term is a
    // contractual fact between the tenant and its customer, and "due on receipt" would make every
    // invoice this job writes overdue at once — which the overdue job would then act on.
    const terms = (await run.settings.get(run.access.tenantId)).finance?.defaultPaymentTermsDays;
    if (terms === undefined) {
      return failed(
        "payment_terms_unconfigured",
        `sales order ${soId} is ready to invoice and the tenant's finance settings name no defaultPaymentTermsDays,` +
          " the only source of an invoice's due_date; nothing was written. Set finance.defaultPaymentTermsDays" +
          " (PUT /v1/admin/settings), then invoke this job again for the order",
        false,
      );
    }
    const created = await run.access.create("Invoice", {
      account_id: accountIdOf,
      currency: str(so, "currency"),
      issue_date: isoDate(run.at),
      subtotal: renderUnits(subtotal, 2),
      tax_total: renderUnits(tax, 2),
      total: renderUnits(subtotal + tax, 2),
      notes: `Generated from sales order ${str(so, "so_number") ?? soId} ${marker}`,
    });
    if (created.kind === "refused" || created.record === null) {
      if (created.kind === "refused") run.tally.refuse(`Invoice for SalesOrder ${soId}`, created);
      return null;
    }
    invoice = created.record;
    run.tally.count("invoices_created");
  } else {
    run.tally.count("invoice_resumed");
  }
  const invoiceId = str(invoice, "id") as string;
  const present = await readAll(run, "InvoiceLine", [{ field: "invoice_id", value: invoiceId }], "an invoice's lines");
  const positions = new Set(present.map((l) => l["position"]));
  for (const line of invoiceLines) {
    if (positions.has(line.position)) continue;
    const r = await run.access.create("InvoiceLine", { invoice_id: invoiceId, ...line });
    if (r.kind === "written") run.tally.count("lines_created");
    else run.tally.refuse(`InvoiceLine ${line.position.toString()} of ${invoiceId}`, r);
  }
  if (run.tally.refused.length > 0) return null;
  const moved = await run.access.transition("SalesOrder", soId, "invoice");
  if (moved.kind === "written") run.tally.count("sales_order_invoiced");
  else if (moved.status === 409) run.tally.count("moved_by_someone_else");
  else run.tally.refuse(`SalesOrder ${soId} invoice`, moved);
  return null;
}

// ---- work order completion ----------------------------------------------------------------------

async function workOrderCompletion(run: Run): Promise<JobHandlerResult | null> {
  const woId = eventRecordId(run.ctx);
  if (woId === null) return failed("event_record_missing", "the event names no work order id", false);
  const wo = await run.access.read("WorkOrder", woId);
  if (wo === null) return failed("work_order_not_found", `work order ${woId} does not exist in this tenant`, false);
  if (str(wo, "state") !== "completed") {
    run.tally.count(`skipped_state_${str(wo, "state") ?? "unknown"}`);
    return null;
  }
  const completed = units(wo["completed_quantity"], QTY_SCALE) ?? 0n;
  if (completed <= 0n) {
    return failed(
      "no_completed_quantity",
      `work order ${woId} is 'completed' with no completed_quantity recorded; nothing was moved`,
      false,
    );
  }
  const warehouse = str(wo, "warehouse_id");
  if (warehouse === null) {
    return failed("work_order_has_no_warehouse", `work order ${woId} names no warehouse to move stock in`, false);
  }
  const bomId = str(wo, "bom_id");
  if (bomId === null) {
    // An item may have several bills of materials (versions, drafts); choosing one for the work
    // order would consume stock by a recipe nobody named.
    return failed("work_order_has_no_bom", `work order ${woId} names no bill of materials`, false);
  }
  const bom = await run.access.read("BillOfMaterials", bomId);
  const output = units(bom?.["output_quantity"], QTY_SCALE) ?? 0n;
  if (bom === null || output <= 0n) {
    return failed("bom_unusable", `bill of materials ${bomId} is missing or has no output quantity`, false);
  }
  const bomLines = await readAll(run, "BomLine", [{ field: "bom_id", value: bomId }], "a bill of materials' lines");

  const reference = `WO:${woId}`;
  const existing = await readAll(run, "StockMovement", [{ field: "reference", value: reference }], "a work order's movements");
  const done = new Set(existing.map((m) => `${str(m, "movement_type") ?? ""}|${str(m, "item_id") ?? ""}`));
  const occurredAt = run.at.toISOString();
  // One issue per component, summed: the idempotency marker is (movement type, item), so two BOM
  // lines naming one component written as two movements would read as one already moved on a retry
  // that found only the first, and the second would never be issued.
  const issues = new Map<string, bigint>();
  for (const line of bomLines) {
    const component = str(line, "component_item_id");
    const per = units(line["quantity"], 4);
    if (component === null || per === null) continue;
    const scrap = units(line["scrap_pct"], 2) ?? 0n;
    // per × completed / output × (1 + scrap/100), exact and rounded once. Scales: per 4 + completed
    // 3 − output 3 = 4, and the trailing ×10 in the divisor brings it to the movement's 3. Scrap is
    // at scale 2 so 5.00% is 500, and (10000 + 500) / 10000 is the 1.05 it means.
    const qty = divRound(per * completed * (10000n + scrap), output * 10000n * 10n);
    issues.set(component, (issues.get(component) ?? 0n) + qty);
  }
  const movements: Record<string, unknown>[] = [...issues].map(([component, qty]) => ({
    item_id: component,
    movement_type: "issue",
    quantity: renderUnits(qty, QTY_SCALE),
    reason: "Consumed by work order",
  }));
  movements.push({
    item_id: str(wo, "item_id"),
    movement_type: "receipt",
    quantity: renderUnits(completed, QTY_SCALE),
    reason: "Produced by work order",
  });
  let issueRefused = false;
  for (const m of movements) {
    const key = `${String(m["movement_type"])}|${String(m["item_id"])}`;
    if (done.has(key)) {
      run.tally.count("already_moved");
      continue;
    }
    // The finished good is received only once every component was consumed: a receipt beside a
    // refused issue would put stock on hand (and its value in the inventory account) that nothing
    // was used to make. A later run writes it beside the issue that was missing.
    if (m["movement_type"] === "receipt" && issueRefused) {
      run.tally.count("receipt_withheld");
      continue;
    }
    const r = await run.access.create("StockMovement", {
      ...m,
      warehouse_id: warehouse,
      reference,
      occurred_at: occurredAt,
    });
    if (r.kind === "written") run.tally.count(`${String(m["movement_type"])}_movements`);
    else {
      if (m["movement_type"] === "issue") issueRefused = true;
      run.tally.refuse(`StockMovement ${key}`, r);
    }
  }
  return null;
}
