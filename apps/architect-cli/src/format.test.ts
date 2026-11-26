import { describe, expect, it } from "vitest";

import {
  formatManifestSectionDiff,
  formatManifestSummary,
  formatValidationErrors,
  printError,
  printJson,
  printSuccess,
  type IoStreams,
} from "./format.js";

function buffers(): { io: IoStreams; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (chunk: string) => out.push(chunk) },
      stderr: { write: (chunk: string) => err.push(chunk) },
    },
    out,
    err,
  };
}

describe("printJson", () => {
  it("writes pretty-printed JSON to stdout + newline", () => {
    const { io, out } = buffers();
    printJson(io, { a: 1, b: [2, 3] });
    expect(out.join("")).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
  });
});

describe("printSuccess / printError", () => {
  it("printSuccess writes to stdout", () => {
    const { io, out, err } = buffers();
    printSuccess(io, "ok");
    expect(out.join("")).toBe("ok\n");
    expect(err).toEqual([]);
  });

  it("printError writes to stderr", () => {
    const { io, out, err } = buffers();
    printError(io, "boom");
    expect(err.join("")).toBe("boom\n");
    expect(out).toEqual([]);
  });
});

describe("formatValidationErrors", () => {
  it("returns 'no validation errors' for an empty list", () => {
    expect(formatValidationErrors([])).toBe("no validation errors");
  });

  it("lists path + message + optional code", () => {
    const text = formatValidationErrors([
      { path: "meta.slug", message: "required", code: "invalid_type" },
      { path: "entities[0].name", message: "must be kebab-case" },
    ]);
    expect(text).toContain("2 validation error(s):");
    expect(text).toContain("meta.slug: required [invalid_type]");
    expect(text).toContain("entities[0].name: must be kebab-case");
  });
});

describe("formatManifestSummary", () => {
  const summary = {
    name: "Operate Retail F&B",
    slug: "operate-retail-fnb",
    version: "1.0.0",
    description: "Quick-service restaurant workflows",
    extendsParents: 0,
    compliancePacks: 1,
    counts: {
      entities: 8,
      workflows: 3,
      views: 5,
      reports: 4,
      dashboards: 1,
      jobs: 2,
      integrations: 1,
      roles: 4,
      traits: 0,
      relations: 6,
      fileTypes: 2,
      customWidgets: 0,
    },
    hash: "a".repeat(64),
  };

  it("includes name, slug, version, hash", () => {
    const text = formatManifestSummary(summary);
    expect(text).toContain("Manifest: Operate Retail F&B");
    expect(text).toContain("slug:        operate-retail-fnb");
    expect(text).toContain("version:     1.0.0");
    expect(text).toContain(`hash:        ${summary.hash}`);
  });

  it("includes counts section", () => {
    const text = formatManifestSummary(summary);
    expect(text).toContain("entities:        8");
    expect(text).toContain("workflows:       3");
    expect(text).toContain("integrations:    1");
  });

  it("omits the description line when null", () => {
    const text = formatManifestSummary({ ...summary, description: null });
    expect(text).not.toContain("description:");
  });

  it("omits the extends + packs lines when zero", () => {
    const text = formatManifestSummary({
      ...summary,
      extendsParents: 0,
      compliancePacks: 0,
    });
    expect(text).not.toContain("extends:");
    expect(text).not.toContain("packs:");
  });
});

describe("formatManifestSectionDiff", () => {
  it("reports (no changes) for no changed section", () => {
    expect(formatManifestSectionDiff([])).toContain("(no changes)");
  });

  it("names each changed section with its reach, its members and the reach note", () => {
    const text = formatManifestSectionDiff([
      {
        section: "workflows",
        reach: "served",
        reachNote: "NOTE-SERVED",
        keying: "record",
        presence: "present",
        membersKeyed: true,
        added: ["a"],
        removed: [],
        changed: ["b", "c"],
        countBefore: 2,
        countAfter: 3,
      },
      {
        section: "relations",
        reach: "served",
        reachNote: "NOTE-REL",
        keying: "unkeyed_array",
        presence: "present",
        membersKeyed: false,
        added: [],
        removed: [],
        changed: [],
        countBefore: 4,
        countAfter: 4,
      },
      {
        section: "theme",
        reach: "unread",
        reachNote: "NOTE-UNREAD",
        keying: "object_keys",
        presence: "added",
        membersKeyed: false,
        added: [],
        removed: [],
        changed: [],
        countBefore: 0,
        countAfter: 1,
      },
    ]);
    expect(text).toContain("workflows [served]: +1 -0 ~2");
    expect(text).toContain("added a; changed b, c");
    expect(text).toContain("relations [served]: changed (members unkeyed; 4 -> 4)");
    expect(text).toContain("theme [unread]: section added");
    for (const note of ["NOTE-SERVED", "NOTE-REL", "NOTE-UNREAD"]) expect(text).toContain(note);
    expect(text).not.toContain("(no changes)");
  });
});
