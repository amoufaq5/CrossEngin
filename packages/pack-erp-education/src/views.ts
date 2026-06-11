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

export const COURSE_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Course",
  label: { en: "Courses" },
  permissions: "inherit",
  sort: [{ field: "title", direction: "asc" }],
  columns: [
    { field: "code", label: { en: "Code" } },
    { field: "title", label: { en: "Title" } },
    { field: "department", label: { en: "Department" } },
    { field: "credits", label: { en: "Credits" } },
    { field: "capacity", label: { en: "Capacity" } },
    { field: "state", label: { en: "State" } },
  ],
  pageSize: 100,
  exportFormats: ["csv", "xlsx"],
});

export const STUDENT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Student",
  label: { en: "Students" },
  permissions: "inherit",
  sort: [{ field: "family_name", direction: "asc" }],
  columns: [
    { field: "student_number", label: { en: "Number" } },
    { field: "given_name", label: { en: "Given name" } },
    { field: "family_name", label: { en: "Family name" } },
    { field: "enrollment_status", label: { en: "Status" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

/** A kanban board over the Course catalog lifecycle (draft → open → closed → archived). */
export const COURSE_BOARD_VIEW: ViewDeclaration = KanbanViewSchema.parse({
  kind: "kanban",
  entity: "Course",
  label: { en: "Course board" },
  permissions: "inherit",
  stateField: "state",
  columns: [
    { state: "draft", label: { en: "Draft" } },
    { state: "open", label: { en: "Open" } },
    { state: "closed", label: { en: "Closed" } },
    { state: "archived", label: { en: "Archived" } },
  ],
  cardFields: ["code", "title", "department", "capacity"],
  allowedTransitions: ["publish", "close", "archive"],
});

/** A calendar placing each Enrollment on its enrolled_at date, colored by state. */
export const ENROLLMENT_CALENDAR_VIEW: ViewDeclaration = CalendarViewSchema.parse({
  kind: "calendar",
  entity: "Enrollment",
  label: { en: "Enrollment calendar" },
  permissions: "inherit",
  startField: "enrolled_at",
  titleField: "term",
  colorField: "state",
  defaultView: "month",
});

/** A campus map keyed off the course campus, labeled by code, colored by state. */
export const COURSE_MAP_VIEW: ViewDeclaration = MapViewSchema.parse({
  kind: "map",
  entity: "Course",
  label: { en: "Campus map" },
  permissions: "inherit",
  geoField: "campus",
  markerLabelField: "code",
  markerColorField: "state",
  defaultZoom: 12,
  layers: [{ id: "courses", label: { en: "Courses" }, kind: "markers" }],
});

/** An education overview dashboard (KPIs + a department breakdown), surfaced on Course. */
export const COURSE_DASHBOARD_VIEW: ViewDeclaration = DashboardViewSchema.parse({
  kind: "dashboard",
  entity: "Course",
  label: { en: "Education overview" },
  permissions: "inherit",
  dashboardRef: "educationOverview",
});

/** A pivot of Course counts by department × state. */
export const COURSE_PIVOT_VIEW: ViewDeclaration = PivotViewSchema.parse({
  kind: "pivot",
  entity: "Course",
  label: { en: "Courses by department" },
  permissions: "inherit",
  reportRef: "coursesByDeptState",
  allowReshape: true,
});

export const ERP_EDUCATION_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "course.list": COURSE_LIST_VIEW,
  "student.list": STUDENT_LIST_VIEW,
  "course.board": COURSE_BOARD_VIEW,
  "enrollment.calendar": ENROLLMENT_CALENDAR_VIEW,
  "course.map": COURSE_MAP_VIEW,
  "course.dashboard": COURSE_DASHBOARD_VIEW,
  "course.pivot": COURSE_PIVOT_VIEW,
};
