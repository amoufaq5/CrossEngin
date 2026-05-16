import { describe, expect, it } from "vitest";

import {
  formatDiff,
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

describe("formatDiff", () => {
  it("reports (no changes) for empty counts", () => {
    const text = formatDiff({
      entitiesAdded: 0,
      entitiesRemoved: 0,
      entitiesModified: 0,
      workflowsAdded: 0,
      workflowsRemoved: 0,
      workflowsModified: 0,
    });
    expect(text).toContain("(no changes)");
  });

  it("renders +added -removed ~modified per section", () => {
    const text = formatDiff({
      entitiesAdded: 2,
      entitiesRemoved: 1,
      entitiesModified: 3,
      workflowsAdded: 0,
      workflowsRemoved: 0,
      workflowsModified: 0,
    });
    expect(text).toContain("entities: +2 -1 ~3");
    expect(text).not.toContain("workflows:");
  });
});
