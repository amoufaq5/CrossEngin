import { describe, expect, it } from "vitest";

import {
  escapeCsvCell,
  escapeCsvCellWithSep,
  formatCsv,
  formatDiff,
  formatManifestSummary,
  formatNdjson,
  formatTsv,
  formatValidationErrors,
  formatYaml,
  printCsv,
  printError,
  printJson,
  printNdjson,
  printStructured,
  printSuccess,
  printTsv,
  printYaml,
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

  it("respects custom separator", () => {
    let stdoutBuf = "";
    const io: IoStreams = {
      stdout: { write: (s) => { stdoutBuf += s; } },
      stderr: { write: () => {} },
    };
    printCsv(io, ["a", "b"], [["1", "2"]], ";");
    expect(stdoutBuf).toBe("a;b\n1;2\n");
  });
});

describe("escapeCsvCellWithSep (custom separator)", () => {
  it("quotes when string contains custom separator", () => {
    expect(escapeCsvCellWithSep("a;b", ";")).toBe('"a;b"');
  });

  it("does NOT quote when string contains default comma but separator is semicolon", () => {
    expect(escapeCsvCellWithSep("a,b", ";")).toBe("a,b");
  });

  it("still quotes when string contains double quote regardless of separator", () => {
    expect(escapeCsvCellWithSep('a"b', ";")).toBe('"a""b"');
  });

  it("still quotes when string contains newline regardless of separator", () => {
    expect(escapeCsvCellWithSep("a\nb", ";")).toBe('"a\nb"');
  });
});

describe("formatCsv with custom separator", () => {
  it("uses semicolon separator when specified", () => {
    const csv = formatCsv(["a", "b"], [["1", "2"]], ";");
    expect(csv).toBe("a;b\n1;2\n");
  });

  it("escapes cells with custom separator", () => {
    const csv = formatCsv(["field"], [["a;b"]], ";");
    expect(csv).toBe('field\n"a;b"\n');
  });

  it("does NOT escape comma when separator is semicolon", () => {
    const csv = formatCsv(["field"], [["a,b"]], ";");
    expect(csv).toBe("field\na,b\n");
  });
});

describe("formatTsv", () => {
  it("renders header + rows with tab separator + trailing newline", () => {
    const tsv = formatTsv(["a", "b"], [["1", "2"]]);
    expect(tsv).toBe("a\tb\n1\t2\n");
  });

  it("escapes cells containing tabs", () => {
    const tsv = formatTsv(["field"], [["a\tb"]]);
    expect(tsv).toBe('field\n"a\tb"\n');
  });

  it("escapes cells with quotes / newlines (same as CSV)", () => {
    const tsv = formatTsv(["field"], [['c"d'], ["e\nf"]]);
    expect(tsv).toBe('field\n"c""d"\n"e\nf"\n');
  });

  it("does NOT escape commas (commas allowed in TSV)", () => {
    const tsv = formatTsv(["field"], [["a,b"]]);
    expect(tsv).toBe("field\na,b\n");
  });
});

describe("printTsv", () => {
  it("writes formatted TSV to stdout", () => {
    let stdoutBuf = "";
    const io: IoStreams = {
      stdout: { write: (s) => { stdoutBuf += s; } },
      stderr: { write: () => {} },
    };
    printTsv(io, ["a", "b"], [["1", "2"]]);
    expect(stdoutBuf).toBe("a\tb\n1\t2\n");
  });
});

describe("formatNdjson", () => {
  it("renders one JSON object per line with trailing newline", () => {
    const ndjson = formatNdjson([{ a: 1 }, { a: 2 }]);
    expect(ndjson).toBe('{"a":1}\n{"a":2}\n');
  });

  it("renders empty rows as just trailing newline", () => {
    const ndjson = formatNdjson([]);
    expect(ndjson).toBe("\n");
  });

  it("preserves null values", () => {
    const ndjson = formatNdjson([{ a: null, b: "x" }]);
    expect(ndjson).toBe('{"a":null,"b":"x"}\n');
  });

  it("nested objects/arrays inline (no pretty-print)", () => {
    const ndjson = formatNdjson([{ nested: { x: 1, y: [2, 3] } }]);
    expect(ndjson).toBe('{"nested":{"x":1,"y":[2,3]}}\n');
  });
});

describe("printNdjson", () => {
  it("writes formatted NDJSON to stdout", () => {
    let stdoutBuf = "";
    const io: IoStreams = {
      stdout: { write: (s) => { stdoutBuf += s; } },
      stderr: { write: () => {} },
    };
    printNdjson(io, [{ a: 1 }, { b: 2 }]);
    expect(stdoutBuf).toBe('{"a":1}\n{"b":2}\n');
  });
});

describe("formatYaml", () => {
  it("renders a flat object as key: value lines", () => {
    expect(formatYaml({ a: 1, b: "x", c: true, d: null })).toBe(
      "a: 1\nb: x\nc: true\nd: null\n",
    );
  });

  it("quotes strings that look numeric / reserved / have special chars", () => {
    const yaml = formatYaml({
      uuid: "11111111-0000-4000-8000-000000000001",
      kind: "opt_out_set",
      reserved: "null",
      withColon: "a: b",
      ts: "2026-05-20 00:00:00",
    });
    expect(yaml).toContain('uuid: "11111111-0000-4000-8000-000000000001"');
    expect(yaml).toContain("kind: opt_out_set");
    expect(yaml).toContain('reserved: "null"');
    expect(yaml).toContain('withColon: "a: b"');
    expect(yaml).toContain('ts: "2026-05-20 00:00:00"');
  });

  it("renders nested objects with indentation", () => {
    expect(formatYaml({ outer: { inner: 1 } })).toBe(
      "outer:\n  inner: 1\n",
    );
  });

  it("renders arrays of scalars", () => {
    expect(formatYaml({ kinds: ["opt_out_set", "policy_deleted"] })).toBe(
      "kinds:\n  - opt_out_set\n  - policy_deleted\n",
    );
  });

  it("renders arrays of objects (buckets)", () => {
    const yaml = formatYaml({
      buckets: [
        { key: "opt_out_set", count: 12 },
        { key: "policy_deleted", count: 1 },
      ],
    });
    expect(yaml).toBe(
      "buckets:\n  - key: opt_out_set\n    count: 12\n  - key: policy_deleted\n    count: 1\n",
    );
  });

  it("renders empty array as [] and empty object as {}", () => {
    expect(formatYaml({ a: [], b: {} })).toBe("a: []\nb: {}\n");
  });

  it("renders null array values", () => {
    expect(formatYaml({ kinds: null })).toBe("kinds: null\n");
  });

  it("round-trips a retention summary envelope shape", () => {
    const yaml = formatYaml({
      action: "summary",
      groupBy: "kind",
      totalCount: 16,
      buckets: [{ key: "opt_out_set", count: 12 }],
    });
    expect(yaml).toContain("action: summary");
    expect(yaml).toContain("groupBy: kind");
    expect(yaml).toContain("totalCount: 16");
    expect(yaml).toContain("buckets:");
    expect(yaml).toContain("    count: 12");
  });
});

describe("printYaml + printStructured", () => {
  it("printYaml writes YAML to stdout", () => {
    let buf = "";
    const io: IoStreams = {
      stdout: { write: (s) => { buf += s; } },
      stderr: { write: () => {} },
    };
    printYaml(io, { a: 1 });
    expect(buf).toBe("a: 1\n");
  });

  it("printStructured emits JSON for format=json", () => {
    let buf = "";
    const io: IoStreams = {
      stdout: { write: (s) => { buf += s; } },
      stderr: { write: () => {} },
    };
    printStructured(io, "json", { a: 1 });
    expect(buf).toBe('{\n  "a": 1\n}\n');
  });

  it("printStructured emits YAML for format=yaml", () => {
    let buf = "";
    const io: IoStreams = {
      stdout: { write: (s) => { buf += s; } },
      stderr: { write: () => {} },
    };
    printStructured(io, "yaml", { a: 1 });
    expect(buf).toBe("a: 1\n");
  });

  it("printStructured falls back to JSON for non-yaml formats", () => {
    let buf = "";
    const io: IoStreams = {
      stdout: { write: (s) => { buf += s; } },
      stderr: { write: () => {} },
    };
    printStructured(io, "csv", { a: 1 });
    expect(buf).toBe('{\n  "a": 1\n}\n');
  });
});
