import {
  ListViewSchema,
  type ListView,
  type ViewDeclaration,
} from "@crossengin/views";

export const STUDENT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Student",
  label: { en: "Students" },
  permissions: "inherit",
  sort: [{ field: "full_name", direction: "asc" }],
  columns: [
    { field: "student_number", label: { en: "Student #" } },
    { field: "full_name", label: { en: "Name" } },
    { field: "student_email", label: { en: "Email" } },
    { field: "enrollment_year", label: { en: "Enrolled" } },
    { field: "status", label: { en: "Status" } },
  ],
  pageSize: 100,
  exportFormats: ["csv", "xlsx"],
});

export const ENROLLMENT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Enrollment",
  label: { en: "Enrollments" },
  permissions: "inherit",
  sort: [{ field: "enrolled_at", direction: "desc" }],
  columns: [
    { field: "enrollment_number", label: { en: "Number" } },
    { field: "student_id", label: { en: "Student" } },
    { field: "course_id", label: { en: "Course" } },
    { field: "term", label: { en: "Term" } },
    { field: "status", label: { en: "Status" } },
    { field: "enrolled_at", label: { en: "Enrolled" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

export const ERP_EDUCATION_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "student.list": STUDENT_LIST_VIEW,
  "enrollment.list": ENROLLMENT_LIST_VIEW,
};
