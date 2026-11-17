/**
 * A unified diff of a file's text, for the write-approval prompt (H-29). The tool description had
 * told the model a person "is shown the diff" while the prompt printed three entity counts, so a
 * person typing `y` was approving bytes they had not seen. This is the diff of what is on disk
 * against exactly what will be written — the same two strings, not a re-serialisation of either.
 *
 * Myers' O(ND) algorithm over lines, after trimming the common prefix and suffix, which is what
 * keeps an ordinary manifest edit (a few lines in a long file) cheap.
 */

export const DEFAULT_DIFF_CONTEXT = 3;
/** Past this many rendered lines the rest is counted, never silently dropped. */
export const MAX_DIFF_LINES = 400;

export type DiffOp = { readonly kind: " " | "-" | "+"; readonly text: string };

/** Marks a final line with no terminator, so it differs from the same text with one. */
const NO_EOL = "\u0000no-eol";

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else lines[lines.length - 1] += NO_EOL;
  return lines;
}

function myers(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        break outer;
      }
    }
  }
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    v = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", text: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ kind: "+", text: b[y - 1]! });
        y--;
      } else {
        ops.push({ kind: "-", text: a[x - 1]! });
        x--;
      }
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: " ", text: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const prefix = a.slice(0, start).map((text): DiffOp => ({ kind: " ", text }));
  const suffix = a.slice(endA).map((text): DiffOp => ({ kind: " ", text }));
  return [...prefix, ...myers(a.slice(start, endA), b.slice(start, endB)), ...suffix];
}

// eslint-disable-next-line no-control-regex
const TERMINAL_UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * Makes a line safe to print to a terminal: C0/C1 controls, DEL and bidirectional overrides are
 * shown as `\u{…}` escapes. The proposed text is the model's, and a CSI sequence or a bidi override
 * inside a JSON string could otherwise hide or reorder the very lines a person is approving.
 */
export function visibleLine(line: string): string {
  return line.replace(TERMINAL_UNSAFE_CHARS, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/**
 * Whether `text` carries a character `visibleLine` would escape, or a line break. A file name is
 * printed in the approval prompt and as a diff label, so a name carrying one could forge or erase
 * the lines being approved; such a name is refused rather than escaped.
 */
export function containsTerminalUnsafe(text: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(text);
}

export interface UnifiedDiffOptions {
  readonly oldLabel: string;
  readonly newLabel: string;
  readonly context?: number;
  readonly maxLines?: number;
}

export function unifiedDiff(
  oldText: string,
  newText: string,
  opts: UnifiedDiffOptions,
): readonly string[] {
  const context = opts.context ?? DEFAULT_DIFF_CONTEXT;
  const maxLines = opts.maxLines ?? MAX_DIFF_LINES;
  const ops = diffLines(oldText, newText);
  const changed: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== " ") changed.push(i);
  });
  if (changed.length === 0) return [];

  const hunks: Array<[number, number]> = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(ops.length - 1, i + context);
    const last = hunks[hunks.length - 1];
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else hunks.push([lo, hi]);
  }

  const out: string[] = [`--- ${visibleLine(opts.oldLabel)}`, `+++ ${visibleLine(opts.newLabel)}`];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const [lo, hi] of hunks) {
    for (; cursor < lo; cursor++) {
      const op = ops[cursor]!;
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
    }
    const slice = ops.slice(lo, hi + 1);
    const oldCount = slice.filter((o) => o.kind !== "+").length;
    const newCount = slice.filter((o) => o.kind !== "-").length;
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine;
    const newStart = newCount === 0 ? newLine - 1 : newLine;
    out.push(
      `@@ -${oldStart.toString()},${oldCount.toString()} +${newStart.toString()},${newCount.toString()} @@`,
    );
    for (const op of slice) {
      if (op.text.endsWith(NO_EOL)) {
        out.push(`${op.kind}${visibleLine(op.text.slice(0, -NO_EOL.length))}`);
        out.push("\\ No newline at end of file");
      } else {
        out.push(`${op.kind}${visibleLine(op.text)}`);
      }
    }
    for (; cursor <= hi; cursor++) {
      const op = ops[cursor]!;
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
    }
  }
  if (out.length <= maxLines) return out;
  const shown = out.slice(0, maxLines - 1);
  shown.push(
    `… ${(out.length - shown.length).toString()} more diff lines not shown; the file is written in full`,
  );
  return shown;
}
