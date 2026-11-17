# ADR-0431: Stock moves only through a movement, at standard cost, and a bill is matched to what was received

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0338 (refuse only if nothing correct breaks), ADR-0378 (exact money arithmetic), ADR-0419 (a document's lock and its state), ADR-0421 (server-owned body keys), ADR-0422 (`updateIf` and the exact per-currency balance), ADR-0423 (409 `server_reference_unresolved`), ADR-0430 (the work-order job whose movements this makes real) |

## Context

The external due-diligence audit ranked **H-14** high (R01-12, R02-04): no inventory, no cost of
goods sold, no three-way matching, no bank reconciliation, no depreciation, no payroll. Verified
at `f6faf05`, true when written and open: a grep for `StockLevel`, `StockMovement`,
`GoodsReceipt`, `Shipment`, COGS and depreciation over `operate-runtime/src` and
`operate-server/src` found only comments, and no bank-account or bank-statement entity exists.
Depreciation has since been narrowed by ADR-0430, which posts straight-line only.

Measured before this change: **no write effect or guard named** `StockMovement`, `StockLevel`,
`GoodsReceipt`, `Shipment` or `BillLine`; `BillLine` had no link to a purchase-order line; and the
only `StockMovement` writer was ADR-0430's work-order job, which never moved a `StockLevel`. So a
posted goods receipt changed no stock and posted nothing, and a shipment shipped goods with no stock
decrease and no cost of goods sold.

## Decision

**A stock level moves only through a stock movement, valued at standard cost, in the same
transaction.**

- A movement updates its item/warehouse level in the same transaction, with a compare-and-set
  retry. Below zero is **422 `stock_insufficient`** unless the tenant sets
  `inventory.allowNegativeStock`. A movement cannot be edited or deleted (**422
  `stock_movement_immutable`**); a level's item and warehouse cannot change; a hand edit of a
  level's quantity writes and posts an adjustment movement; a second level for the same pair is
  **409 `stock_level_exists`**. A movement written directly posts at standard cost against an
  inventory variance account.
- **Valuation is standard cost**, from the existing `Item.standard_cost`. Changing it revalues the
  stock on hand, so the inventory account stays equal to quantity × standard. A stocked item with
  no standard cost is **422 `standard_cost_unset`** at receipt and shipment. Every entry is exact,
  per ADR-0378.
- **Goods receipt.** Posting is **422 `goods_receipt_order_not_open`** unless the purchase order is
  approved or received. It receives each stocked line's outstanding quantity, advances
  `received_quantity`, and posts Dr inventory at standard / Cr goods-received-not-invoiced (GRNI) at
  the order price, the difference to purchase price variance. A posted receipt is locked except for
  cancellation, and cancelled is final. Cancelling takes the stock back **at the standard cost in
  force now**, and is **409 `goods_receipt_billed`** once those goods are billed.
  `PurchaseOrderLine.received_quantity` is server-owned once receipt postings are wired (422
  `field_server_owned`, read-only in the UI).
- **Shipment.** Shipping issues the unfulfilled quantity of each stocked line, advances
  `fulfilled_quantity`, and posts Dr COGS / Cr inventory at standard. Stock is checked per item for
  the whole shipment **before the first write**, so a store without transactions is not left
  half-shipped.
- **Three-way match on bill approval**, over a new optional `BillLine.purchase_order_line_id`.
  Approval refuses a matched line whose order, currency or item disagrees, or whose price differs
  by more than the tenant's tolerance (default 0%), or which bills more than was received counting
  the other bills still standing (a service line is matched against the ordered quantity). An
  **unlinked** line naming an item a receipt on the bill's order has actually credited is **422
  `match_order_line_unset`**. Approval clears GRNI at the order price; voiding the bill reverses it.
- Account codes resolve from four new finance settings, unresolved being ADR-0423's 409. A new
  `inventory` settings block holds the negative-stock switch and the two tolerances. Each group of
  effects is wired only when the manifest has every field it reads, and GL postings only when it has
  a ledger. An `[inventory]` boot line says which, through a required
  `inventoryPostsToLedger(manifest)`, so a manifest with no ledger is not told its receipts post.

**The rule behind the upgrade cost** is ADR-0338's: shipments of stocked items now refuse below
zero, and stock that was never recorded reads as zero. The old behaviour shipped goods with no stock
decrease and no cost of goods sold, which was not a correct answer to preserve. The hatch is a
**per-tenant setting** named in every refusal and announced at boot, not a CLI flag.

## Alternatives considered

- **Moving average.** Refused: it has a cost-state race between concurrent movements and is not
  exact. `Item.standard_cost` already exists with grants, has no cost state, and stays exact.
- **Reverse a cancelled receipt's entry at its original standard cost.** Refused on measurement:
  after a revaluation it left the inventory account wrong by exactly the revaluation (299¢ in the
  test). Cancellation posts its own entry at the current standard.
- **Key the unlinked-line refusal on `received_quantity` or the receipt's status.** Refused: a
  receipt posted before this change wrote no movements and a cancelled receipt credited nothing, so
  both would refuse bills that clear nothing. The test is a net-positive set of receipt movements
  carrying that receipt's reference.
- **Leave an unlinked bill line unrefused.** Refused on measurement: receive 5 at 12, approve an
  unlinked bill, ship them — balances `GRNI −6000, expense +6000, cost_of_goods_sold +5000` (cents),
  110.00 in the P&L for goods that cost 60.00, and GRNI never clears. Before this change the same
  flow expensed the goods once, so this was a regression on the normal path, since every existing
  bill and form omits the link.
- **Make `SalesOrderLine.fulfilled_quantity` server-owned** as `received_quantity` is. Refused:
  service lines need a person to set it.
- **A CLI-wide negative-stock hatch.** Not taken: the setting is per tenant and every refusal names
  it. Whether a deployment-wide one is also wanted is open.

## Consequences

- **Positive:** stock, COGS, GRNI and price variance post as goods move, and every entry balances
  exactly. A bill can be matched to what was ordered and received. ADR-0430's work-order movements
  now move levels and post against the variance account (there is no work-in-progress account); a
  work order whose component issue is refused withholds the finished-good receipt
  (`receipt_withheld`) and a later run writes both.
- **Negative, on upgrade:** a shipment of a stocked item is 422 until stock is recorded or the
  tenant allows negative stock; a stocked item with no standard cost is 422 at receipt and
  shipment; an unlinked goods bill on a received order is 422. Bills that predate the upgrade are
  not re-examined.
- **Neutral:** `BillLine.purchase_order_line_id` is optional and no relation was added, so relation
  counts are unchanged. The in-process conditional update (`store.ts`) now compares decimals as
  figures, as the column store's `NUMERIC` already did — a level stored as `5` or `"5"` never matched
  the canonical `"5.000"` and every movement got a retryable 409 no retry could satisfy. One test in
  `transition-race.test.ts` pinned the text-strict comparison and was rewritten.
- **Reversibility:** the settings hatch reverses the refusal per tenant; removing the effects
  leaves posted entries standing.

## Implementation notes

`packages/operate-runtime/src/inventory.ts` (new, with 35 tests at implementation), wired from
`compile.ts` with the settings store passed to the guards; `settings.ts` gains the four account codes
and `InventorySettingsSchema`. In process: `operate-runtime` 1367/1367, `operate-server` 5675/5675,
`operate-runtime-pg` 790/790, `testing` 796/796, `pack-erp-core` 61/61, the other six packs and
`kernel` green, typecheck clean. Count fences moved with the new field: own/resolved fields
426→427 and 630→631, list parameters 1774→1783, filter parameters 1539→1548. ADR-0430's work-order
tests used item ids that did not exist and pinned movements that move nothing; they were rewritten
to seed real items and stock, with a refusal arm for a component issue below zero.

Mutation-checked, each restored byte-identical: level below zero (1 failing), shipment pre-check
(1, after adding the non-transactional-store test that covers it — 0 before), price tolerance (1),
quantity vs received (2), other standing bills counted (1 at implementation, 2 on the review's
re-check), movement immutable (1), cancel refused
once billed (1), cancel at current standard (2), goods-receipt lock (1), unlinked-line refusal (1),
net of receipt movements (1), `received_quantity` server-owned (1), duplicate level (1), decimal
comparison (1 in inventory, 1 in store), work-order receipt withheld (1). The per-currency balance
assertion inside the posting helper is defensive and was not mutation-checked: no test can produce
an unbalanced posting.

Verified live on PG 16 with `erp-core`, identically on both stores — `--store pg` as
`crossengin_app`, `--store pg-columns` as the owner because it cannot boot as `crossengin_app`:
receipt against a draft order 422 `goods_receipt_order_not_open`; PATCH `received_quantity` 422
`field_server_owned` (201 before); receipt of 5 at 12 with standard 10 gives level 5.000,
`received_quantity` 5.000, inventory +50 / GRNI −60 / price variance +10; ship 2 gives level 3.000,
`fulfilled_quantity` 2.000, COGS +20 / inventory −20; ship 10 with 3 on hand 422
`stock_insufficient`, level unchanged; PATCH a movement 422 `stock_movement_immutable`; duplicate
level 409 `stock_level_exists`; unlinked line / billing 6 against 5 / price 13 against 12 give 422
`match_order_line_unset` / `match_quantity_exceeds_received` / `match_price_variance`; the matched
bill approves 200 with GRNI +60 / AP −60.

The implementation report's "every existing deployment is at zero" is false: a stock level could
always be created with a typed quantity, and that stock has no inventory-account value. Its "approved
or receiving" is `received` in the code and the order states. Where the two reports' test counts
differ, the reviewer's later run is used above.

## Open questions

1. **Opening balances.** Pre-existing typed stock has no inventory value, so shipping it drives the
   inventory account negative and "inventory = quantity × standard" holds only from zero. Needs a
   decision on how to value stock that already exists.
2. **Bank reconciliation** is not implemented: the model has no `BankAccount`, `BankStatement` or
   `BankStatementLine` entities. **Payroll** was out of scope, and `pack-erp-core`'s description still
   lists "payroll disbursement", declared and served by nothing.
3. **Retail and grocery ship nothing**: their orders use `OrderLine` with `product_id`, not `Item`, so
   a shipment issues no stock and posts no COGS while the boot line says shipments issue stock.
4. No unique (item, warehouse) constraint: two simultaneous first movements can create duplicate
   levels, then refused 409 `stock_level_ambiguous`. Two bills approved at once against one order
   line can both pass the match.
5. Goods receipts and shipments have no lines, so they receive or ship the whole remainder only.
   Inventory posts in the transaction currency only, and a receipt is refused when the item's cost
   currency differs from the order's. A kit is its own SKU, with no bill-of-materials explosion.
6. A hand-edited `fulfilled_quantity` stops the next shipment issuing that quantity; a hand-edited
   stock level is not conditional and can overwrite a concurrent movement.
7. A bill naming no order, or a line with no item, can clear nothing for goods received — not
   detectable without guessing. A quantity tolerance above zero can clear GRNI past what was
   received.
8. Two standard-cost changes in the same millisecond produce the same entry number (a 409 on a
   store enforcing uniqueness). Changing an item's type or currency with stock on hand is not
   handled. The boot line covers the boot manifest, not a tenant's own.

## References

- `packages/operate-runtime/src/inventory.ts`, `compile.ts`, `settings.ts`, `store.ts`,
  `write-effects.ts`; `packages/pack-erp-core/src/entities-finance.ts`;
  `apps/operate-server/src/erp-job-handlers.ts`, `node.ts`
- The verified audit's H-14 row and accounting evidence notes (A2)
