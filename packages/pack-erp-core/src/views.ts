import {
  ListViewSchema,
  type ListView,
  type ViewDeclaration,
} from "@crossengin/views";

interface Col {
  readonly field: string;
  readonly label: string;
}

function listView(input: {
  entity: string;
  label: string;
  sortField: string;
  sortDir?: "asc" | "desc";
  columns: readonly Col[];
  pageSize?: number;
}): ListView {
  return ListViewSchema.parse({
    kind: "list",
    entity: input.entity,
    label: { en: input.label },
    permissions: "inherit",
    sort: [{ field: input.sortField, direction: input.sortDir ?? "asc" }],
    columns: input.columns.map((c) => ({ field: c.field, label: { en: c.label } })),
    pageSize: input.pageSize ?? 50,
    exportFormats: ["csv", "xlsx"],
  });
}

// ---- CRM (original) ----------------------------------------------------------

export const ACCOUNT_LIST_VIEW: ListView = listView({
  entity: "Account",
  label: "Accounts",
  sortField: "name",
  columns: [
    { field: "name", label: "Name" },
    { field: "status", label: "Status" },
    { field: "industry", label: "Industry" },
    { field: "billing_email", label: "Billing email" },
    { field: "country", label: "Country" },
  ],
});

export const INVOICE_LIST_VIEW: ListView = listView({
  entity: "Invoice",
  label: "Invoices",
  sortField: "due_date",
  columns: [
    { field: "invoice_number", label: "Number" },
    { field: "account_id", label: "Account" },
    { field: "state", label: "State" },
    { field: "total", label: "Total" },
    { field: "currency", label: "Currency" },
    { field: "due_date", label: "Due date" },
  ],
  pageSize: 100,
});

// ---- Inventory ---------------------------------------------------------------

export const ITEM_LIST_VIEW: ListView = listView({
  entity: "Item",
  label: "Items",
  sortField: "name",
  columns: [
    { field: "sku", label: "SKU" },
    { field: "name", label: "Name" },
    { field: "item_type", label: "Type" },
    { field: "category", label: "Category" },
    { field: "list_price", label: "List price" },
    { field: "status", label: "Status" },
  ],
});

export const WAREHOUSE_LIST_VIEW: ListView = listView({
  entity: "Warehouse",
  label: "Warehouses",
  sortField: "name",
  columns: [
    { field: "code", label: "Code" },
    { field: "name", label: "Name" },
    { field: "warehouse_type", label: "Type" },
    { field: "city", label: "City" },
    { field: "country", label: "Country" },
    { field: "status", label: "Status" },
  ],
});

export const STOCK_LEVEL_LIST_VIEW: ListView = listView({
  entity: "StockLevel",
  label: "Stock levels",
  sortField: "item_id",
  columns: [
    { field: "item_id", label: "Item" },
    { field: "warehouse_id", label: "Warehouse" },
    { field: "quantity_on_hand", label: "On hand" },
    { field: "quantity_reserved", label: "Reserved" },
    { field: "quantity_incoming", label: "Incoming" },
    { field: "bin_location", label: "Bin" },
  ],
});

// ---- Procurement -------------------------------------------------------------

export const VENDOR_LIST_VIEW: ListView = listView({
  entity: "Vendor",
  label: "Vendors",
  sortField: "name",
  columns: [
    { field: "vendor_code", label: "Code" },
    { field: "name", label: "Name" },
    { field: "status", label: "Status" },
    { field: "payment_terms", label: "Terms" },
    { field: "country", label: "Country" },
  ],
});

export const PURCHASE_ORDER_LIST_VIEW: ListView = listView({
  entity: "PurchaseOrder",
  label: "Purchase orders",
  sortField: "order_date",
  sortDir: "desc",
  columns: [
    { field: "po_number", label: "PO #" },
    { field: "vendor_id", label: "Vendor" },
    { field: "state", label: "State" },
    { field: "order_date", label: "Order date" },
    { field: "total", label: "Total" },
    { field: "currency", label: "Currency" },
  ],
  pageSize: 100,
});

export const GOODS_RECEIPT_LIST_VIEW: ListView = listView({
  entity: "GoodsReceipt",
  label: "Goods receipts",
  sortField: "received_date",
  sortDir: "desc",
  columns: [
    { field: "grn_number", label: "GRN #" },
    { field: "purchase_order_id", label: "PO" },
    { field: "warehouse_id", label: "Warehouse" },
    { field: "received_date", label: "Received" },
    { field: "status", label: "Status" },
  ],
});

// ---- Finance -----------------------------------------------------------------

export const LEDGER_ACCOUNT_LIST_VIEW: ListView = listView({
  entity: "LedgerAccount",
  label: "Chart of accounts",
  sortField: "account_code",
  columns: [
    { field: "account_code", label: "Code" },
    { field: "name", label: "Name" },
    { field: "account_type", label: "Type" },
    { field: "status", label: "Status" },
  ],
});

export const JOURNAL_ENTRY_LIST_VIEW: ListView = listView({
  entity: "JournalEntry",
  label: "Journal entries",
  sortField: "entry_date",
  sortDir: "desc",
  columns: [
    { field: "entry_number", label: "Entry #" },
    { field: "entry_date", label: "Date" },
    { field: "source", label: "Source" },
    { field: "state", label: "State" },
  ],
});

export const PAYMENT_LIST_VIEW: ListView = listView({
  entity: "Payment",
  label: "Payments",
  sortField: "paid_at",
  sortDir: "desc",
  columns: [
    { field: "payment_number", label: "Payment #" },
    { field: "direction", label: "Direction" },
    { field: "method", label: "Method" },
    { field: "amount", label: "Amount" },
    { field: "currency", label: "Currency" },
    { field: "state", label: "State" },
  ],
  pageSize: 100,
});

export const EXPENSE_LIST_VIEW: ListView = listView({
  entity: "Expense",
  label: "Expenses",
  sortField: "incurred_on",
  sortDir: "desc",
  columns: [
    { field: "expense_number", label: "Expense #" },
    { field: "employee_id", label: "Employee" },
    { field: "category", label: "Category" },
    { field: "amount", label: "Amount" },
    { field: "state", label: "State" },
    { field: "incurred_on", label: "Incurred" },
  ],
});

export const BILL_LIST_VIEW: ListView = listView({
  entity: "Bill",
  label: "Bills",
  sortField: "due_date",
  columns: [
    { field: "bill_number", label: "Bill #" },
    { field: "vendor_id", label: "Vendor" },
    { field: "bill_date", label: "Bill date" },
    { field: "due_date", label: "Due date" },
    { field: "state", label: "State" },
    { field: "total", label: "Total" },
  ],
  pageSize: 100,
});

// ---- HR / org ----------------------------------------------------------------

export const DEPARTMENT_LIST_VIEW: ListView = listView({
  entity: "Department",
  label: "Departments",
  sortField: "name",
  columns: [
    { field: "dept_code", label: "Code" },
    { field: "name", label: "Name" },
    { field: "cost_center", label: "Cost center" },
    { field: "status", label: "Status" },
  ],
});

export const POSITION_LIST_VIEW: ListView = listView({
  entity: "Position",
  label: "Positions",
  sortField: "title",
  columns: [
    { field: "code", label: "Code" },
    { field: "title", label: "Title" },
    { field: "department_id", label: "Department" },
    { field: "job_grade", label: "Grade" },
    { field: "status", label: "Status" },
  ],
});

export const EMPLOYEE_LIST_VIEW: ListView = listView({
  entity: "Employee",
  label: "Employees",
  sortField: "family_name",
  columns: [
    { field: "employee_number", label: "Emp #" },
    { field: "given_name", label: "First name" },
    { field: "family_name", label: "Last name" },
    { field: "work_email", label: "Work email" },
    { field: "department_id", label: "Department" },
    { field: "status", label: "Status" },
  ],
  pageSize: 100,
});

export const LEAVE_REQUEST_LIST_VIEW: ListView = listView({
  entity: "LeaveRequest",
  label: "Leave requests",
  sortField: "start_date",
  sortDir: "desc",
  columns: [
    { field: "request_number", label: "Request #" },
    { field: "employee_id", label: "Employee" },
    { field: "leave_type", label: "Type" },
    { field: "start_date", label: "Start" },
    { field: "end_date", label: "End" },
    { field: "state", label: "State" },
  ],
});

export const ERP_CORE_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "account.list": ACCOUNT_LIST_VIEW,
  "invoice.list": INVOICE_LIST_VIEW,
  "item.list": ITEM_LIST_VIEW,
  "warehouse.list": WAREHOUSE_LIST_VIEW,
  "stock_level.list": STOCK_LEVEL_LIST_VIEW,
  "vendor.list": VENDOR_LIST_VIEW,
  "purchase_order.list": PURCHASE_ORDER_LIST_VIEW,
  "goods_receipt.list": GOODS_RECEIPT_LIST_VIEW,
  "ledger_account.list": LEDGER_ACCOUNT_LIST_VIEW,
  "journal_entry.list": JOURNAL_ENTRY_LIST_VIEW,
  "payment.list": PAYMENT_LIST_VIEW,
  "expense.list": EXPENSE_LIST_VIEW,
  "bill.list": BILL_LIST_VIEW,
  "department.list": DEPARTMENT_LIST_VIEW,
  "position.list": POSITION_LIST_VIEW,
  "employee.list": EMPLOYEE_LIST_VIEW,
  "leave_request.list": LEAVE_REQUEST_LIST_VIEW,
};
