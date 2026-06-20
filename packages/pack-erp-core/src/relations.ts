import type { Relation } from "@crossengin/types/meta-schema";

// ---- CRM (original) ----------------------------------------------------------

export const ACCOUNT_CONTACTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "contacts",
  to: "Contact",
  onDelete: "cascade",
};

export const INVOICE_ACCOUNT_RELATION: Relation = {
  kind: "many_to_one",
  from: "Invoice",
  field: "account_id",
  to: "Account",
  onDelete: "restrict",
};

export const INVOICE_LINES_RELATION: Relation = {
  kind: "one_to_many",
  from: "Invoice",
  field: "lines",
  to: "InvoiceLine",
  onDelete: "cascade",
};

// ---- Inventory ---------------------------------------------------------------

export const STOCK_LEVEL_ITEM_RELATION: Relation = {
  kind: "many_to_one",
  from: "StockLevel",
  field: "item_id",
  to: "Item",
  onDelete: "cascade",
};

export const STOCK_LEVEL_WAREHOUSE_RELATION: Relation = {
  kind: "many_to_one",
  from: "StockLevel",
  field: "warehouse_id",
  to: "Warehouse",
  onDelete: "cascade",
};

export const STOCK_MOVEMENT_ITEM_RELATION: Relation = {
  kind: "many_to_one",
  from: "StockMovement",
  field: "item_id",
  to: "Item",
  onDelete: "restrict",
};

export const STOCK_MOVEMENT_WAREHOUSE_RELATION: Relation = {
  kind: "many_to_one",
  from: "StockMovement",
  field: "warehouse_id",
  to: "Warehouse",
  onDelete: "restrict",
};

// ---- Procurement -------------------------------------------------------------

export const PURCHASE_ORDER_VENDOR_RELATION: Relation = {
  kind: "many_to_one",
  from: "PurchaseOrder",
  field: "vendor_id",
  to: "Vendor",
  onDelete: "restrict",
};

export const PURCHASE_ORDER_WAREHOUSE_RELATION: Relation = {
  kind: "many_to_one",
  from: "PurchaseOrder",
  field: "warehouse_id",
  to: "Warehouse",
  onDelete: "set_null",
};

export const PURCHASE_ORDER_LINES_RELATION: Relation = {
  kind: "many_to_one",
  from: "PurchaseOrderLine",
  field: "purchase_order_id",
  to: "PurchaseOrder",
  onDelete: "cascade",
};

export const PURCHASE_ORDER_LINE_ITEM_RELATION: Relation = {
  kind: "many_to_one",
  from: "PurchaseOrderLine",
  field: "item_id",
  to: "Item",
  onDelete: "restrict",
};

export const GOODS_RECEIPT_PO_RELATION: Relation = {
  kind: "many_to_one",
  from: "GoodsReceipt",
  field: "purchase_order_id",
  to: "PurchaseOrder",
  onDelete: "restrict",
};

// ---- Finance -----------------------------------------------------------------

export const JOURNAL_LINE_ENTRY_RELATION: Relation = {
  kind: "many_to_one",
  from: "JournalLine",
  field: "journal_entry_id",
  to: "JournalEntry",
  onDelete: "cascade",
};

export const JOURNAL_LINE_ACCOUNT_RELATION: Relation = {
  kind: "many_to_one",
  from: "JournalLine",
  field: "ledger_account_id",
  to: "LedgerAccount",
  onDelete: "restrict",
};

export const PAYMENT_ACCOUNT_RELATION: Relation = {
  kind: "many_to_one",
  from: "Payment",
  field: "account_id",
  to: "Account",
  onDelete: "set_null",
};

export const BILL_VENDOR_RELATION: Relation = {
  kind: "many_to_one",
  from: "Bill",
  field: "vendor_id",
  to: "Vendor",
  onDelete: "restrict",
};

export const BILL_PO_RELATION: Relation = {
  kind: "many_to_one",
  from: "Bill",
  field: "purchase_order_id",
  to: "PurchaseOrder",
  onDelete: "set_null",
};

export const BILL_LINES_RELATION: Relation = {
  kind: "many_to_one",
  from: "BillLine",
  field: "bill_id",
  to: "Bill",
  onDelete: "cascade",
};

export const EXPENSE_EMPLOYEE_RELATION: Relation = {
  kind: "many_to_one",
  from: "Expense",
  field: "employee_id",
  to: "Employee",
  onDelete: "restrict",
};

// ---- HR / org ----------------------------------------------------------------

export const POSITION_DEPARTMENT_RELATION: Relation = {
  kind: "many_to_one",
  from: "Position",
  field: "department_id",
  to: "Department",
  onDelete: "restrict",
};

export const EMPLOYEE_DEPARTMENT_RELATION: Relation = {
  kind: "many_to_one",
  from: "Employee",
  field: "department_id",
  to: "Department",
  onDelete: "set_null",
};

export const EMPLOYEE_POSITION_RELATION: Relation = {
  kind: "many_to_one",
  from: "Employee",
  field: "position_id",
  to: "Position",
  onDelete: "set_null",
};

export const LEAVE_REQUEST_EMPLOYEE_RELATION: Relation = {
  kind: "many_to_one",
  from: "LeaveRequest",
  field: "employee_id",
  to: "Employee",
  onDelete: "cascade",
};

export const ERP_CORE_RELATIONS: readonly Relation[] = [
  // CRM
  ACCOUNT_CONTACTS_RELATION,
  INVOICE_ACCOUNT_RELATION,
  INVOICE_LINES_RELATION,
  // Inventory
  STOCK_LEVEL_ITEM_RELATION,
  STOCK_LEVEL_WAREHOUSE_RELATION,
  STOCK_MOVEMENT_ITEM_RELATION,
  STOCK_MOVEMENT_WAREHOUSE_RELATION,
  // Procurement
  PURCHASE_ORDER_VENDOR_RELATION,
  PURCHASE_ORDER_WAREHOUSE_RELATION,
  PURCHASE_ORDER_LINES_RELATION,
  PURCHASE_ORDER_LINE_ITEM_RELATION,
  GOODS_RECEIPT_PO_RELATION,
  // Finance
  JOURNAL_LINE_ENTRY_RELATION,
  JOURNAL_LINE_ACCOUNT_RELATION,
  PAYMENT_ACCOUNT_RELATION,
  BILL_VENDOR_RELATION,
  BILL_PO_RELATION,
  BILL_LINES_RELATION,
  EXPENSE_EMPLOYEE_RELATION,
  // HR / org
  POSITION_DEPARTMENT_RELATION,
  EMPLOYEE_DEPARTMENT_RELATION,
  EMPLOYEE_POSITION_RELATION,
  LEAVE_REQUEST_EMPLOYEE_RELATION,
];
