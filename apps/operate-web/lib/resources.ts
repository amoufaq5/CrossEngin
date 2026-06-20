// Hand-authored per-entity resource definitions. The shared <ResourcePage>
// component renders any of these as a productive list + create + delete screen.
// Field/column choices are authored per entity; the chrome is shared.

export type FieldType =
  | "text"
  | "number"
  | "email"
  | "date"
  | "datetime"
  | "textarea"
  | "select"
  | "boolean";

export interface FieldDef {
  readonly name: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly options?: readonly string[];
  readonly placeholder?: string;
}

export type ColumnKind = "text" | "badge" | "money" | "date" | "email";

export interface ColumnDef {
  readonly key: string;
  readonly label: string;
  readonly kind?: ColumnKind;
}

export type DomainKey = "crm" | "inventory" | "procurement" | "finance" | "hr";

export interface ResourceConfig {
  readonly domain: DomainKey;
  readonly entity: string;
  readonly slug: string; // kebab-plural, matches the operate-server route + the URL segment
  readonly title: string;
  readonly singular: string;
  readonly columns: readonly ColumnDef[];
  readonly fields: readonly FieldDef[];
}

/** Mirrors operate-runtime resourceSlug: PascalCase -> kebab + "s". */
export function resourceSlug(entity: string): string {
  return `${entity.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}s`;
}

function r(c: Omit<ResourceConfig, "slug">): ResourceConfig {
  return { ...c, slug: resourceSlug(c.entity) };
}

const CURRENCY: FieldDef = { name: "currency", label: "Currency", type: "text", placeholder: "USD" };

export const RESOURCES: readonly ResourceConfig[] = [
  // ---- CRM -------------------------------------------------------------------
  r({
    domain: "crm",
    entity: "Account",
    title: "Accounts",
    singular: "account",
    columns: [
      { key: "name", label: "Name" },
      { key: "status", label: "Status", kind: "badge" },
      { key: "industry", label: "Industry" },
      { key: "billing_email", label: "Billing email", kind: "email" },
      { key: "country", label: "Country" },
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "legal_name", label: "Legal name", type: "text" },
      { name: "status", label: "Status", type: "select", required: true, options: ["prospect", "active", "suspended", "churned"] },
      { name: "industry", label: "Industry", type: "text" },
      { name: "billing_email", label: "Billing email", type: "email", required: true },
      { name: "website", label: "Website", type: "text" },
      { name: "country", label: "Country", type: "text", placeholder: "US" },
    ],
  }),
  r({
    domain: "crm",
    entity: "Contact",
    title: "Contacts",
    singular: "contact",
    columns: [
      { key: "given_name", label: "First name" },
      { key: "family_name", label: "Last name" },
      { key: "email", label: "Email", kind: "email" },
      { key: "title", label: "Title" },
      { key: "account_id", label: "Account" },
    ],
    fields: [
      { name: "account_id", label: "Account ID", type: "text", required: true },
      { name: "given_name", label: "First name", type: "text", required: true },
      { name: "family_name", label: "Last name", type: "text", required: true },
      { name: "title", label: "Title", type: "text" },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "phone", label: "Phone", type: "text" },
      { name: "is_primary", label: "Primary contact", type: "boolean" },
    ],
  }),
  r({
    domain: "crm",
    entity: "Invoice",
    title: "Invoices",
    singular: "invoice",
    columns: [
      { key: "invoice_number", label: "Number" },
      { key: "account_id", label: "Account" },
      { key: "state", label: "State", kind: "badge" },
      { key: "total", label: "Total", kind: "money" },
      { key: "currency", label: "Cur." },
      { key: "due_date", label: "Due", kind: "date" },
    ],
    fields: [
      { name: "account_id", label: "Account ID", type: "text", required: true },
      { name: "invoice_number", label: "Invoice number", type: "text", required: true },
      { name: "state", label: "State", type: "select", required: true, options: ["draft", "sent", "paid", "overdue", "void"] },
      { name: "total", label: "Total", type: "number", required: true },
      CURRENCY,
      { name: "due_date", label: "Due date", type: "date" },
    ],
  }),

  // ---- Inventory -------------------------------------------------------------
  r({
    domain: "inventory",
    entity: "Item",
    title: "Items",
    singular: "item",
    columns: [
      { key: "sku", label: "SKU" },
      { key: "name", label: "Name" },
      { key: "item_type", label: "Type", kind: "badge" },
      { key: "category", label: "Category" },
      { key: "list_price", label: "List price", kind: "money" },
      { key: "status", label: "Status", kind: "badge" },
    ],
    fields: [
      { name: "sku", label: "SKU", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "description", label: "Description", type: "textarea" },
      { name: "item_type", label: "Type", type: "select", required: true, options: ["stock", "service", "kit", "raw_material", "finished_good", "consumable"] },
      { name: "unit_of_measure", label: "Unit", type: "select", required: true, options: ["each", "kg", "g", "l", "ml", "m", "cm", "box", "pallet", "hour"] },
      { name: "category", label: "Category", type: "text" },
      { name: "list_price", label: "List price", type: "number" },
      { name: "standard_cost", label: "Standard cost", type: "number" },
      CURRENCY,
      { name: "status", label: "Status", type: "select", required: true, options: ["draft", "active", "discontinued"] },
    ],
  }),
  r({
    domain: "inventory",
    entity: "Warehouse",
    title: "Warehouses",
    singular: "warehouse",
    columns: [
      { key: "code", label: "Code" },
      { key: "name", label: "Name" },
      { key: "warehouse_type", label: "Type", kind: "badge" },
      { key: "city", label: "City" },
      { key: "status", label: "Status", kind: "badge" },
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "warehouse_type", label: "Type", type: "select", required: true, options: ["distribution", "retail", "transit", "manufacturing", "virtual"] },
      { name: "address_line1", label: "Address", type: "text" },
      { name: "city", label: "City", type: "text" },
      { name: "country", label: "Country", type: "text" },
      { name: "status", label: "Status", type: "select", required: true, options: ["active", "inactive", "closed"] },
    ],
  }),
  r({
    domain: "inventory",
    entity: "StockLevel",
    title: "Stock levels",
    singular: "stock level",
    columns: [
      { key: "item_id", label: "Item" },
      { key: "warehouse_id", label: "Warehouse" },
      { key: "quantity_on_hand", label: "On hand" },
      { key: "quantity_reserved", label: "Reserved" },
      { key: "quantity_incoming", label: "Incoming" },
      { key: "bin_location", label: "Bin" },
    ],
    fields: [
      { name: "item_id", label: "Item ID", type: "text", required: true },
      { name: "warehouse_id", label: "Warehouse ID", type: "text", required: true },
      { name: "quantity_on_hand", label: "On hand", type: "number", required: true },
      { name: "quantity_reserved", label: "Reserved", type: "number", required: true },
      { name: "quantity_incoming", label: "Incoming", type: "number", required: true },
      { name: "bin_location", label: "Bin location", type: "text" },
    ],
  }),
  r({
    domain: "inventory",
    entity: "StockMovement",
    title: "Stock movements",
    singular: "stock movement",
    columns: [
      { key: "item_id", label: "Item" },
      { key: "warehouse_id", label: "Warehouse" },
      { key: "movement_type", label: "Type", kind: "badge" },
      { key: "quantity", label: "Qty" },
      { key: "occurred_at", label: "When", kind: "date" },
    ],
    fields: [
      { name: "item_id", label: "Item ID", type: "text", required: true },
      { name: "warehouse_id", label: "Warehouse ID", type: "text", required: true },
      { name: "movement_type", label: "Type", type: "select", required: true, options: ["receipt", "issue", "transfer_in", "transfer_out", "adjustment", "return"] },
      { name: "quantity", label: "Quantity", type: "number", required: true },
      { name: "reference", label: "Reference", type: "text" },
      { name: "reason", label: "Reason", type: "text" },
      { name: "occurred_at", label: "Occurred at", type: "datetime", required: true },
    ],
  }),

  // ---- Procurement -----------------------------------------------------------
  r({
    domain: "procurement",
    entity: "Vendor",
    title: "Vendors",
    singular: "vendor",
    columns: [
      { key: "vendor_code", label: "Code" },
      { key: "name", label: "Name" },
      { key: "status", label: "Status", kind: "badge" },
      { key: "payment_terms", label: "Terms", kind: "badge" },
      { key: "country", label: "Country" },
    ],
    fields: [
      { name: "vendor_code", label: "Vendor code", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "legal_name", label: "Legal name", type: "text" },
      { name: "contact_email", label: "Contact email", type: "email" },
      { name: "country", label: "Country", type: "text" },
      { name: "payment_terms", label: "Payment terms", type: "select", required: true, options: ["net_15", "net_30", "net_45", "net_60", "due_on_receipt", "prepaid"] },
      CURRENCY,
      { name: "status", label: "Status", type: "select", required: true, options: ["prospect", "active", "on_hold", "blacklisted", "inactive"] },
    ],
  }),
  r({
    domain: "procurement",
    entity: "PurchaseOrder",
    title: "Purchase orders",
    singular: "purchase order",
    columns: [
      { key: "po_number", label: "PO #" },
      { key: "vendor_id", label: "Vendor" },
      { key: "state", label: "State", kind: "badge" },
      { key: "order_date", label: "Ordered", kind: "date" },
      { key: "total", label: "Total", kind: "money" },
    ],
    fields: [
      { name: "po_number", label: "PO number", type: "text", required: true },
      { name: "vendor_id", label: "Vendor ID", type: "text", required: true },
      { name: "warehouse_id", label: "Warehouse ID", type: "text" },
      { name: "state", label: "State", type: "select", required: true, options: ["draft", "submitted", "approved", "received", "closed", "cancelled"] },
      { name: "order_date", label: "Order date", type: "date", required: true },
      { name: "expected_date", label: "Expected date", type: "date" },
      { name: "total", label: "Total", type: "number", required: true },
      CURRENCY,
      { name: "notes", label: "Notes", type: "textarea" },
    ],
  }),
  r({
    domain: "procurement",
    entity: "GoodsReceipt",
    title: "Goods receipts",
    singular: "goods receipt",
    columns: [
      { key: "grn_number", label: "GRN #" },
      { key: "purchase_order_id", label: "PO" },
      { key: "warehouse_id", label: "Warehouse" },
      { key: "received_date", label: "Received", kind: "date" },
      { key: "status", label: "Status", kind: "badge" },
    ],
    fields: [
      { name: "grn_number", label: "GRN number", type: "text", required: true },
      { name: "purchase_order_id", label: "Purchase order ID", type: "text", required: true },
      { name: "warehouse_id", label: "Warehouse ID", type: "text", required: true },
      { name: "received_date", label: "Received date", type: "date", required: true },
      { name: "received_by", label: "Received by", type: "text" },
      { name: "status", label: "Status", type: "select", required: true, options: ["draft", "posted", "cancelled"] },
      { name: "notes", label: "Notes", type: "textarea" },
    ],
  }),

  // ---- Finance ---------------------------------------------------------------
  r({
    domain: "finance",
    entity: "LedgerAccount",
    title: "Chart of accounts",
    singular: "ledger account",
    columns: [
      { key: "account_code", label: "Code" },
      { key: "name", label: "Name" },
      { key: "account_type", label: "Type", kind: "badge" },
      { key: "status", label: "Status", kind: "badge" },
    ],
    fields: [
      { name: "account_code", label: "Account code", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "account_type", label: "Type", type: "select", required: true, options: ["asset", "liability", "equity", "revenue", "expense"] },
      CURRENCY,
      { name: "is_postable", label: "Postable", type: "boolean" },
      { name: "status", label: "Status", type: "select", required: true, options: ["active", "archived"] },
    ],
  }),
  r({
    domain: "finance",
    entity: "JournalEntry",
    title: "Journal entries",
    singular: "journal entry",
    columns: [
      { key: "entry_number", label: "Entry #" },
      { key: "entry_date", label: "Date", kind: "date" },
      { key: "source", label: "Source", kind: "badge" },
      { key: "state", label: "State", kind: "badge" },
    ],
    fields: [
      { name: "entry_number", label: "Entry number", type: "text", required: true },
      { name: "entry_date", label: "Entry date", type: "date", required: true },
      { name: "source", label: "Source", type: "select", required: true, options: ["manual", "invoice", "bill", "payment", "payroll", "system"] },
      { name: "state", label: "State", type: "select", required: true, options: ["draft", "posted", "reversed"] },
      { name: "memo", label: "Memo", type: "textarea" },
    ],
  }),
  r({
    domain: "finance",
    entity: "Payment",
    title: "Payments",
    singular: "payment",
    columns: [
      { key: "payment_number", label: "Payment #" },
      { key: "direction", label: "Direction", kind: "badge" },
      { key: "method", label: "Method", kind: "badge" },
      { key: "amount", label: "Amount", kind: "money" },
      { key: "state", label: "State", kind: "badge" },
    ],
    fields: [
      { name: "payment_number", label: "Payment number", type: "text", required: true },
      { name: "direction", label: "Direction", type: "select", required: true, options: ["inbound", "outbound"] },
      { name: "method", label: "Method", type: "select", required: true, options: ["bank_transfer", "card", "cash", "cheque", "ach", "wire"] },
      { name: "account_id", label: "Account ID", type: "text" },
      { name: "amount", label: "Amount", type: "number", required: true },
      CURRENCY,
      { name: "state", label: "State", type: "select", required: true, options: ["draft", "pending", "completed", "failed", "refunded"] },
      { name: "reference", label: "Reference", type: "text" },
    ],
  }),
  r({
    domain: "finance",
    entity: "Expense",
    title: "Expenses",
    singular: "expense",
    columns: [
      { key: "expense_number", label: "Expense #" },
      { key: "employee_id", label: "Employee" },
      { key: "category", label: "Category", kind: "badge" },
      { key: "amount", label: "Amount", kind: "money" },
      { key: "state", label: "State", kind: "badge" },
      { key: "incurred_on", label: "Incurred", kind: "date" },
    ],
    fields: [
      { name: "expense_number", label: "Expense number", type: "text", required: true },
      { name: "employee_id", label: "Employee ID", type: "text", required: true },
      { name: "category", label: "Category", type: "select", required: true, options: ["travel", "meals", "lodging", "supplies", "software", "training", "other"] },
      { name: "amount", label: "Amount", type: "number", required: true },
      CURRENCY,
      { name: "state", label: "State", type: "select", required: true, options: ["draft", "submitted", "approved", "reimbursed", "rejected"] },
      { name: "incurred_on", label: "Incurred on", type: "date", required: true },
      { name: "description", label: "Description", type: "textarea" },
    ],
  }),
  r({
    domain: "finance",
    entity: "Bill",
    title: "Bills",
    singular: "bill",
    columns: [
      { key: "bill_number", label: "Bill #" },
      { key: "vendor_id", label: "Vendor" },
      { key: "bill_date", label: "Billed", kind: "date" },
      { key: "due_date", label: "Due", kind: "date" },
      { key: "state", label: "State", kind: "badge" },
      { key: "total", label: "Total", kind: "money" },
    ],
    fields: [
      { name: "bill_number", label: "Bill number", type: "text", required: true },
      { name: "vendor_id", label: "Vendor ID", type: "text", required: true },
      { name: "purchase_order_id", label: "Purchase order ID", type: "text" },
      { name: "bill_date", label: "Bill date", type: "date", required: true },
      { name: "due_date", label: "Due date", type: "date", required: true },
      { name: "state", label: "State", type: "select", required: true, options: ["draft", "approved", "paid", "overdue", "void"] },
      { name: "total", label: "Total", type: "number", required: true },
      CURRENCY,
    ],
  }),

  // ---- HR / org --------------------------------------------------------------
  r({
    domain: "hr",
    entity: "Department",
    title: "Departments",
    singular: "department",
    columns: [
      { key: "dept_code", label: "Code" },
      { key: "name", label: "Name" },
      { key: "cost_center", label: "Cost center" },
      { key: "status", label: "Status", kind: "badge" },
    ],
    fields: [
      { name: "dept_code", label: "Department code", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "parent_department_id", label: "Parent department ID", type: "text" },
      { name: "manager_id", label: "Manager (employee ID)", type: "text" },
      { name: "cost_center", label: "Cost center", type: "text" },
      { name: "status", label: "Status", type: "select", required: true, options: ["active", "inactive"] },
    ],
  }),
  r({
    domain: "hr",
    entity: "Position",
    title: "Positions",
    singular: "position",
    columns: [
      { key: "code", label: "Code" },
      { key: "title", label: "Title" },
      { key: "department_id", label: "Department" },
      { key: "job_grade", label: "Grade", kind: "badge" },
      { key: "status", label: "Status", kind: "badge" },
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "department_id", label: "Department ID", type: "text", required: true },
      { name: "job_grade", label: "Job grade", type: "select", required: true, options: ["intern", "junior", "mid", "senior", "lead", "manager", "director", "executive"] },
      { name: "headcount", label: "Headcount", type: "number", required: true },
      { name: "status", label: "Status", type: "select", required: true, options: ["open", "filled", "frozen", "closed"] },
    ],
  }),
  r({
    domain: "hr",
    entity: "Employee",
    title: "Employees",
    singular: "employee",
    columns: [
      { key: "employee_number", label: "Emp #" },
      { key: "given_name", label: "First name" },
      { key: "family_name", label: "Last name" },
      { key: "work_email", label: "Work email", kind: "email" },
      { key: "department_id", label: "Department" },
      { key: "status", label: "Status", kind: "badge" },
    ],
    fields: [
      { name: "employee_number", label: "Employee number", type: "text", required: true },
      { name: "given_name", label: "First name", type: "text", required: true },
      { name: "family_name", label: "Last name", type: "text", required: true },
      { name: "work_email", label: "Work email", type: "email", required: true },
      { name: "personal_email", label: "Personal email", type: "email" },
      { name: "phone", label: "Phone", type: "text" },
      { name: "department_id", label: "Department ID", type: "text" },
      { name: "position_id", label: "Position ID", type: "text" },
      { name: "manager_id", label: "Manager (employee ID)", type: "text" },
      { name: "hire_date", label: "Hire date", type: "date", required: true },
      { name: "employment_type", label: "Employment type", type: "select", required: true, options: ["full_time", "part_time", "contractor", "intern", "temporary"] },
      { name: "status", label: "Status", type: "select", required: true, options: ["active", "on_leave", "suspended", "terminated"] },
      CURRENCY,
    ],
  }),
  r({
    domain: "hr",
    entity: "LeaveRequest",
    title: "Leave requests",
    singular: "leave request",
    columns: [
      { key: "request_number", label: "Request #" },
      { key: "employee_id", label: "Employee" },
      { key: "leave_type", label: "Type", kind: "badge" },
      { key: "start_date", label: "Start", kind: "date" },
      { key: "end_date", label: "End", kind: "date" },
      { key: "state", label: "State", kind: "badge" },
    ],
    fields: [
      { name: "request_number", label: "Request number", type: "text", required: true },
      { name: "employee_id", label: "Employee ID", type: "text", required: true },
      { name: "leave_type", label: "Leave type", type: "select", required: true, options: ["annual", "sick", "unpaid", "parental", "bereavement", "study"] },
      { name: "start_date", label: "Start date", type: "date", required: true },
      { name: "end_date", label: "End date", type: "date", required: true },
      { name: "days", label: "Days", type: "number", required: true },
      { name: "state", label: "State", type: "select", required: true, options: ["draft", "submitted", "approved", "rejected", "cancelled"] },
      { name: "reason", label: "Reason", type: "textarea" },
    ],
  }),
];

export function findResource(domain: string, slug: string): ResourceConfig | undefined {
  return RESOURCES.find((res) => res.domain === domain && res.slug === slug);
}

export function resourcesByDomain(domain: DomainKey): readonly ResourceConfig[] {
  return RESOURCES.filter((res) => res.domain === domain);
}
