import type { Relation } from "@crossengin/types/meta-schema";

type OnDelete = "restrict" | "cascade" | "set_null";

function m2o(from: string, field: string, to: string, onDelete: OnDelete): Relation {
  return { kind: "many_to_one", from, field, to, onDelete };
}

export const ERP_EXT_RELATIONS: readonly Relation[] = [
  // Sales
  m2o("Lead", "owner_id", "Employee", "set_null"),
  m2o("Opportunity", "account_id", "Account", "restrict"),
  m2o("Opportunity", "owner_id", "Employee", "set_null"),
  m2o("Quote", "account_id", "Account", "restrict"),
  m2o("Quote", "opportunity_id", "Opportunity", "set_null"),
  m2o("QuoteLine", "quote_id", "Quote", "cascade"),
  m2o("QuoteLine", "item_id", "Item", "restrict"),
  m2o("SalesOrder", "account_id", "Account", "restrict"),
  m2o("SalesOrder", "quote_id", "Quote", "set_null"),
  m2o("SalesOrderLine", "sales_order_id", "SalesOrder", "cascade"),
  m2o("SalesOrderLine", "item_id", "Item", "restrict"),
  m2o("Shipment", "sales_order_id", "SalesOrder", "cascade"),
  m2o("Shipment", "warehouse_id", "Warehouse", "set_null"),
  // Manufacturing
  m2o("BillOfMaterials", "item_id", "Item", "restrict"),
  m2o("BomLine", "bom_id", "BillOfMaterials", "cascade"),
  m2o("BomLine", "component_item_id", "Item", "restrict"),
  m2o("WorkOrder", "item_id", "Item", "restrict"),
  m2o("WorkOrder", "bom_id", "BillOfMaterials", "set_null"),
  m2o("WorkOrder", "warehouse_id", "Warehouse", "set_null"),
  // Projects
  m2o("Project", "account_id", "Account", "set_null"),
  m2o("Project", "manager_id", "Employee", "set_null"),
  m2o("ProjectTask", "project_id", "Project", "cascade"),
  m2o("ProjectTask", "assignee_id", "Employee", "set_null"),
  m2o("Timesheet", "employee_id", "Employee", "restrict"),
  m2o("Timesheet", "project_id", "Project", "set_null"),
  m2o("Timesheet", "project_task_id", "ProjectTask", "set_null"),
  // Assets
  m2o("FixedAsset", "ledger_account_id", "LedgerAccount", "set_null"),
  m2o("MaintenanceOrder", "fixed_asset_id", "FixedAsset", "cascade"),
  m2o("MaintenanceOrder", "assignee_id", "Employee", "set_null"),
  // Pricing
  m2o("PriceListItem", "price_list_id", "PriceList", "cascade"),
  m2o("PriceListItem", "item_id", "Item", "restrict"),
  // Accounting depth — multi-currency
  m2o("ExchangeRate", "from_currency_id", "Currency", "restrict"),
  m2o("ExchangeRate", "to_currency_id", "Currency", "restrict"),
  // Fiscal calendar
  m2o("FiscalPeriod", "fiscal_year_id", "FiscalYear", "cascade"),
  // Dimensions (cost centers form a hierarchy)
  m2o("CostCenter", "parent_id", "CostCenter", "set_null"),
  m2o("CostCenter", "manager_id", "Employee", "set_null"),
  // GL postings → book / period / cost center (IFRS parallel books)
  m2o("JournalEntry", "book_id", "AccountingBook", "set_null"),
  m2o("JournalEntry", "fiscal_period_id", "FiscalPeriod", "restrict"),
  m2o("JournalLine", "cost_center_id", "CostCenter", "set_null"),
  // Country tax rules + filing
  m2o("TaxRule", "jurisdiction_id", "TaxJurisdiction", "cascade"),
  m2o("TaxRule", "tax_code_id", "TaxCode", "restrict"),
  m2o("TaxReturn", "jurisdiction_id", "TaxJurisdiction", "restrict"),
  m2o("TaxReturn", "fiscal_period_id", "FiscalPeriod", "restrict"),
];
