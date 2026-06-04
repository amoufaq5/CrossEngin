import { describe, expect, it } from "vitest";

import { parseDefinitionsJson } from "./node.js";

const DEF = {
  id: "wfd_def00001",
  tenantId: null,
  definitionKey: "purchase.approval",
  version: "1.0.0",
  label: "Purchase approval",
  description: "",
  status: "published",
  states: [
    { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
    { name: "approved", kind: "terminal_success", label: "Approved", onEntryActions: [], onExitActions: [], slaSeconds: null },
  ],
  transitions: [
    {
      name: "approve",
      fromState: "draft",
      toState: "approved",
      trigger: { kind: "automatic" },
      guards: [],
      preTransitionActions: [],
      postTransitionActions: [],
    },
  ],
  variables: [],
  timers: [],
  signals: [],
  initialState: "draft",
  compensationStrategy: "no_compensation",
  timeoutSeconds: 86_400,
  createdAt: "2026-05-01T00:00:00.000Z",
  createdBy: "00000000-0000-4000-8000-000000000099",
  publishedAt: "2026-05-01T00:00:00.000Z",
  publishedBy: "00000000-0000-4000-8000-000000000042",
  deprecatedAt: null,
  supersededByDefinitionId: null,
  sourceManifestSha256: null,
};

describe("parseDefinitionsJson", () => {
  it("parses an array of definitions into an id → definition map", () => {
    const map = parseDefinitionsJson(JSON.stringify([DEF]));
    expect([...map.keys()]).toEqual(["wfd_def00001"]);
    expect(map.get("wfd_def00001")?.definitionKey).toBe("purchase.approval");
  });

  it("returns an empty map for an empty array", () => {
    expect(parseDefinitionsJson("[]").size).toBe(0);
  });

  it("rejects a non-array document", () => {
    expect(() => parseDefinitionsJson(JSON.stringify(DEF))).toThrow(/must be a JSON array/);
  });

  it("rejects a malformed definition", () => {
    expect(() => parseDefinitionsJson(JSON.stringify([{ id: "nope" }]))).toThrow();
  });
});
