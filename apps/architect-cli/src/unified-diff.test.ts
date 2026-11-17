import { describe, expect, it } from "vitest";

import { containsTerminalUnsafe, diffLines, MAX_DIFF_LINES, unifiedDiff, visibleLine } from "./unified-diff.js";

const L = { oldLabel: "a/m.json", newLabel: "b/m.json" };

describe("unifiedDiff", () => {
  it("answers nothing for identical text", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", L)).toEqual([]);
  });

  it("renders one hunk with three lines of context", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n") + "\n";
    const after = ["1", "2", "3", "4", "X", "6", "7", "8"].join("\n") + "\n";
    expect(unifiedDiff(before, after, L)).toEqual([
      "--- a/m.json",
      "+++ b/m.json",
      "@@ -2,7 +2,7 @@",
      " 2",
      " 3",
      " 4",
      "-5",
      "+X",
      " 6",
      " 7",
      " 8",
    ]);
  });

  it("renders a new file against /dev/null as all additions", () => {
    expect(unifiedDiff("", "a\nb\n", { oldLabel: "/dev/null", newLabel: "b/m.json" })).toEqual([
      "--- /dev/null",
      "+++ b/m.json",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
    ]);
  });

  it("splits distant changes into separate hunks with correct line numbers", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i.toString()}`).join("\n") + "\n";
    const after = before.replace("l1\n", "L1\n").replace("l18\n", "L18\n");
    const out = unifiedDiff(before, after, L);
    expect(out.filter((l) => l.startsWith("@@"))).toEqual(["@@ -1,5 +1,5 @@", "@@ -16,5 +16,5 @@"]);
  });

  it("marks a final line with no newline, so a terminator change is visible", () => {
    const out = unifiedDiff("a\nb", "a\nb\n", L);
    expect(out).toContain("-b");
    expect(out).toContain("\\ No newline at end of file");
    expect(out).toContain("+b");
  });

  it("is a minimal edit script: every old line is kept or removed and every new line kept or added", () => {
    const a = "x\ny\nz\nw\n";
    const b = "y\nz\nq\nw\n";
    const ops = diffLines(a, b);
    expect(ops.filter((o) => o.kind !== "+").map((o) => o.text)).toEqual(["x", "y", "z", "w"]);
    expect(ops.filter((o) => o.kind !== "-").map((o) => o.text)).toEqual(["y", "z", "q", "w"]);
    expect(ops.filter((o) => o.kind !== " ")).toHaveLength(2);
  });

  it("renders the proposed lines through visibleLine, so a control byte cannot rewrite the terminal", () => {
    const out = unifiedDiff('{"a": 1}\n', '{"a": "\u009b2J"}\n', L);
    expect(out).toContain('+{"a": "\\u{9b}2J"}');
    expect(out.join("\n")).not.toContain("\u009b");
  });

  it("counts what it cuts rather than dropping it", () => {
    const after = Array.from({ length: MAX_DIFF_LINES * 2 }, (_, i) => i.toString()).join("\n") + "\n";
    const out = unifiedDiff("", after, L);
    expect(out).toHaveLength(MAX_DIFF_LINES);
    expect(out[out.length - 1]).toMatch(/^… \d+ more diff lines not shown; the file is written in full$/);
  });
});

describe("visibleLine", () => {
  it("escapes terminal controls and bidi overrides the proposed text could carry", () => {
    expect(visibleLine('"name": "a\u009b2Jb"')).toBe('"name": "a\\u{9b}2Jb"');
    expect(visibleLine("x\u001b[2Ky")).toBe("x\\u{1b}[2Ky");
    expect(visibleLine("abc‮def")).toBe("abc\\u{202e}def");
    expect(visibleLine("tab\tkept")).toBe("tab\tkept");
  });
});

describe("containsTerminalUnsafe and the diff labels", () => {
  it("flags a line break, a control, a C1 control and a bidi override, and passes a plain name", () => {
    for (const s of ["a\nb", "a\rb", "a\u001bb", "a\u0000b", "a\u009bb", "a‮b", "a⁦b"]) {
      expect(containsTerminalUnsafe(s), JSON.stringify(s)).toBe(true);
    }
    expect(containsTerminalUnsafe("plain name.json")).toBe(false);
  });

  it("escapes the labels too, since a label is a file name", () => {
    const out = unifiedDiff("a\n", "b\n", { oldLabel: "a/x\u001b[2K.json", newLabel: "b/x\u001b[2K.json" });
    expect(out.slice(0, 2)).toEqual(["--- a/x\\u{1b}[2K.json", "+++ b/x\\u{1b}[2K.json"]);
  });
});
