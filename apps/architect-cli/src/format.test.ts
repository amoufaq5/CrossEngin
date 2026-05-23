import { describe, expect, it } from "vitest";

import {
  escapeCsvCell,
  formatCsv,
  formatDiff,
  formatManifestSummary,
  formatValidationErrors,
  printCsv,
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

describe("escapeCsvCell (RFC 4180)", () => {
  it("returns empty string for null", () => {
    expect(escapeCsvCell(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("returns plain string for simple values (no quoting needed)", () => {
    expect(escapeCsvCell("hello")).toBe("hello");
    expect(escapeCsvCell(42)).toBe("42");
    expect(escapeCsvCell(true)).toBe("true");
    expect(escapeCsvCell(false)).toBe("false");
  });

  it("quotes + escapes when string contains comma", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
  });

  it("quotes + escapes when string contains double quote", () => {
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes + escapes when string contains newline", () => {
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("quotes + escapes when string contains carriage return", () => {
    expect(escapeCsvCell("line1\rline2")).toBe('"line1\rline2"');
  });

  it("JSON-stringifies object values", () => {
    expect(escapeCsvCell({ a: 1, b: 2 })).toBe('"{""a"":1,""b"":2}"');
  });

  it("JSON-stringifies array values", () => {
    expect(escapeCsvCell([1, 2, 3])).toBe('"[1,2,3]"');
  });
});

describe("formatCsv", () => {
  it("renders header + rows separated by newlines + trailing newline", () => {
    const csv = formatCsv(["a", "b"], [
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(csv).toBe("a,b\n1,2\n3,4\n");
  });

  it("renders just header when rows empty", () => {
    const csv = formatCsv(["a", "b"], []);
    expect(csv).toBe("a,b\n");
  });

  it("escapes cells with commas / quotes", () => {
    const csv = formatCsv(["field"], [["a,b"], ['c"d']]);
    expect(csv).toBe('field\n"a,b"\n"c""d"\n');
  });
});

describe("printCsv", () => {
  it("writes formatted CSV to stdout", () => {
    let stdoutBuf = "";
    const io: IoStreams = {
      stdout: { write: (s) => { stdoutBuf += s; } },
      stderr: { write: () => {} },
    };
    printCsv(io, ["a", "b"], [["1", "2"]]);
    expect(stdoutBuf).toBe("a,b\n1,2\n");
  });
});
