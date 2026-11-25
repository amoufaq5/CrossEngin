import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";

import { parseDecimal } from "./decimal.js";
import { drainList, ReadCeilingExceeded } from "./list-drain.js";
import { convertBalanced, rateWire } from "./money.js";
import { PostingRefused, type PostingPeriodConfig } from "./posting-period.js";
import type { EntityRecord, EntityStore, ListFilter } from "./store.js";
import {
  attributedToTrigger,
  createPostedEntry,
  entersState,
  resolveAccountId,
  resolvePostingRate,
  type PostingFxConfig,
  type WriteEffect,
  type WriteEffectInput,
} from "./write-effects.js";
import type { InventorySettings } from "./settings.js";
import type { WriteGuard, WriteGuardInput } from "./write-guards.js";

/**
 * Stock, its valuation, and the three postings a stocked item's life makes: a goods receipt
 * (Dr Inventory / Cr GRNI, the price difference to a variance account), a shipment (Dr COGS /
 * Cr Inventory) and the bill that clears the receipt (Dr GRNI / Cr expense, the reclass of what the
 * bill's recognition entry put in expense). Every one runs as an effect, inside the transaction of
 * the write that caused it, and writes through the store — so it passes no guard and is balanced by
 * construction, per currency, in exact integer cents.
 *
 * **The valuation is standard cost (`Item.standard_cost`), not a moving average**, and the reasons
 * are measured rather than preferred. (1) The field exists, is classified `commercial_sensitive` and
 * carries a field grant that withholds it from the warehouse clerk and the general observer; a moving
 * average would need a new cost column on `StockLevel` or `StockMovement`, and the readers of those
 * entities include exactly the two roles the standard cost is withheld from. (2) It is stateless in
 * cost: a moving average is a read-modify-write on a value two concurrent receipts race, while a
 * standard is read, never written, by a receipt or a shipment — the only contended value left is the
 * quantity, which `updateIf` serialises. (3) It is exact: every amount is `round(std × qty)` in
 * integer cents, and a change of standard posts its own revaluation, so the inventory account and the
 * stock ledger cannot drift by more than the per-movement rounding (one cent per movement at most).
 * The cost is that a purchase price different from standard lands in a variance account at receipt,
 * which is what a standard-cost ledger means.
 *
 * Quantities are exact at the entities' own scale (three decimals) and money at two; nothing here
 * passes through a double, which is ADR-0378's rule for the tax arithmetic applied to stock.
 */

export const QTY_SCALE = 3;
const STD_SCALE = 4;
const MONEY_SCALE = 2;

/** Item types that carry no stock: shipping or receiving one moves nothing and posts nothing. */
export const NON_STOCK_ITEM_TYPES: readonly string[] = ["service"];

export function isStockedItem(item: EntityRecord): boolean {
  return !NON_STOCK_ITEM_TYPES.includes(String(item["item_type"] ?? "stock"));
}

/** The direction each `StockMovement.movement_type` moves on-hand quantity; `adjustment` is signed. */
export const MOVEMENT_DIRECTION: Readonly<Record<string, 1 | -1 | 0>> = Object.freeze({
  receipt: 1,
  transfer_in: 1,
  return: 1,
  issue: -1,
  transfer_out: -1,
  adjustment: 0,
});

/** The tenant's stock policy, from settings. Absent → the strict default. */
export interface InventoryPolicy {
  readonly allowNegativeStock: boolean;
  /** Percent by which billed quantity may exceed received quantity on a matched bill line. */
  readonly matchQuantityTolerancePct: number;
  /** Percent by which a matched bill line's unit price may differ from its order line's. */
  readonly matchPriceTolerancePct: number;
}

export const STRICT_INVENTORY_POLICY: InventoryPolicy = Object.freeze({
  allowNegativeStock: false,
  matchQuantityTolerancePct: 0,
  matchPriceTolerancePct: 0,
});

/** The tenant's declared policy, with every absent field at its strict default. */
export function inventoryPolicyFrom(settings: InventorySettings | undefined): InventoryPolicy {
  return {
    allowNegativeStock: settings?.allowNegativeStock ?? STRICT_INVENTORY_POLICY.allowNegativeStock,
    matchQuantityTolerancePct: settings?.matchQuantityTolerancePct ?? STRICT_INVENTORY_POLICY.matchQuantityTolerancePct,
    matchPriceTolerancePct: settings?.matchPriceTolerancePct ?? STRICT_INVENTORY_POLICY.matchPriceTolerancePct,
  };
}

/** Every entity and field each group of postings reads, by the names `erp-core` declares. */
export const INVENTORY_REQUIREMENTS = Object.freeze({
  ledger: {
    Item: ["item_type", "standard_cost", "currency"],
    StockLevel: ["item_id", "warehouse_id", "quantity_on_hand"],
    StockMovement: ["item_id", "warehouse_id", "movement_type", "quantity", "reference", "reason", "occurred_at"],
  },
  goodsReceipt: {
    GoodsReceipt: ["status", "purchase_order_id", "warehouse_id", "grn_number"],
    PurchaseOrder: ["state", "currency"],
    PurchaseOrderLine: ["purchase_order_id", "item_id", "quantity", "received_quantity", "unit_price"],
  },
  shipment: {
    Shipment: ["state", "sales_order_id", "warehouse_id", "shipment_number"],
    SalesOrderLine: ["sales_order_id", "item_id", "quantity", "fulfilled_quantity"],
  },
  billMatch: {
    Bill: ["state", "currency", "purchase_order_id", "bill_number"],
    BillLine: ["bill_id", "item_id", "quantity", "unit_price", "purchase_order_line_id"],
    PurchaseOrder: ["currency"],
    PurchaseOrderLine: ["purchase_order_id", "item_id", "quantity", "received_quantity", "unit_price"],
  },
} satisfies Record<string, Record<string, readonly string[]>>);

export type InventoryPostingGroup = keyof typeof INVENTORY_REQUIREMENTS;

/**
 * Which groups of postings this manifest can carry. Each later group needs the ledger as well,
 * because every one of them moves a stock level or reads an item's standard cost.
 */
export function inventoryShape(manifest: Manifest): Readonly<Record<InventoryPostingGroup, boolean>> {
  const fieldsOf = new Map<string, Set<string>>();
  for (const e of manifest.entities ?? []) {
    fieldsOf.set(e.name, new Set(resolvedFields(e, manifest.traits ?? []).map((f) => f.name)));
  }
  const has = (group: InventoryPostingGroup): boolean =>
    Object.entries(INVENTORY_REQUIREMENTS[group] as Record<string, readonly string[]>).every(([entity, fields]) => {
      const present = fieldsOf.get(entity);
      return present !== undefined && fields.every((f) => present.has(f));
    });
  const ledger = has("ledger");
  return {
    ledger,
    goodsReceipt: ledger && has("goodsReceipt"),
    shipment: ledger && has("shipment"),
    billMatch: ledger && has("billMatch"),
  };
}

/**
 * The boot line naming what the inventory accounting does on this manifest, said either way. The
 * refusals it introduced (a shipment below zero, a bill billing more than was received) refuse
 * writes a deployment made before it, so the line names the tenant settings that relax them.
 */
export function formatInventoryAccounting(
  shape: Readonly<Record<InventoryPostingGroup, boolean>>,
  postsToLedger: boolean,
): string {
  if (!shape.ledger) {
    return "[inventory] stock accounting: off — this manifest lacks the Item/StockLevel/StockMovement fields it reads";
  }
  if (!postsToLedger) {
    // Every document posting is wired only beside a ledger, so without one a goods receipt receives
    // nothing and a shipment issues nothing; only a movement or a level written directly moves stock.
    return (
      "[inventory] stock accounting: movements and level edits only — this manifest has no " +
      "JournalEntry/JournalLine/LedgerAccount, so goods receipts and shipments move no stock and nothing is valued"
    );
  }
  const on = (["goodsReceipt", "shipment", "billMatch"] as const).filter((g) => shape[g]);
  const names: Record<(typeof on)[number], string> = {
    goodsReceipt: "goods receipts receive stock (Dr inventory / Cr GRNI)",
    shipment: "shipments issue stock (Dr COGS / Cr inventory)",
    billMatch: "bill approval three-way matched and clears GRNI",
  };
  return (
    "[inventory] stock accounting at standard cost: every stock movement moves its level" +
    (on.length > 0 ? `; ${on.map((g) => names[g]).join("; ")}` : "") +
    ". Stock below zero and billing past what was received or ordered are refused per tenant unless its settings set " +
    "inventory.allowNegativeStock / inventory.matchQuantityTolerancePct / inventory.matchPriceTolerancePct"
  );
}

/** Whether the document postings can be wired at all: each one writes a journal entry. */
export function inventoryPostsToLedger(manifest: Manifest): boolean {
  const names = new Set((manifest.entities ?? []).map((e) => e.name));
  return names.has("JournalEntry") && names.has("JournalLine") && names.has("LedgerAccount");
}

export interface InventoryAccountCodes {
  readonly inventory?: string;
  readonly cogs?: string;
  readonly grni?: string;
  readonly variance?: string;
  /** The bill recognition's own expense code, so the GRNI clearing credits the account it debited. */
  readonly expense?: string;
}

/** The placeholder refs an unresolved account code falls back to — refused by a store that enforces references. */
export const INVENTORY_ACCOUNT_FALLBACKS = Object.freeze({
  inventory: "inventory",
  cogs: "cost_of_goods_sold",
  grni: "goods_received_not_invoiced",
  variance: "inventory_variance",
  expense: "expense",
});

export interface InventoryConfig {
  readonly periods?: PostingPeriodConfig;
  readonly clock?: { now(): Date };
  readonly resolveAccountCodes?: (tenantId: string) => Promise<InventoryAccountCodes>;
  readonly resolvePolicy?: (tenantId: string) => Promise<InventoryPolicy>;
  /** Largest line set one document read is allowed to drain before the posting refuses. */
  readonly maxRows?: number;
  /**
   * Whether the manifest carries goods receipts, so the match guard can ask whether a bill line
   * naming no order line bills goods a receipt has already credited to GRNI.
   */
  readonly receiptsCreditGrni?: boolean;
  /**
   * How a posting finds the rate its lines' currency converts into the functional currency at —
   * the document effects' `PostingFxConfig`, taken on the entry's own date (ADR-0475). Absent, every
   * line posts at rate 1, which is right only for a manifest declaring no exchange-rate tables.
   */
  readonly fx?: PostingFxConfig;
}

const MAX_ROWS = 10_000;
const LEDGER = { ledgerAccountEntity: "LedgerAccount", accountCodeField: "account_code" };

// ---- exact arithmetic ---------------------------------------------------------------------------

/** `value` as integer units at `scale`, half away from zero; null when it is not a numeral. */
export function toUnits(value: unknown, scale: number): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  const d = parseDecimal(value);
  if (d === null) return null;
  let u = d.units;
  if (d.scale < scale) u *= 10n ** BigInt(scale - d.scale);
  else if (d.scale > scale) u = divRound(u, 10n ** BigInt(d.scale - scale));
  return d.negative ? -u : u;
}

/** `a / b` for positive `b`, half away from zero, for either sign of `a`. */
function divRound(a: bigint, b: bigint): bigint {
  const negative = a < 0n;
  const m = negative ? -a : a;
  const q = m / b;
  const r = m % b;
  const rounded = r * 2n >= b ? q + 1n : q;
  return negative ? -rounded : rounded;
}

export function renderUnits(u: bigint, scale: number): string {
  const negative = u < 0n;
  const text = (negative ? -u : u).toString().padStart(scale + 1, "0");
  const body = scale === 0 ? text : `${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
  return negative ? `-${body}` : body;
}

/** `price × quantity` in cents, where price is at `priceScale` units and quantity at three decimals. */
export function extendedCents(priceUnits: bigint, qtyUnits: bigint, priceScale: number): bigint {
  return divRound(priceUnits * qtyUnits, 10n ** BigInt(priceScale + QTY_SCALE - MONEY_SCALE));
}

// ---- small readers ------------------------------------------------------------------------------

function str(r: EntityRecord | null | undefined, field: string): string | null {
  const v = r?.[field];
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function drainAll(
  input: { store: EntityStore; tenantId: string },
  entity: string,
  filters: readonly ListFilter[],
  ceiling: number,
  computing: string,
): Promise<EntityRecord[]> {
  const rows: EntityRecord[] = [];
  const outcome = await drainList(input.store, input.tenantId, entity, { sort: [], filters }, { ceiling }, (page) => {
    for (const r of page) {
      // The filter is the store's; the check is ours, so a store that ignored one cannot widen the set.
      if (filters.every((f) => f.op !== "eq" || String(r[f.field] ?? "") === String(f.value))) rows.push(r);
    }
  });
  if (!outcome.complete) throw new ReadCeilingExceeded(entity, ceiling, computing);
  return rows;
}

async function policyOf(c: InventoryConfig, tenantId: string): Promise<InventoryPolicy> {
  return c.resolvePolicy !== undefined ? await c.resolvePolicy(tenantId) : STRICT_INVENTORY_POLICY;
}

interface Item {
  readonly id: string;
  readonly stocked: boolean;
  /** Standard cost in units of `STD_SCALE`, or null when unset. */
  readonly std: bigint | null;
  readonly currency: string;
}

async function readItem(input: { store: EntityStore; tenantId: string }, itemId: string): Promise<Item> {
  const item = await input.store.get(input.tenantId, "Item", itemId);
  if (item === null) {
    throw new PostingRefused(422, "stock_item_missing", "a line this write moves stock for names an item that does not exist");
  }
  return {
    id: itemId,
    stocked: isStockedItem(item),
    std: toUnits(item["standard_cost"], STD_SCALE),
    currency: str(item, "currency") ?? "USD",
  };
}

// ---- the stock level ----------------------------------------------------------------------------

const NEGATIVE_STOCK_DETAIL =
  "this write would take an item's on-hand quantity in a warehouse below zero; record the receipt first, " +
  "or set the tenant's inventory.allowNegativeStock (PUT /v1/admin/settings) if negative stock is intended";

const AMBIGUOUS_LEVEL_DETAIL =
  "more than one stock level records this item in this warehouse, so which one to move is not established";

/** The one StockLevel for (item, warehouse), or undefined; two is refused rather than resolved. */
async function readLevel(
  input: { store: EntityStore; tenantId: string },
  itemId: string,
  warehouseId: string,
): Promise<EntityRecord | undefined> {
  let levels: EntityRecord[];
  try {
    levels = await drainAll(
      input,
      "StockLevel",
      [
        { field: "item_id", op: "eq", value: itemId },
        { field: "warehouse_id", op: "eq", value: warehouseId },
      ],
      2,
      "an item's stock level in one warehouse",
    );
  } catch (err) {
    if (err instanceof ReadCeilingExceeded) throw new PostingRefused(409, "stock_level_ambiguous", AMBIGUOUS_LEVEL_DETAIL);
    throw err;
  }
  if (levels.length > 1) throw new PostingRefused(409, "stock_level_ambiguous", AMBIGUOUS_LEVEL_DETAIL);
  return levels[0];
}

/** How many times a contended stock level is re-read before the write gives up. */
const LEVEL_ATTEMPTS = 8;

/**
 * Applies `delta` (thousandths) to the one StockLevel for (item, warehouse), creating it when absent.
 *
 * Compare-and-set on the quantity it read, re-read and retried on a lost race: the delta is fixed,
 * so a retry recomputes only the result and re-checks it against the floor. Two rows for one pair is
 * refused rather than resolved — splitting a quantity between them is a guess about which is right.
 */
export async function applyStockDelta(
  input: { store: EntityStore; tenantId: string },
  itemId: string,
  warehouseId: string,
  delta: bigint,
  allowNegative: boolean,
  stamp: EntityRecord,
): Promise<bigint> {
  for (let attempt = 0; attempt < LEVEL_ATTEMPTS; attempt++) {
    const level = await readLevel(input, itemId, warehouseId);
    const current = level === undefined ? 0n : (toUnits(level["quantity_on_hand"], QTY_SCALE) ?? 0n);
    const next = current + delta;
    if (next < 0n && delta < 0n && !allowNegative) throw new PostingRefused(422, "stock_insufficient", NEGATIVE_STOCK_DETAIL);
    if (level === undefined) {
      await input.store.create(input.tenantId, "StockLevel", {
        item_id: itemId,
        warehouse_id: warehouseId,
        quantity_on_hand: renderUnits(next, QTY_SCALE),
        ...stamp,
      });
      return next;
    }
    const outcome = await input.store.updateIf(
      input.tenantId,
      "StockLevel",
      String(level["id"]),
      { quantity_on_hand: renderUnits(next, QTY_SCALE), ...withoutCreated(stamp) },
      { quantity_on_hand: level["quantity_on_hand"] },
    );
    if (outcome.kind === "updated") return next;
    if (outcome.kind === "not_found") continue;
  }
  throw new PostingRefused(409, "stock_level_contended", "the stock level kept changing under this write; retry it");
}

function withoutCreated(stamp: EntityRecord): EntityRecord {
  const { created_at: _a, created_by: _b, ...rest } = stamp;
  return rest;
}

/**
 * Advances one document line's running quantity (a PO line's `received_quantity`, an SO line's
 * `fulfilled_quantity`) by `delta`, only while it still holds what was read. A lost race is a
 * refusal, not a retry: the amounts this posting validated were computed from the value read.
 */
async function advanceLine(
  input: WriteEffectInput,
  entity: string,
  line: EntityRecord,
  field: string,
  delta: bigint,
  nowIso: string,
): Promise<void> {
  const next = (toUnits(line[field], QTY_SCALE) ?? 0n) + delta;
  const outcome = await input.store.updateIf(
    input.tenantId,
    entity,
    String(line["id"]),
    { [field]: renderUnits(next, QTY_SCALE), updated_at: nowIso },
    { [field]: line[field] },
  );
  if (outcome.kind !== "updated") {
    throw new PostingRefused(409, "inventory_state_changed", `a line's ${field} changed while this write ran; retry it`);
  }
}

// ---- postings -----------------------------------------------------------------------------------

interface PostingLine {
  readonly account: string;
  readonly description: string;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly currency: string;
}

/**
 * Writes one posted entry whose lines balance **per currency** in exact cents — the entry is
 * refused, not written, if they do not, because an effect passes no guard and nothing downstream
 * would see it. Zero lines are dropped; an entry with none is not written.
 */
async function postEntry(
  input: WriteEffectInput,
  c: InventoryConfig,
  number: string,
  memo: string,
  lines: readonly PostingLine[],
  nowIso: string,
  actor: EntityRecord,
): Promise<void> {
  const kept = lines.filter((l) => l.debit !== 0n || l.credit !== 0n);
  if (kept.length === 0) return;
  const byCurrency = new Map<string, bigint>();
  for (const l of kept) {
    if (l.debit < 0n || l.credit < 0n) throw new Error(`inventory posting ${memo} produced a negative amount`);
    byCurrency.set(l.currency, (byCurrency.get(l.currency) ?? 0n) + l.debit - l.credit);
  }
  for (const net of byCurrency.values()) {
    if (net !== 0n) throw new Error(`inventory posting ${memo} does not balance`);
  }
  // Each currency's lines at that currency's rate on the entry's date, converted **and balanced**
  // (`convertBalanced`), and refused by name — `exchange_rate_unresolved` — exactly where a document
  // posting is. Resolved before the entry is created, so a refusal writes nothing. This replaces
  // `fx_rate: 1, functional = amount`, which for a EUR item put EUR inventory into the functional
  // ledger unconverted: a receipt of EUR 100 at 1.1 read USD 100 of stock, a wrong figure that
  // balanced (ADR-0378), since every line was wrong by the same factor.
  const today = nowIso.slice(0, 10);
  const functional = new Map<PostingLine, { d: bigint; c: bigint; rate: number | string }>();
  for (const currency of byCurrency.keys()) {
    const rate = await resolvePostingRate(input, c.fx, {}, currency, today, `the inventory posting ${number}`);
    const group = kept.filter((l) => l.currency === currency);
    const converted = convertBalanced(group.map((l) => ({ d: l.debit, c: l.credit })), rate);
    group.forEach((l, i) => functional.set(l, { ...converted[i]!, rate: rateWire(rate) }));
  }
  const entry = await createPostedEntry(
    input,
    "JournalEntry",
    {
      entry_number: number,
      entry_date: nowIso.slice(0, 10),
      source: "system",
      state: "posted",
      memo,
      posted_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
      ...actor,
    },
    c.periods,
  );
  for (const l of kept) {
    const f = functional.get(l)!;
    await input.store.create(input.tenantId, "JournalLine", {
      journal_entry_id: String(entry["id"]),
      ledger_account_id: l.account,
      description: l.description,
      debit: renderUnits(l.debit, MONEY_SCALE),
      credit: renderUnits(l.credit, MONEY_SCALE),
      currency: l.currency,
      fx_rate: f.rate,
      functional_debit: renderUnits(f.d, MONEY_SCALE),
      functional_credit: renderUnits(f.c, MONEY_SCALE),
      created_at: nowIso,
      updated_at: nowIso,
      ...actor,
    });
  }
}

/** A balanced pair: `amount` (signed) debited to `positive` and credited to `negative`, swapped when negative. */
function pair(
  positive: string,
  negative: string,
  amount: bigint,
  currency: string,
  descriptions: readonly [string, string],
): PostingLine[] {
  if (amount === 0n) return [];
  const a = amount < 0n ? -amount : amount;
  const [dr, cr] = amount > 0n ? [positive, negative] : [negative, positive];
  const [dd, cd] = amount > 0n ? descriptions : [descriptions[1], descriptions[0]];
  return [
    { account: dr, description: dd, debit: a, credit: 0n, currency },
    { account: cr, description: cd, debit: 0n, credit: a, currency },
  ];
}

interface Accounts {
  readonly inventory: string;
  readonly cogs: string;
  readonly grni: string;
  readonly variance: string;
  readonly expense: string;
}

async function resolveAccounts(input: WriteEffectInput, c: InventoryConfig): Promise<Accounts> {
  const codes = c.resolveAccountCodes !== undefined ? await c.resolveAccountCodes(input.tenantId) : {};
  return {
    inventory: (await resolveAccountId(input, LEDGER, codes.inventory)) ?? INVENTORY_ACCOUNT_FALLBACKS.inventory,
    cogs: (await resolveAccountId(input, LEDGER, codes.cogs)) ?? INVENTORY_ACCOUNT_FALLBACKS.cogs,
    grni: (await resolveAccountId(input, LEDGER, codes.grni)) ?? INVENTORY_ACCOUNT_FALLBACKS.grni,
    variance: (await resolveAccountId(input, LEDGER, codes.variance)) ?? INVENTORY_ACCOUNT_FALLBACKS.variance,
    expense: (await resolveAccountId(input, LEDGER, codes.expense)) ?? INVENTORY_ACCOUNT_FALLBACKS.expense,
  };
}

const STANDARD_COST_UNSET =
  "a stocked item this write moves carries no standard_cost, so the stock cannot be valued; set the item's standard_cost first";

function nowOf(c: InventoryConfig): string {
  return (c.clock?.now() ?? new Date()).toISOString();
}

function shortId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(-12);
}

// ---- direct movements and direct level edits ----------------------------------------------------

/** The signed on-hand change a movement makes, in thousandths; null when it moves nothing coherent. */
export function movementDelta(movement: EntityRecord): bigint | null {
  const direction = MOVEMENT_DIRECTION[String(movement["movement_type"] ?? "")];
  const qty = toUnits(movement["quantity"], QTY_SCALE);
  if (direction === undefined || qty === null) return null;
  if (direction === 0) return qty === 0n ? null : qty;
  return qty > 0n ? qty * BigInt(direction) : null;
}

/**
 * Posts the GL side of a quantity change no document explains — a stock movement written directly,
 * or a stock level edited by hand — at standard cost against the inventory variance account.
 * An item with no standard cost is valued at zero, which is what the inventory account already holds
 * for it, so nothing is posted; setting a standard later revalues the stock on hand.
 */
async function postAdjustment(
  input: WriteEffectInput,
  c: InventoryConfig,
  item: Item,
  delta: bigint,
  number: string,
  nowIso: string,
  actor: EntityRecord,
): Promise<void> {
  if (!item.stocked || item.std === null || item.std === 0n) return;
  const value = extendedCents(item.std, delta, STD_SCALE);
  const accounts = await resolveAccounts(input, c);
  await postEntry(
    input,
    c,
    number,
    "Stock adjustment at standard cost",
    pair(accounts.inventory, accounts.variance, value, item.currency, ["Stock adjustment — inventory", "Stock adjustment — variance"]),
    nowIso,
    actor,
  );
}

/**
 * A `StockMovement` written directly (by a person or a job, through the gateway) moves the stock
 * level it names and posts its value at standard. Movements written by the document postings below
 * go through the store and so never reach this — each of those moves its own level.
 */
export function stockMovementEffect(config: InventoryConfig = {}): WriteEffect {
  return async (input) => {
    if (input.entity !== "StockMovement" || input.operation !== "create" || input.id === null) return;
    const m = input.after;
    const delta = movementDelta(m);
    const itemId = str(m, "item_id");
    const warehouseId = str(m, "warehouse_id");
    if (delta === null || itemId === null || warehouseId === null) return;
    const nowIso = nowOf(config);
    const actor = attributedToTrigger(m);
    const item = await readItem(input, itemId);
    const policy = await policyOf(config, input.tenantId);
    await applyStockDelta(input, itemId, warehouseId, delta, policy.allowNegativeStock, {
      created_at: nowIso,
      updated_at: nowIso,
      ...actor,
    });
    await postAdjustment(input, config, item, delta, `SM-${input.id}`, nowIso, actor);
  };
}

/**
 * A stock level whose on-hand quantity is set by hand — created with a quantity, edited, or
 * deleted — records the change as an adjustment movement and posts it, so the movement ledger and
 * the inventory account both still describe the level.
 */
export function stockLevelEditEffect(config: InventoryConfig = {}): WriteEffect {
  return async (input) => {
    if (input.entity !== "StockLevel" || input.operation === "transition") return;
    const beforeQty = input.operation === "create" ? 0n : (toUnits(input.before?.["quantity_on_hand"], QTY_SCALE) ?? 0n);
    const afterQty = input.operation === "delete" ? 0n : (toUnits(input.after["quantity_on_hand"], QTY_SCALE) ?? 0n);
    const delta = afterQty - beforeQty;
    if (delta === 0n) return;
    const source = input.operation === "delete" ? (input.before ?? {}) : input.after;
    const itemId = str(source, "item_id");
    const warehouseId = str(source, "warehouse_id");
    if (itemId === null || warehouseId === null) return;
    const policy = await policyOf(config, input.tenantId);
    if (afterQty < 0n && delta < 0n && !policy.allowNegativeStock) {
      throw new PostingRefused(422, "stock_insufficient", NEGATIVE_STOCK_DETAIL);
    }
    const nowIso = nowOf(config);
    const actor = attributedToTrigger(source);
    const item = await readItem(input, itemId);
    const movement = await input.store.create(input.tenantId, "StockMovement", {
      item_id: itemId,
      warehouse_id: warehouseId,
      movement_type: "adjustment",
      quantity: renderUnits(delta, QTY_SCALE),
      reason: "Stock level set directly",
      occurred_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
      ...actor,
    });
    await postAdjustment(input, config, item, delta, `SM-${String(movement["id"])}`, nowIso, actor);
  };
}

/**
 * The movement ledger is append-only: a movement moves a level and posts a value, so editing or
 * deleting one would leave both describing a movement that no longer exists. A correction is a new
 * adjustment. Also refuses a directional movement with a non-positive quantity (its direction is
 * its type) and an adjustment of zero, which move nothing coherent.
 */
export function stockMovementLedgerGuard(): WriteGuard {
  return async (input: WriteGuardInput) => {
    if (input.entity === "StockMovement") {
      if (input.operation === "update" || input.operation === "delete") {
        return {
          status: 422,
          error: "stock_movement_immutable",
          detail: "a stock movement cannot be edited or deleted once recorded; record a compensating adjustment instead",
        };
      }
      if (input.operation === "create" && movementDelta(input.after) === null) {
        return {
          status: 422,
          error: "stock_movement_quantity_invalid",
          detail:
            "a receipt, issue, transfer or return carries a positive quantity (its type is its direction); an adjustment carries a non-zero signed one",
        };
      }
    }
    if (input.entity === "StockLevel" && input.operation === "create") {
      // A second level for one (item, warehouse) makes every later movement of that pair refuse
      // `stock_level_ambiguous`, so the record that would create the ambiguity is the one refused.
      const itemId = str(input.after, "item_id");
      const warehouseId = str(input.after, "warehouse_id");
      if (itemId !== null && warehouseId !== null) {
        let existing: EntityRecord | undefined;
        try {
          existing = await readLevel(input, itemId, warehouseId);
        } catch (err) {
          if (!(err instanceof PostingRefused)) throw err;
          existing = {};
        }
        if (existing !== undefined) {
          return {
            status: 409,
            error: "stock_level_exists",
            detail: "this item already has a stock level in this warehouse; edit that level's quantity instead",
          };
        }
      }
    }
    if (input.entity === "StockLevel" && input.operation === "update") {
      for (const key of ["item_id", "warehouse_id"]) {
        if (Object.prototype.hasOwnProperty.call(input.after, key) && input.after[key] !== input.before?.[key]) {
          return {
            status: 422,
            error: "stock_level_key_immutable",
            detail: `a stock level's ${key} cannot change; it would move its quantity to another item or warehouse unrecorded`,
          };
        }
      }
    }
    return null;
  };
}

// ---- goods receipt ------------------------------------------------------------------------------

const OPEN_ORDER_STATES = ["approved", "received"];

/**
 * A goods receipt entering `posted` receives every **stocked** order line's outstanding quantity into
 * its warehouse — the receipt has no lines of its own, so a partial receipt is not expressible and
 * the receipt is of the whole remainder. Per line: a receipt movement, the level, the order line's
 * `received_quantity`; then one entry Dr Inventory at standard / Cr GRNI at the order price, the
 * difference to the variance account. A service line is not a goods event and is not received here;
 * its bill is matched against what was ordered. Every line is read and validated before the first
 * write; the posting's own period and account refusals come after it, and the write's transaction
 * is what takes those writes back.
 */
export function goodsReceiptPostingEffect(config: InventoryConfig = {}): WriteEffect {
  return async (input) => {
    if (input.entity !== "GoodsReceipt" || !entersState(input, "status", "posted") || input.id === null) return;
    const gr = input.after;
    const poId = str(gr, "purchase_order_id");
    const warehouseId = str(gr, "warehouse_id");
    if (poId === null || warehouseId === null) return;
    const po = await input.store.get(input.tenantId, "PurchaseOrder", poId);
    if (po === null || !OPEN_ORDER_STATES.includes(String(po["state"]))) {
      throw new PostingRefused(
        422,
        "goods_receipt_order_not_open",
        "a goods receipt is posted only against a purchase order that is approved or already receiving",
      );
    }
    const currency = str(po, "currency") ?? "USD";
    const lines = await drainAll(
      input,
      "PurchaseOrderLine",
      [{ field: "purchase_order_id", op: "eq", value: poId }],
      config.maxRows ?? MAX_ROWS,
      "a goods receipt's order lines",
    );
    const receipts: { line: EntityRecord; item: Item; qty: bigint; price: bigint }[] = [];
    for (const line of lines) {
      const qty = (toUnits(line["quantity"], QTY_SCALE) ?? 0n) - (toUnits(line["received_quantity"], QTY_SCALE) ?? 0n);
      const itemId = str(line, "item_id");
      if (qty <= 0n || itemId === null) continue;
      const item = await readItem(input, itemId);
      if (!item.stocked) continue;
      if (item.std === null) throw new PostingRefused(422, "standard_cost_unset", STANDARD_COST_UNSET);
      if (item.currency !== currency) {
        throw new PostingRefused(
          422,
          "receipt_currency_mismatch",
          "a stocked item's standard cost is in a currency other than the order's, and this posting converts no currency",
        );
      }
      const price = toUnits(line["unit_price"], STD_SCALE);
      if (price === null) throw new PostingRefused(422, "order_line_unpriced", "an order line being received carries no unit_price");
      receipts.push({ line, item, qty, price });
    }
    if (receipts.length === 0) return;
    const policy = await policyOf(config, input.tenantId);
    const nowIso = nowOf(config);
    const actor = attributedToTrigger(gr);
    const stamp = { created_at: nowIso, updated_at: nowIso, ...actor };
    const grn = str(gr, "grn_number") ?? input.id;
    let atStandard = 0n;
    let atOrder = 0n;
    for (const r of receipts) {
      await advanceLine(input, "PurchaseOrderLine", r.line, "received_quantity", r.qty, nowIso);
      await input.store.create(input.tenantId, "StockMovement", {
        item_id: r.item.id,
        warehouse_id: warehouseId,
        movement_type: "receipt",
        quantity: renderUnits(r.qty, QTY_SCALE),
        reference: receiptReference(grn, r.line),
        reason: "Goods receipt",
        occurred_at: nowIso,
        ...stamp,
      });
      await applyStockDelta(input, r.item.id, warehouseId, r.qty, policy.allowNegativeStock, stamp);
      atStandard += extendedCents(r.item.std ?? 0n, r.qty, STD_SCALE);
      atOrder += extendedCents(r.price, r.qty, STD_SCALE);
    }
    const a = await resolveAccounts(input, config);
    await postEntry(
      input,
      config,
      `${grn}-GR`,
      `Goods receipt ${grn}`,
      [
        { account: a.inventory, description: "Goods receipt — inventory at standard", debit: atStandard, credit: 0n, currency },
        { account: a.grni, description: "Goods receipt — received not invoiced", debit: 0n, credit: atOrder, currency },
        // Ordered above standard is an unfavourable variance (a debit), below it a favourable one.
        {
          account: a.variance,
          description: "Goods receipt — purchase price variance",
          debit: atOrder > atStandard ? atOrder - atStandard : 0n,
          credit: atStandard > atOrder ? atStandard - atOrder : 0n,
          currency,
        },
      ],
      nowIso,
      actor,
    );
  };
}

/** The reference a receipt movement carries, which is how its cancellation finds it again. */
function receiptReference(grn: string, line: EntityRecord): string {
  return `${grn}:${String(line["id"])}`;
}

/**
 * A posted goods receipt cancelled takes back what it received: per order line, the net of the
 * movements carrying its reference (an issue movement out, the level, the order line's
 * `received_quantity`). Refused when the order line has been billed past what would remain
 * received. The entry is **not** a mirror of the receipt's: the units leave inventory at the
 * standard in force *now*, because a revaluation since the receipt has already restated them, and
 * a mirror at the receipt's standard would leave the inventory account off by exactly that
 * revaluation. GRNI is cleared at the order price it was raised at, and the difference goes to the
 * variance account, so across receipt, revaluation and cancellation every account nets to zero.
 * A cancelled receipt is final (locked), so its entry number cannot recur.
 */
export function goodsReceiptCancellationEffect(config: InventoryConfig = {}): WriteEffect {
  return async (input) => {
    if (input.entity !== "GoodsReceipt" || (input.operation !== "update" && input.operation !== "transition")) return;
    if (input.before?.["status"] !== "posted" || input.after["status"] !== "cancelled" || input.id === null) return;
    const gr = input.after;
    const poId = str(gr, "purchase_order_id");
    const warehouseId = str(gr, "warehouse_id");
    if (poId === null || warehouseId === null) return;
    const grn = str(gr, "grn_number") ?? input.id;
    const lines = await drainAll(
      input,
      "PurchaseOrderLine",
      [{ field: "purchase_order_id", op: "eq", value: poId }],
      config.maxRows ?? MAX_ROWS,
      "a goods receipt's order lines",
    );
    const po = await input.store.get(input.tenantId, "PurchaseOrder", poId);
    const currency = (po === null ? null : str(po, "currency")) ?? "USD";
    const plan: { line: EntityRecord; item: Item; received: bigint; price: bigint }[] = [];
    for (const line of lines) {
      const itemId = str(line, "item_id");
      if (itemId === null) continue;
      const movements = await drainAll(
        input,
        "StockMovement",
        [{ field: "reference", op: "eq", value: receiptReference(grn, line) }],
        config.maxRows ?? MAX_ROWS,
        "a goods receipt's stock movements",
      );
      let received = 0n;
      for (const m of movements) received += movementDelta(m) ?? 0n;
      if (received <= 0n) continue;
      const remaining = (toUnits(line["received_quantity"], QTY_SCALE) ?? 0n) - received;
      if ((await billedQuantity(input, String(line["id"]), null, config)) > remaining) {
        throw new PostingRefused(
          409,
          "goods_receipt_billed",
          "an order line this receipt received has been billed for more than would remain received; void the bill first",
        );
      }
      const price = toUnits(line["unit_price"], STD_SCALE);
      if (price === null) throw new PostingRefused(422, "order_line_unpriced", "an order line being reversed carries no unit_price");
      plan.push({ line, item: await readItem(input, itemId), received, price });
    }
    if (plan.length === 0) return;
    const policy = await policyOf(config, input.tenantId);
    const nowIso = nowOf(config);
    const actor = attributedToTrigger(gr);
    const stamp = { created_at: nowIso, updated_at: nowIso, ...actor };
    let atStandard = 0n;
    let atOrder = 0n;
    for (const p of plan) {
      await advanceLine(input, "PurchaseOrderLine", p.line, "received_quantity", -p.received, nowIso);
      await input.store.create(input.tenantId, "StockMovement", {
        item_id: p.item.id,
        warehouse_id: warehouseId,
        movement_type: "issue",
        quantity: renderUnits(p.received, QTY_SCALE),
        reference: receiptReference(grn, p.line),
        reason: "Goods receipt cancelled",
        occurred_at: nowIso,
        ...stamp,
      });
      await applyStockDelta(input, p.item.id, warehouseId, -p.received, policy.allowNegativeStock, stamp);
      atStandard += extendedCents(p.item.std ?? 0n, p.received, STD_SCALE);
      atOrder += extendedCents(p.price, p.received, STD_SCALE);
    }
    const a = await resolveAccounts(input, config);
    await postEntry(
      input,
      config,
      `${grn}-GR-VOID`,
      `Goods receipt ${grn} cancelled`,
      [
        { account: a.grni, description: "Goods receipt cancelled — received not invoiced", debit: atOrder, credit: 0n, currency },
        { account: a.inventory, description: "Goods receipt cancelled — inventory at standard", debit: 0n, credit: atStandard, currency },
        {
          account: a.variance,
          description: "Goods receipt cancelled — variance",
          debit: atStandard > atOrder ? atStandard - atOrder : 0n,
          credit: atOrder > atStandard ? atOrder - atStandard : 0n,
          currency,
        },
      ],
      nowIso,
      actor,
    );
  };
}

// ---- shipment -----------------------------------------------------------------------------------

/**
 * A shipment entering `shipped` issues every order line's unfulfilled quantity of a stocked item
 * from its warehouse — the shipment has no lines of its own, so it ships the whole remainder. Per
 * line: an issue movement, the level (refused below zero unless the tenant declared negative stock
 * allowed), the order line's `fulfilled_quantity`; then Dr COGS / Cr Inventory at standard, one pair
 * per currency. Lines with no item, or a service item, are not shipped and stay unfulfilled.
 */
export function shipmentIssueEffect(config: InventoryConfig = {}): WriteEffect {
  return async (input) => {
    if (input.entity !== "Shipment" || !entersState(input, "state", "shipped") || input.id === null) return;
    const sh = input.after;
    const soId = str(sh, "sales_order_id");
    if (soId === null) return;
    const lines = await drainAll(
      input,
      "SalesOrderLine",
      [{ field: "sales_order_id", op: "eq", value: soId }],
      config.maxRows ?? MAX_ROWS,
      "a shipment's order lines",
    );
    const issues: { line: EntityRecord; item: Item; qty: bigint }[] = [];
    for (const line of lines) {
      const itemId = str(line, "item_id");
      if (itemId === null) continue;
      const qty = (toUnits(line["quantity"], QTY_SCALE) ?? 0n) - (toUnits(line["fulfilled_quantity"], QTY_SCALE) ?? 0n);
      if (qty <= 0n) continue;
      const item = await readItem(input, itemId);
      if (!item.stocked) continue;
      if (item.std === null) throw new PostingRefused(422, "standard_cost_unset", STANDARD_COST_UNSET);
      issues.push({ line, item, qty });
    }
    if (issues.length === 0) return;
    const warehouseId = str(sh, "warehouse_id");
    if (warehouseId === null) {
      throw new PostingRefused(422, "shipment_warehouse_unset", "a shipment of stocked items names the warehouse it ships from");
    }
    const policy = await policyOf(config, input.tenantId);
    // Checked before anything is written, summed per item, so two lines of one item cannot each pass.
    const wanted = new Map<string, bigint>();
    for (const i of issues) wanted.set(i.item.id, (wanted.get(i.item.id) ?? 0n) + i.qty);
    if (!policy.allowNegativeStock) {
      for (const [itemId, qty] of wanted) {
        const level = await readLevel(input, itemId, warehouseId);
        const onHand = level === undefined ? 0n : (toUnits(level["quantity_on_hand"], QTY_SCALE) ?? 0n);
        if (onHand < qty) throw new PostingRefused(422, "stock_insufficient", NEGATIVE_STOCK_DETAIL);
      }
    }
    const nowIso = nowOf(config);
    const actor = attributedToTrigger(sh);
    const number = str(sh, "shipment_number") ?? input.id;
    const cogsByCurrency = new Map<string, bigint>();
    for (const i of issues) {
      await advanceLine(input, "SalesOrderLine", i.line, "fulfilled_quantity", i.qty, nowIso);
      await input.store.create(input.tenantId, "StockMovement", {
        item_id: i.item.id,
        warehouse_id: warehouseId,
        movement_type: "issue",
        quantity: renderUnits(i.qty, QTY_SCALE),
        reference: `${number}:${String(i.line["id"])}`,
        reason: "Shipment",
        occurred_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
        ...actor,
      });
      await applyStockDelta(input, i.item.id, warehouseId, -i.qty, policy.allowNegativeStock, {
        created_at: nowIso,
        updated_at: nowIso,
        ...actor,
      });
      cogsByCurrency.set(i.item.currency, (cogsByCurrency.get(i.item.currency) ?? 0n) + extendedCents(i.item.std ?? 0n, i.qty, STD_SCALE));
    }
    const a = await resolveAccounts(input, config);
    const lines2: PostingLine[] = [];
    for (const [currency, cents] of cogsByCurrency) {
      lines2.push(...pair(a.cogs, a.inventory, cents, currency, ["Shipment — cost of goods sold", "Shipment — inventory at standard"]));
    }
    await postEntry(input, config, `${number}-COGS`, `Cost of goods shipped ${number}`, lines2, nowIso, actor);
  };
}

// ---- standard-cost revaluation ------------------------------------------------------------------

/**
 * A changed standard cost revalues every unit on hand: `round((new − old) × qty)` per stock level,
 * Dr/Cr Inventory against the variance account — which is what keeps the inventory account equal to
 * on-hand × standard after the change.
 */
export function standardCostRevaluationEffect(config: InventoryConfig = {}): WriteEffect {
  return async (input) => {
    if (input.entity !== "Item" || input.operation !== "update" || input.id === null) return;
    const before = toUnits(input.before?.["standard_cost"], STD_SCALE) ?? 0n;
    const after = toUnits(input.after["standard_cost"], STD_SCALE) ?? 0n;
    if (before === after || !isStockedItem(input.after)) return;
    const levels = await drainAll(
      input,
      "StockLevel",
      [{ field: "item_id", op: "eq", value: input.id }],
      config.maxRows ?? MAX_ROWS,
      "an item's stock levels",
    );
    let cents = 0n;
    for (const l of levels) cents += extendedCents(after - before, toUnits(l["quantity_on_hand"], QTY_SCALE) ?? 0n, STD_SCALE);
    if (cents === 0n) return;
    const nowIso = nowOf(config);
    const actor = attributedToTrigger(input.after);
    const a = await resolveAccounts(input, config);
    await postEntry(
      input,
      config,
      `IR-${Date.parse(nowIso).toString(36)}-${shortId(input.id)}`,
      "Standard cost revaluation",
      pair(a.inventory, a.variance, cents, str(input.after, "currency") ?? "USD", [
        "Standard cost change — inventory",
        "Standard cost change — variance",
      ]),
      nowIso,
      actor,
    );
  };
}

// ---- bill matching ------------------------------------------------------------------------------

const BILLED_STATES = ["approved", "overdue", "paid"];

/** Quantity billed against one order line by bills that stand, excluding `exceptBillId`. */
async function billedQuantity(
  input: { store: EntityStore; tenantId: string },
  poLineId: string,
  exceptBillId: string | null,
  config: InventoryConfig,
): Promise<bigint> {
  const billLines = await drainAll(
    input,
    "BillLine",
    [{ field: "purchase_order_line_id", op: "eq", value: poLineId }],
    config.maxRows ?? MAX_ROWS,
    "the bill lines matched to an order line",
  );
  let total = 0n;
  const states = new Map<string, string>();
  for (const bl of billLines) {
    const billId = str(bl, "bill_id");
    if (billId === null || billId === exceptBillId) continue;
    let state = states.get(billId);
    if (state === undefined) {
      state = String((await input.store.get(input.tenantId, "Bill", billId))?.["state"] ?? "");
      states.set(billId, state);
    }
    if (BILLED_STATES.includes(state)) total += toUnits(bl["quantity"], QTY_SCALE) ?? 0n;
  }
  return total;
}

function pctUnits(pct: number): bigint {
  return toUnits(pct, 4) ?? 0n;
}

/**
 * Three-way match on approval: every bill line that names a purchase order line must agree with it
 * and with what was received — the same order (when the bill names one), the same item, the same
 * currency, a unit price within the tenant's price tolerance, and a cumulative billed quantity (this
 * bill plus every other standing bill) within the quantity tolerance of `received_quantity`. A bill
 * line naming no order line is not matched (freight, a service billed without an order).
 */
export function threeWayMatchGuard(config: InventoryConfig = {}): WriteGuard {
  return async (input) => {
    if (input.entity !== "Bill" || input.operation === "delete" || input.operation === "create") return null;
    if (input.after["state"] !== "approved" || input.before?.["state"] === "approved" || input.id === null) return null;
    const bill = input.after;
    const billLines = await drainAll(
      input,
      "BillLine",
      [{ field: "bill_id", op: "eq", value: input.id }],
      config.maxRows ?? MAX_ROWS,
      "a bill's lines",
    );
    const billPo = str(bill, "purchase_order_id");
    if (config.receiptsCreditGrni === true && billPo !== null) {
      const unlinkedItems = new Set(
        billLines.filter((l) => str(l, "purchase_order_line_id") === null).flatMap((l) => str(l, "item_id") ?? []),
      );
      if (unlinkedItems.size > 0 && (await receiptCreditedAnyItem(input, billPo, unlinkedItems, config))) {
        return refusal(
          "match_order_line_unset",
          "a bill line bills an item a goods receipt on this bill's purchase order has received, but names no " +
            "purchase_order_line_id — approving it would leave that receipt's received-not-invoiced credit uncleared " +
            "and count the goods in expense as well as in inventory; set the line's purchase_order_line_id",
        );
      }
    }
    const matched = billLines.filter((l) => str(l, "purchase_order_line_id") !== null);
    if (matched.length === 0) return null;
    const policy = await policyOf(config, input.tenantId);
    const billCurrency = str(bill, "currency") ?? "USD";
    const thisBill = new Map<string, bigint>();
    for (const bl of matched) {
      const poLineId = str(bl, "purchase_order_line_id")!;
      thisBill.set(poLineId, (thisBill.get(poLineId) ?? 0n) + (toUnits(bl["quantity"], QTY_SCALE) ?? 0n));
      const poLine = await input.store.get(input.tenantId, "PurchaseOrderLine", poLineId);
      if (poLine === null) return refusal("match_order_line_missing", "a bill line names a purchase order line that does not exist");
      const poId = str(poLine, "purchase_order_id");
      if (billPo !== null && poId !== billPo) {
        return refusal("match_order_mismatch", "a bill line names an order line from a purchase order other than the bill's");
      }
      const po = poId === null ? null : await input.store.get(input.tenantId, "PurchaseOrder", poId);
      if ((str(po, "currency") ?? "USD") !== billCurrency) {
        return refusal("match_currency_mismatch", "a bill line is matched to an order in another currency");
      }
      const blItem = str(bl, "item_id");
      if (blItem !== null && blItem !== str(poLine, "item_id")) {
        return refusal("match_item_mismatch", "a bill line names an item other than its order line's");
      }
      const poPrice = toUnits(poLine["unit_price"], STD_SCALE) ?? 0n;
      const billPrice = toUnits(bl["unit_price"], STD_SCALE) ?? 0n;
      const diff = billPrice > poPrice ? billPrice - poPrice : poPrice - billPrice;
      // |bill − order| × 100 ≤ order × tol, with tol at four decimals.
      if (diff * 100n * 10_000n > poPrice * pctUnits(policy.matchPriceTolerancePct)) {
        return refusal("match_price_variance", "a bill line's unit price differs from its order line's by more than the tenant's price tolerance");
      }
    }
    for (const [poLineId, qty] of thisBill) {
      const poLine = await input.store.get(input.tenantId, "PurchaseOrderLine", poLineId);
      const itemId = str(poLine, "item_id");
      // A goods line is matched against what was received; a service line, which no goods receipt
      // receives, against what was ordered — a two-way match, the most its record can support.
      const goods = itemId !== null && (await readItem(input, itemId)).stocked;
      const ceiling = toUnits(poLine?.[goods ? "received_quantity" : "quantity"], QTY_SCALE) ?? 0n;
      const billed = qty + (await billedQuantity(input, poLineId, input.id, config));
      // billed × 100 ≤ ceiling × (100 + tol)
      if (billed * 100n * 10_000n > ceiling * (100n * 10_000n + pctUnits(policy.matchQuantityTolerancePct))) {
        return goods
          ? refusal(
              "match_quantity_exceeds_received",
              "a bill line bills more of an order line than has been received (counting every standing bill); receive the goods first",
            )
          : refusal(
              "match_quantity_exceeds_ordered",
              "a bill line bills more of a service order line than was ordered (counting every standing bill)",
            );
      }
    }
    return null;
  };
}

/**
 * Whether a goods receipt on `poId` has credited GRNI for an order line of one of `itemIds`: a net
 * positive quantity of receipt movements carrying that receipt's reference for the line. Asked of
 * the movements rather than of `received_quantity` or the receipt's status, because a receipt
 * posted before this module existed has the status and wrote no movement and credited nothing.
 */
async function receiptCreditedAnyItem(
  input: { store: EntityStore; tenantId: string },
  poId: string,
  itemIds: ReadonlySet<string>,
  config: InventoryConfig,
): Promise<boolean> {
  const ceiling = config.maxRows ?? MAX_ROWS;
  const lines = (
    await drainAll(input, "PurchaseOrderLine", [{ field: "purchase_order_id", op: "eq", value: poId }], ceiling, "a bill's order lines")
  ).filter((l) => itemIds.has(str(l, "item_id") ?? ""));
  if (lines.length === 0) return false;
  const receipts = await drainAll(
    input,
    "GoodsReceipt",
    [{ field: "purchase_order_id", op: "eq", value: poId }],
    ceiling,
    "an order's goods receipts",
  );
  for (const gr of receipts) {
    const grn = str(gr, "grn_number") ?? str(gr, "id");
    if (grn === null) continue;
    for (const line of lines) {
      const movements = await drainAll(
        input,
        "StockMovement",
        [{ field: "reference", op: "eq", value: receiptReference(grn, line) }],
        ceiling,
        "a goods receipt's stock movements",
      );
      let net = 0n;
      for (const m of movements) net += movementDelta(m) ?? 0n;
      if (net > 0n) return true;
    }
  }
  return false;
}

function refusal(error: string, detail: string): { status: number; error: string; detail: string } {
  return { status: 422, error, detail };
}

/**
 * On approval, a matched bill line for a stocked item clears what its receipt credited to GRNI:
 * Dr GRNI / Cr expense at the **order** price × billed quantity. The bill's recognition entry put the
 * whole net in expense; this moves the received value out of it, leaving only the price variance
 * between bill and order in expense. Voiding the bill reverses it with `postingReversalEffect`.
 */
export function grniClearingEffect(config: InventoryConfig = {}): WriteEffect {
  return async (input) => {
    if (input.entity !== "Bill" || !entersState(input, "state", "approved") || input.id === null) return;
    const bill = input.after;
    const billLines = await drainAll(
      input,
      "BillLine",
      [{ field: "bill_id", op: "eq", value: input.id }],
      config.maxRows ?? MAX_ROWS,
      "a bill's lines",
    );
    let cents = 0n;
    for (const bl of billLines) {
      const poLineId = str(bl, "purchase_order_line_id");
      if (poLineId === null) continue;
      const poLine = await input.store.get(input.tenantId, "PurchaseOrderLine", poLineId);
      const itemId = str(poLine, "item_id");
      if (poLine === null || itemId === null || !(await readItem(input, itemId)).stocked) continue;
      cents += extendedCents(toUnits(poLine["unit_price"], STD_SCALE) ?? 0n, toUnits(bl["quantity"], QTY_SCALE) ?? 0n, STD_SCALE);
    }
    if (cents === 0n) return;
    const nowIso = nowOf(config);
    const actor = attributedToTrigger(bill);
    const number = str(bill, "bill_number") ?? input.id;
    const a = await resolveAccounts(input, config);
    await postEntry(
      input,
      config,
      `${number}-GRNI`,
      `Received-not-invoiced cleared by ${number}`,
      pair(a.grni, a.expense, cents, str(bill, "currency") ?? "USD", ["Bill — GRNI cleared", "Bill — expense reclassed to inventory receipt"]),
      nowIso,
      actor,
    );
  };
}
