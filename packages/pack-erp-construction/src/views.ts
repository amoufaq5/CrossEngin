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

export const PROJECT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Project",
  label: { en: "Projects" },
  permissions: "inherit",
  sort: [{ field: "name", direction: "asc" }],
  columns: [
    { field: "code", label: { en: "Code" } },
    { field: "name", label: { en: "Name" } },
    { field: "project_type", label: { en: "Type" } },
    { field: "state", label: { en: "State" } },
    { field: "budget", label: { en: "Budget" } },
    { field: "target_end_date", label: { en: "Target end" } },
  ],
  pageSize: 100,
  exportFormats: ["csv", "xlsx"],
});

export const DAILY_LOG_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "DailyLog",
  label: { en: "Daily logs" },
  permissions: "inherit",
  sort: [{ field: "log_date", direction: "desc" }],
  columns: [
    { field: "log_date", label: { en: "Date" } },
    { field: "project_id", label: { en: "Project" } },
    { field: "weather", label: { en: "Weather" } },
    { field: "crew_count", label: { en: "Crew" } },
    { field: "hours_worked", label: { en: "Hours" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

/** A kanban board over the Project lifecycle (planning → active → completed). */
export const PROJECT_BOARD_VIEW: ViewDeclaration = KanbanViewSchema.parse({
  kind: "kanban",
  entity: "Project",
  label: { en: "Project board" },
  permissions: "inherit",
  stateField: "state",
  columns: [
    { state: "planning", label: { en: "Planning" } },
    { state: "active", label: { en: "Active" } },
    { state: "on_hold", label: { en: "On hold" } },
    { state: "completed", label: { en: "Completed" } },
    { state: "cancelled", label: { en: "Cancelled" } },
  ],
  cardFields: ["code", "name", "project_type", "budget"],
  allowedTransitions: ["start", "hold", "resume", "complete", "cancel"],
});

/** A calendar placing each Project on its start date, colored by lifecycle state. */
export const PROJECT_CALENDAR_VIEW: ViewDeclaration = CalendarViewSchema.parse({
  kind: "calendar",
  entity: "Project",
  label: { en: "Project calendar" },
  permissions: "inherit",
  startField: "start_date",
  endField: "target_end_date",
  titleField: "name",
  colorField: "state",
  defaultView: "month",
});

/** A project map keyed off site region, labeled by code, colored by state. */
export const PROJECT_MAP_VIEW: ViewDeclaration = MapViewSchema.parse({
  kind: "map",
  entity: "Project",
  label: { en: "Project map" },
  permissions: "inherit",
  geoField: "site_region",
  markerLabelField: "code",
  markerColorField: "state",
  defaultZoom: 6,
  layers: [{ id: "projects", label: { en: "Projects" }, kind: "markers" }],
});

/** A construction overview dashboard (KPIs + a state breakdown), surfaced on Project. */
export const PROJECT_DASHBOARD_VIEW: ViewDeclaration = DashboardViewSchema.parse({
  kind: "dashboard",
  entity: "Project",
  label: { en: "Construction overview" },
  permissions: "inherit",
  dashboardRef: "constructionOverview",
});

/** A pivot of Project counts by type × state. */
export const PROJECT_PIVOT_VIEW: ViewDeclaration = PivotViewSchema.parse({
  kind: "pivot",
  entity: "Project",
  label: { en: "Projects by type" },
  permissions: "inherit",
  reportRef: "projectsByTypeState",
  allowReshape: true,
});

export const ERP_CONSTRUCTION_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "project.list": PROJECT_LIST_VIEW,
  "daily_log.list": DAILY_LOG_LIST_VIEW,
  "project.board": PROJECT_BOARD_VIEW,
  "project.calendar": PROJECT_CALENDAR_VIEW,
  "project.map": PROJECT_MAP_VIEW,
  "project.dashboard": PROJECT_DASHBOARD_VIEW,
  "project.pivot": PROJECT_PIVOT_VIEW,
};
