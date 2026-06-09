import {
  CalendarViewSchema,
  DashboardViewSchema,
  KanbanViewSchema,
  ListViewSchema,
  MapViewSchema,
  PivotViewSchema,
  type ListView,
  type ViewDeclaration,
} from "@crossengin/views";

export const PRODUCT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Product",
  label: { en: "Products" },
  permissions: "inherit",
  sort: [{ field: "name", direction: "asc" }],
  columns: [
    { field: "sku", label: { en: "SKU" } },
    { field: "name", label: { en: "Name" } },
    { field: "category", label: { en: "Category" } },
    { field: "unit_price", label: { en: "Price" } },
    { field: "status", label: { en: "Status" } },
  ],
  pageSize: 100,
  exportFormats: ["csv", "xlsx"],
});

export const SALES_ORDER_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "SalesOrder",
  label: { en: "Sales orders" },
  permissions: "inherit",
  sort: [{ field: "placed_at", direction: "desc" }],
  columns: [
    { field: "order_number", label: { en: "Number" } },
    { field: "store_id", label: { en: "Store" } },
    { field: "state", label: { en: "State" } },
    { field: "channel", label: { en: "Channel" } },
    { field: "total", label: { en: "Total" } },
    { field: "placed_at", label: { en: "Placed" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

/** A kanban board over the SalesOrder lifecycle (cart → placed → fulfilled → returned). */
export const SALES_ORDER_BOARD_VIEW: ViewDeclaration = KanbanViewSchema.parse({
  kind: "kanban",
  entity: "SalesOrder",
  label: { en: "Order board" },
  permissions: "inherit",
  stateField: "state",
  columns: [
    { state: "cart", label: { en: "Cart" } },
    { state: "placed", label: { en: "Placed" } },
    { state: "fulfilled", label: { en: "Fulfilled" } },
    { state: "cancelled", label: { en: "Cancelled" } },
    { state: "returned", label: { en: "Returned" } },
  ],
  cardFields: ["order_number", "channel", "total"],
  allowedTransitions: ["place", "fulfill", "cancel", "mark_returned"],
});

/** A calendar placing each SalesOrder on its placed_at date, colored by lifecycle state. */
export const SALES_ORDER_CALENDAR_VIEW: ViewDeclaration = CalendarViewSchema.parse({
  kind: "calendar",
  entity: "SalesOrder",
  label: { en: "Order calendar" },
  permissions: "inherit",
  startField: "placed_at",
  titleField: "order_number",
  colorField: "state",
  defaultView: "month",
});

/** A store map keyed off region, labeled by code, colored by store status. */
export const STORE_MAP_VIEW: ViewDeclaration = MapViewSchema.parse({
  kind: "map",
  entity: "Store",
  label: { en: "Store map" },
  permissions: "inherit",
  geoField: "region",
  markerLabelField: "code",
  markerColorField: "status",
  defaultZoom: 6,
  layers: [{ id: "stores", label: { en: "Stores" }, kind: "markers" }],
});

/** A retail overview dashboard (KPIs + a product breakdown), surfaced on the Store entity. */
export const STORE_DASHBOARD_VIEW: ViewDeclaration = DashboardViewSchema.parse({
  kind: "dashboard",
  entity: "Store",
  label: { en: "Retail overview" },
  permissions: "inherit",
  dashboardRef: "retailOverview",
});

/** A pivot of Product counts by category × status. */
export const PRODUCT_PIVOT_VIEW: ViewDeclaration = PivotViewSchema.parse({
  kind: "pivot",
  entity: "Product",
  label: { en: "Products by category" },
  permissions: "inherit",
  reportRef: "productByCategoryStatus",
  allowReshape: true,
});

export const ERP_RETAIL_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "product.list": PRODUCT_LIST_VIEW,
  "sales_order.list": SALES_ORDER_LIST_VIEW,
  "sales_order.board": SALES_ORDER_BOARD_VIEW,
  "sales_order.calendar": SALES_ORDER_CALENDAR_VIEW,
  "store.map": STORE_MAP_VIEW,
  "store.dashboard": STORE_DASHBOARD_VIEW,
  "product.pivot": PRODUCT_PIVOT_VIEW,
};
