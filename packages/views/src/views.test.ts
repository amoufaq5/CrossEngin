import { describe, expect, it } from "vitest";
import {
  VIEW_KINDS,
  ViewDeclarationSchema,
  viewReferencedDashboards,
  viewReferencedReports,
  viewReferencedViews,
  viewReferencedWorkflows,
} from "./views.js";

describe("VIEW_KINDS", () => {
  it("declares the eight renderer kinds", () => {
    expect(VIEW_KINDS).toEqual([
      "list",
      "record",
      "form",
      "kanban",
      "calendar",
      "map",
      "dashboard",
      "pivot",
    ]);
  });
});

describe("ViewDeclarationSchema — list", () => {
  it("parses the ADR-0018 prescriptionInbox example", () => {
    const v = ViewDeclarationSchema.parse({
      kind: "list",
      entity: "prescription",
      label: { en: "Prescription Inbox", ar: "صندوق الوصفات" },
      icon: "Pill",
      filters: [
        { field: "status", operator: "in", values: ["pending", "verified"] },
      ],
      sort: [{ field: "writtenAt", direction: "desc" }],
      columns: [
        { field: "patient.name", label: { en: "Patient" }, width: 200 },
        { field: "drug.name", label: { en: "Drug" } },
        { field: "quantity", label: { en: "Qty" }, align: "end" },
        { field: "status", label: { en: "Status" }, render: "badge" },
        { field: "writtenAt", label: { en: "Written" }, render: "relativeTime" },
      ],
      rowAction: { kind: "openRecord", view: "prescriptionDetail" },
      bulkActions: [
        { kind: "workflow", name: "verifyPrescription", label: { en: "Verify" } },
      ],
      permissions: "inherit",
    });
    expect(v.kind).toBe("list");
    if (v.kind === "list") {
      expect(v.columns).toHaveLength(5);
      expect(v.pageSize).toBe(50);
    }
  });

  it("rejects a list with no columns", () => {
    expect(() =>
      ViewDeclarationSchema.parse({
        kind: "list",
        entity: "x",
        columns: [],
      }),
    ).toThrow();
  });

  it("rejects a column with a non-PascalCase render hint", () => {
    expect(() =>
      ViewDeclarationSchema.parse({
        kind: "list",
        entity: "x",
        columns: [{ field: "name", render: "fancy" }],
      }),
    ).toThrow();
  });
});

describe("ViewDeclarationSchema — record + form", () => {
  it("parses a record view with sections", () => {
    const v = ViewDeclarationSchema.parse({
      kind: "record",
      entity: "Patient",
      sections: [
        {
          id: "demographics",
          label: { en: "Demographics" },
          fields: ["name", "dob"],
        },
      ],
    });
    expect(v.kind).toBe("record");
  });

  it("parses a multi-step form", () => {
    const v = ViewDeclarationSchema.parse({
      kind: "form",
      entity: "Intake",
      mode: "intake",
      steps: [
        { id: "demo", label: { en: "Demographics" }, fields: [{ field: "name" }] },
        { id: "history", label: { en: "History" }, fields: [{ field: "history" }] },
      ],
    });
    expect(v.kind).toBe("form");
  });

  it("rejects duplicate fields within a form step", () => {
    expect(() =>
      ViewDeclarationSchema.parse({
        kind: "form",
        entity: "Intake",
        steps: [
          {
            id: "demo",
            label: { en: "Demographics" },
            fields: [{ field: "name" }, { field: "name" }],
          },
        ],
      }),
    ).toThrow(/duplicate field/);
  });
});

describe("ViewDeclarationSchema — kanban", () => {
  it("parses a kanban with state-based columns", () => {
    const v = ViewDeclarationSchema.parse({
      kind: "kanban",
      entity: "Prescription",
      stateField: "status",
      columns: [
        { state: "pending", label: { en: "Pending" } },
        { state: "verified", label: { en: "Verified" } },
      ],
      cardFields: ["patient.name", "drug.name"],
      allowedTransitions: ["verify"],
    });
    if (v.kind === "kanban") {
      expect(v.columns).toHaveLength(2);
    }
  });
});

describe("ViewDeclarationSchema — calendar", () => {
  it("parses a calendar with working hours", () => {
    const v = ViewDeclarationSchema.parse({
      kind: "calendar",
      entity: "Appointment",
      startField: "startsAt",
      endField: "endsAt",
      titleField: "title",
      workingHours: { startHour: 8, endHour: 18, weekdays: [1, 2, 3, 4, 5] },
    });
    if (v.kind === "calendar") {
      expect(v.defaultView).toBe("week");
    }
  });
});

describe("ViewDeclarationSchema — map", () => {
  it("parses a map with layers + bounds", () => {
    const v = ViewDeclarationSchema.parse({
      kind: "map",
      entity: "Site",
      geoField: "location",
      defaultZoom: 12,
      layers: [
        {
          id: "main",
          label: { en: "Sites" },
          kind: "markers",
        },
      ],
      bounds: { south: 24, west: 54, north: 26, east: 56 },
    });
    if (v.kind === "map") {
      expect(v.layers).toHaveLength(1);
    }
  });

  it("rejects an invalid lat/lng bounds", () => {
    expect(() =>
      ViewDeclarationSchema.parse({
        kind: "map",
        entity: "Site",
        geoField: "loc",
        layers: [{ id: "x", label: { en: "x" }, kind: "markers" }],
        bounds: { south: 200, west: 0, north: 0, east: 0 },
      }),
    ).toThrow();
  });
});

describe("ViewDeclarationSchema — dashboard + pivot refs", () => {
  it("parses a dashboard view referencing a dashboard id", () => {
    const v = ViewDeclarationSchema.parse({
      kind: "dashboard",
      entity: "Tenant",
      dashboardRef: "managerDailyDashboard",
    });
    expect(v.kind).toBe("dashboard");
  });

  it("parses a pivot view referencing a report id", () => {
    const v = ViewDeclarationSchema.parse({
      kind: "pivot",
      entity: "Deviation",
      reportRef: "monthlyDeviationRecap",
    });
    expect(v.kind).toBe("pivot");
  });
});

describe("view reference helpers", () => {
  it("viewReferencedDashboards returns the dashboardRef on a dashboard view", () => {
    const v = ViewDeclarationSchema.parse({
      kind: "dashboard",
      entity: "x",
      dashboardRef: "d1",
    });
    expect(viewReferencedDashboards(v)).toEqual(["d1"]);
  });

  it("viewReferencedReports returns the reportRef on a pivot view", () => {
    const v = ViewDeclarationSchema.parse({
      kind: "pivot",
      entity: "x",
      reportRef: "r1",
    });
    expect(viewReferencedReports(v)).toEqual(["r1"]);
  });

  it("viewReferencedViews returns rowAction.view + related.view", () => {
    const list = ViewDeclarationSchema.parse({
      kind: "list",
      entity: "x",
      columns: [{ field: "n" }],
      rowAction: { kind: "openRecord", view: "detail" },
    });
    expect(viewReferencedViews(list)).toEqual(["detail"]);

    const record = ViewDeclarationSchema.parse({
      kind: "record",
      entity: "x",
      sections: [{ id: "s", label: { en: "s" }, fields: ["n"] }],
      related: [
        { id: "r", label: { en: "r" }, relation: "rel", view: "subList" },
      ],
    });
    expect(viewReferencedViews(record)).toEqual(["subList"]);
  });

  it("viewReferencedWorkflows pulls transitions from list/record/kanban", () => {
    const list = ViewDeclarationSchema.parse({
      kind: "list",
      entity: "x",
      columns: [{ field: "n" }],
      rowAction: { kind: "workflow", name: "verify" },
      bulkActions: [{ kind: "workflow", name: "release", label: { en: "Release" } }],
    });
    expect([...viewReferencedWorkflows(list)].sort()).toEqual(["release", "verify"]);

    const kanban = ViewDeclarationSchema.parse({
      kind: "kanban",
      entity: "x",
      stateField: "status",
      columns: [{ state: "a", label: { en: "a" } }],
      cardFields: ["n"],
      allowedTransitions: ["move"],
    });
    expect(viewReferencedWorkflows(kanban)).toEqual(["move"]);
  });
});
