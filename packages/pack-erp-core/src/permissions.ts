import type { EntityPermissions } from "@crossengin/auth";

// ---- CRM (original — unchanged) ---------------------------------------------

const ALL_ROLES = ["erp_admin", "erp_accountant", "erp_viewer"];
const WRITE_ROLES = ["erp_admin", "erp_accountant"];
const ADMIN_ONLY = ["erp_admin"];

export const ACCOUNT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: WRITE_ROLES },
  update: { roles: WRITE_ROLES },
  delete: { roles: ADMIN_ONLY },
};

export const CONTACT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: WRITE_ROLES },
  update: { roles: WRITE_ROLES },
  delete: { roles: ADMIN_ONLY },
};

export const INVOICE_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: WRITE_ROLES },
  update: { roles: WRITE_ROLES },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    send: { roles: WRITE_ROLES },
    mark_paid: { roles: WRITE_ROLES },
    mark_overdue: { roles: WRITE_ROLES },
    void: { roles: ADMIN_ONLY },
  },
};

export const INVOICE_LINE_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: WRITE_ROLES },
  update: { roles: WRITE_ROLES },
  delete: { roles: WRITE_ROLES },
};

// ---- Inventory ---------------------------------------------------------------

const INV_READERS = ["erp_admin", "erp_viewer", "inventory_manager", "warehouse_clerk", "procurement_manager"];
const INV_WRITERS = ["erp_admin", "inventory_manager"];
const STOCK_WRITERS = ["erp_admin", "inventory_manager", "warehouse_clerk"];

export const ITEM_PERMISSIONS: EntityPermissions = {
  list: { roles: INV_READERS },
  read: { roles: INV_READERS },
  create: { roles: INV_WRITERS },
  update: { roles: INV_WRITERS },
  delete: { roles: ADMIN_ONLY },
  fields: {
    // Procurement negotiates against the cost and so reads it; the warehouse clerk counting
    // stock has no use for it, and `erp_viewer` is the general observer this pack grants least.
    standard_cost: {
      read: { roles: ["erp_admin", "inventory_manager", "procurement_manager"] },
      update: { roles: INV_WRITERS },
    },
  },
};

export const WAREHOUSE_PERMISSIONS: EntityPermissions = {
  list: { roles: INV_READERS },
  read: { roles: INV_READERS },
  create: { roles: INV_WRITERS },
  update: { roles: INV_WRITERS },
  delete: { roles: ADMIN_ONLY },
};

export const STOCK_LEVEL_PERMISSIONS: EntityPermissions = {
  list: { roles: INV_READERS },
  read: { roles: INV_READERS },
  create: { roles: STOCK_WRITERS },
  update: { roles: STOCK_WRITERS },
  delete: { roles: ADMIN_ONLY },
};

export const STOCK_MOVEMENT_PERMISSIONS: EntityPermissions = {
  list: { roles: INV_READERS },
  read: { roles: INV_READERS },
  create: { roles: STOCK_WRITERS },
  update: { roles: STOCK_WRITERS },
  delete: { roles: ADMIN_ONLY },
};

// ---- Procurement -------------------------------------------------------------

const PROC_READERS = ["erp_admin", "erp_viewer", "procurement_manager", "ap_clerk", "inventory_manager"];
const PROC_WRITERS = ["erp_admin", "procurement_manager"];
const VENDOR_WRITERS = ["erp_admin", "procurement_manager", "ap_clerk"];

export const VENDOR_PERMISSIONS: EntityPermissions = {
  list: { roles: PROC_READERS },
  read: { roles: PROC_READERS },
  create: { roles: VENDOR_WRITERS },
  update: { roles: VENDOR_WRITERS },
  delete: { roles: ADMIN_ONLY },
  fields: {
    // `inventory_manager` reads a vendor to know who supplies an item and `erp_viewer` to see
    // the master list; neither needs the tax identity or a named person's contact details.
    // AP owns the tax id it files against — procurement may read it to negotiate but a
    // correction is a finance act, not a commercial one.
    tax_id: {
      read: { roles: VENDOR_WRITERS },
      update: { roles: ["erp_admin", "ap_clerk"] },
    },
    contact_email: { read: { roles: VENDOR_WRITERS }, update: { roles: VENDOR_WRITERS } },
    contact_phone: { read: { roles: VENDOR_WRITERS }, update: { roles: VENDOR_WRITERS } },
  },
};

export const PURCHASE_ORDER_PERMISSIONS: EntityPermissions = {
  list: { roles: PROC_READERS },
  read: { roles: PROC_READERS },
  create: { roles: PROC_WRITERS },
  update: { roles: PROC_WRITERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    submit: { roles: PROC_WRITERS },
    approve: { roles: PROC_WRITERS },
    receive: { roles: ["erp_admin", "procurement_manager", "warehouse_clerk"] },
    close: { roles: PROC_WRITERS },
    cancel: { roles: PROC_WRITERS },
  },
};

export const PURCHASE_ORDER_LINE_PERMISSIONS: EntityPermissions = {
  list: { roles: PROC_READERS },
  read: { roles: PROC_READERS },
  create: { roles: PROC_WRITERS },
  update: { roles: PROC_WRITERS },
  delete: { roles: PROC_WRITERS },
};

export const GOODS_RECEIPT_PERMISSIONS: EntityPermissions = {
  list: { roles: PROC_READERS },
  read: { roles: PROC_READERS },
  create: { roles: ["erp_admin", "procurement_manager", "warehouse_clerk"] },
  update: { roles: ["erp_admin", "procurement_manager", "warehouse_clerk"] },
  delete: { roles: ADMIN_ONLY },
};

// ---- Finance -----------------------------------------------------------------

const FIN_READERS = ["erp_admin", "erp_viewer", "controller", "erp_accountant", "ap_clerk"];
const GL_WRITERS = ["erp_admin", "controller"];
const AP_WRITERS = ["erp_admin", "ap_clerk"];
const PAY_WRITERS = ["erp_admin", "ap_clerk", "erp_accountant"];

export const LEDGER_ACCOUNT_PERMISSIONS: EntityPermissions = {
  list: { roles: FIN_READERS },
  read: { roles: FIN_READERS },
  create: { roles: GL_WRITERS },
  update: { roles: GL_WRITERS },
  delete: { roles: ADMIN_ONLY },
};

export const JOURNAL_ENTRY_PERMISSIONS: EntityPermissions = {
  list: { roles: FIN_READERS },
  read: { roles: FIN_READERS },
  create: { roles: GL_WRITERS },
  update: { roles: GL_WRITERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    post: { roles: GL_WRITERS },
    reverse: { roles: GL_WRITERS },
  },
};

export const JOURNAL_LINE_PERMISSIONS: EntityPermissions = {
  list: { roles: FIN_READERS },
  read: { roles: FIN_READERS },
  create: { roles: GL_WRITERS },
  update: { roles: GL_WRITERS },
  delete: { roles: GL_WRITERS },
};

export const PAYMENT_PERMISSIONS: EntityPermissions = {
  list: { roles: FIN_READERS },
  read: { roles: FIN_READERS },
  create: { roles: PAY_WRITERS },
  update: { roles: PAY_WRITERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    submit: { roles: PAY_WRITERS },
    complete: { roles: PAY_WRITERS },
    fail: { roles: ADMIN_ONLY },
    refund: { roles: ["erp_admin", "ap_clerk", "controller"] },
  },
  fields: {
    // The controller reconciles the bank statement against this and so reads it without
    // writing it; `erp_viewer` sees the payment, not the counterparty's bank handle.
    bank_reference: {
      read: { roles: ["erp_admin", "controller", "erp_accountant", "ap_clerk"] },
      update: { roles: PAY_WRITERS },
    },
  },
};

export const EXPENSE_PERMISSIONS: EntityPermissions = {
  list: { roles: ["erp_admin", "erp_viewer", "erp_accountant", "hr_manager", "ap_clerk"] },
  read: { roles: ["erp_admin", "erp_viewer", "erp_accountant", "hr_manager", "ap_clerk"] },
  create: { roles: ["erp_admin", "erp_accountant", "hr_manager"] },
  update: { roles: ["erp_admin", "erp_accountant", "hr_manager"] },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    submit: { roles: ["erp_admin", "erp_accountant", "hr_manager"] },
    approve: { roles: ["erp_admin", "hr_manager", "controller"] },
    reimburse: { roles: ["erp_admin", "ap_clerk", "erp_accountant"] },
    reject: { roles: ["erp_admin", "hr_manager", "controller"] },
  },
};

export const BILL_PERMISSIONS: EntityPermissions = {
  list: { roles: FIN_READERS },
  read: { roles: FIN_READERS },
  create: { roles: AP_WRITERS },
  update: { roles: AP_WRITERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    approve: { roles: ["erp_admin", "ap_clerk", "controller"] },
    mark_overdue: { roles: ADMIN_ONLY },
    mark_paid: { roles: AP_WRITERS },
    void: { roles: ["erp_admin", "controller"] },
  },
};

export const BILL_LINE_PERMISSIONS: EntityPermissions = {
  list: { roles: FIN_READERS },
  read: { roles: FIN_READERS },
  create: { roles: AP_WRITERS },
  update: { roles: AP_WRITERS },
  delete: { roles: AP_WRITERS },
};

// ---- HR / org ----------------------------------------------------------------

const HR_READERS = ["erp_admin", "erp_viewer", "hr_manager"];
const HR_WRITERS = ["erp_admin", "hr_manager"];

export const DEPARTMENT_PERMISSIONS: EntityPermissions = {
  list: { roles: HR_READERS },
  read: { roles: HR_READERS },
  create: { roles: HR_WRITERS },
  update: { roles: HR_WRITERS },
  delete: { roles: ADMIN_ONLY },
};

export const POSITION_PERMISSIONS: EntityPermissions = {
  list: { roles: HR_READERS },
  read: { roles: HR_READERS },
  create: { roles: HR_WRITERS },
  update: { roles: HR_WRITERS },
  delete: { roles: ADMIN_ONLY },
};

export const EMPLOYEE_PERMISSIONS: EntityPermissions = {
  list: { roles: HR_READERS },
  read: { roles: HR_READERS },
  create: { roles: HR_WRITERS },
  update: { roles: HR_WRITERS },
  delete: { roles: ADMIN_ONLY },
  fields: {
    // The employee record is readable by `erp_viewer` for the org chart — the directory entry,
    // the reporting line, the position. None of the personal or pay fields are part of that, so
    // every arm below is HR and the admin, which is `HR_WRITERS` read as a population.
    work_email: { read: { roles: HR_WRITERS }, update: { roles: HR_WRITERS } },
    personal_email: { read: { roles: HR_WRITERS }, update: { roles: HR_WRITERS } },
    phone: { read: { roles: HR_WRITERS }, update: { roles: HR_WRITERS } },
    // Set once: HR records the national id at hire and only the admin corrects it afterwards,
    // which is the distinction the `create` arm exists for — narrowing `update` alone would
    // have taken hiring away from HR.
    national_id: {
      read: { roles: HR_WRITERS },
      update: { roles: ADMIN_ONLY },
      create: { roles: HR_WRITERS },
    },
    date_of_birth: { read: { roles: HR_WRITERS }, update: { roles: HR_WRITERS } },
    annual_salary: { read: { roles: HR_WRITERS }, update: { roles: HR_WRITERS } },
  },
};

export const LEAVE_REQUEST_PERMISSIONS: EntityPermissions = {
  list: { roles: HR_READERS },
  read: { roles: HR_READERS },
  create: { roles: HR_WRITERS },
  update: { roles: HR_WRITERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    submit: { roles: HR_WRITERS },
    approve: { roles: HR_WRITERS },
    reject: { roles: HR_WRITERS },
    cancel: { roles: HR_WRITERS },
  },
};

export const ERP_CORE_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  // CRM
  Account: ACCOUNT_PERMISSIONS,
  Contact: CONTACT_PERMISSIONS,
  Invoice: INVOICE_PERMISSIONS,
  InvoiceLine: INVOICE_LINE_PERMISSIONS,
  // Inventory
  Item: ITEM_PERMISSIONS,
  Warehouse: WAREHOUSE_PERMISSIONS,
  StockLevel: STOCK_LEVEL_PERMISSIONS,
  StockMovement: STOCK_MOVEMENT_PERMISSIONS,
  // Procurement
  Vendor: VENDOR_PERMISSIONS,
  PurchaseOrder: PURCHASE_ORDER_PERMISSIONS,
  PurchaseOrderLine: PURCHASE_ORDER_LINE_PERMISSIONS,
  GoodsReceipt: GOODS_RECEIPT_PERMISSIONS,
  // Finance
  LedgerAccount: LEDGER_ACCOUNT_PERMISSIONS,
  JournalEntry: JOURNAL_ENTRY_PERMISSIONS,
  JournalLine: JOURNAL_LINE_PERMISSIONS,
  Payment: PAYMENT_PERMISSIONS,
  Expense: EXPENSE_PERMISSIONS,
  Bill: BILL_PERMISSIONS,
  BillLine: BILL_LINE_PERMISSIONS,
  // HR / org
  Department: DEPARTMENT_PERMISSIONS,
  Position: POSITION_PERMISSIONS,
  Employee: EMPLOYEE_PERMISSIONS,
  LeaveRequest: LEAVE_REQUEST_PERMISSIONS,
};
