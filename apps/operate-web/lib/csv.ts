// CSV serialization for the list export. Pure and import-free, so it is testable from outside this
// app (packages/testing/src/operate-web.test.ts) — operate-web has no test runner of its own.

/**
 * The first characters a spreadsheet reads as the start of a formula (OWASP's CSV-injection list):
 * `=`, `+`, `-` and `@`, plus tab and carriage return, which some importers strip before deciding.
 * A record value is tenant data typed by whoever created the row, so a cell opening with one of
 * these is a formula the person *opening the export* runs — `=HYPERLINK(...)` exfiltrating the row
 * beside it, or a DDE payload — under their own spreadsheet's privileges.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * A plain decimal literal, which a spreadsheet reads as a number rather than a formula. Kept
 * verbatim rather than prefixed, because a `decimal` field crosses the wire as a string
 * (ADR-0332) and every negative amount in a money column starts with `-`: prefixing it would turn
 * `-10.25` into text, which breaks the sum the export exists for and protects nothing.
 */
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * One cell, RFC 4180-quoted, with a value a spreadsheet would evaluate made inert by a leading
 * apostrophe — the convention Excel, LibreOffice and Sheets all read as "this is text" and do not
 * display. The prefix is applied before quoting, so a cell that also needs quotes carries it inside
 * them.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  const s = FORMULA_LEAD.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serializes rows to CSV (CRLF line endings, RFC-4180 quoting) over the given columns. */
export function toCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<{ key: string; label: string }>,
): string {
  const header = columns.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(",")).join("\r\n");
  return body === "" ? header : `${header}\r\n${body}`;
}
