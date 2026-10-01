import { createNodePgConnection, parsePgEnvConfig, MigrationApplier, applyFailures, formatApplyReport } from "@crossengin/kernel-pg";
const conn = createNodePgConnection(parsePgEnvConfig());
const ok = [], bad = [];
const check = (l, c, d = "") => { (c ? ok : bad).push(l); console.log(`${c ? "  ok" : "FAIL"} ${l}${d ? ` — ${d}` : ""}`); };

// A plan whose middle statement fails. The last one is what proves continuation: it creates an
// object, so its existence is observable in the catalog rather than only in the report.
const statements = [
  "CREATE TABLE meta.apl_one (a INTEGER)",
  "CREATE TABLE meta.apl_two (b INTEGER)",
  "ALTER TABLE meta.apl_nonexistent ADD COLUMN c INTEGER",   // fails
  "CREATE TABLE meta.apl_three (d INTEGER)",                  // must still run
  "SELECT 1 FROM meta.apl_also_missing",                      // fails too
  "CREATE TABLE meta.apl_four (e INTEGER)",                   // must still run
];
try {
  // Idempotent start: this script is run more than once while iterating.
  for (const t of ["apl_one", "apl_two", "apl_three", "apl_four"]) {
    await conn.query(`DROP TABLE IF EXISTS meta.${t}`);
  }
  await conn.query("DELETE FROM meta._meta_migrations WHERE statement_sql_excerpt LIKE '%apl_%'");

  const report = await new MigrationApplier({ connection: conn, schema: "meta", statements }).apply();
  console.log(formatApplyReport(report).split("\n").map((l) => "    " + l).join("\n"));
  check("continues past the first failure", report.executed === 4, `executed=${report.executed}`);
  check("reports both failures", report.failed === 2, `failed=${report.failed}`);
  check("nothing is left unattempted when continuing", report.notAttempted === 0, `notAttempted=${report.notAttempted}`);
  check("names the first failure so the reader knows which is the root cause", report.firstFailureAt === 2, String(report.firstFailureAt));
  check("haltedAt stays null, since it did not halt", report.haltedAt === null, String(report.haltedAt));
  check("failures come back in statement order", applyFailures(report).map((f) => f.index).join(",") === "2,4", applyFailures(report).map((f) => f.index).join(","));

  const made = await conn.query("SELECT table_name FROM information_schema.tables WHERE table_schema='meta' AND table_name LIKE 'apl_%' ORDER BY table_name");
  const names = made.rows.map((r) => r.table_name).join(",");
  check("the statements after each failure really ran", names === "apl_four,apl_one,apl_three,apl_two", names);

  const log = await conn.query("SELECT succeeded, error_message FROM meta._meta_migrations WHERE succeeded = false");
  check("each failure is logged as not succeeded, with its error", log.rows.length === 2 && log.rows.every((r) => r.error_message !== null), JSON.stringify(log.rows.map((r) => String(r.error_message).slice(0, 40))));

  // Second pass: the four that worked are skipped, the two that failed are re-attempted.
  const again = await new MigrationApplier({ connection: conn, schema: "meta", statements }).apply();
  check("a second run skips what applied", again.skipped === 4, `skipped=${again.skipped}`);
  check("and re-attempts what failed, rather than treating it as done", again.failed === 2 && again.executed === 0, `failed=${again.failed} executed=${again.executed}`);

  // stopOnFailure, for a caller whose statements build on each other.
  for (const t of ["apl_one", "apl_two", "apl_three", "apl_four"]) {
    await conn.query(`DROP TABLE IF EXISTS meta.${t}`);
  }
  await conn.query("DELETE FROM meta._meta_migrations WHERE statement_sql_excerpt LIKE '%apl_%'");
  const halting = await new MigrationApplier({ connection: conn, schema: "meta", statements, stopOnFailure: true }).apply();
  check("stopOnFailure halts at the first failure", halting.haltedAt === 2 && halting.failed === 1, `haltedAt=${halting.haltedAt} failed=${halting.failed}`);
  check("and reports the rest as not attempted", halting.notAttempted === 3, `notAttempted=${halting.notAttempted}`);
  const after = await conn.query("SELECT table_name FROM information_schema.tables WHERE table_schema='meta' AND table_name LIKE 'apl_%'");
  check("so nothing after the failure ran", after.rows.length === 2, String(after.rows.length));
} finally {
  await conn.close();
}
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) process.exit(1);
