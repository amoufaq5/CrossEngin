import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { STORELESS_TABLES } from "./pg-storeless-tables.js";
import {
  WEBHOOK_EVENT_DECLARATION_FILE,
  censusWebhookEventProducers,
  readDeclaredWebhookEvents,
  statedWebhookEventFigure,
} from "./webhook-event-producers.js";
import { REPO_ROOT, readWorkspaceSources, type WorkspaceSourceFile } from "./workspace-sql-scan.js";

const file = (path: string, text: string): WorkspaceSourceFile => ({
  package: "@crossengin/x",
  file: path,
  text,
});

describe("readDeclaredWebhookEvents", () => {
  it("reads the members of the as-const array", () => {
    const src = `export const WEBHOOK_EVENTS = [\n  "a.one", // first\n  "b.two",\n] as const;`;
    expect(readDeclaredWebhookEvents(src)).toEqual(["a.one", "b.two"]);
  });

  it("throws rather than answering an empty set", () => {
    expect(() => readDeclaredWebhookEvents("export const OTHER = [] as const;")).toThrow(
      /no longer/,
    );
    expect(() => readDeclaredWebhookEvents("export const WEBHOOK_EVENTS = [] as const;")).toThrow(
      /no members/,
    );
  });
});

describe("censusWebhookEventProducers", () => {
  const declared = ["tenant.created", "billing.invoice_paid"];

  it("counts a quoted literal in any quote style as a producer site", () => {
    const census = censusWebhookEventProducers(declared, [
      file("apps/a/src/x.ts", `emit("tenant.created");`),
      file("apps/a/src/y.ts", "emit(`billing.invoice_paid`);"),
    ]);
    expect(census.produced).toEqual(["tenant.created", "billing.invoice_paid"]);
    expect(census.sites).toHaveLength(2);
  });

  it("ignores the declaration file, comments and a name embedded in longer text", () => {
    const census = censusWebhookEventProducers(declared, [
      file(WEBHOOK_EVENT_DECLARATION_FILE, `const E = ["tenant.created"];`),
      file(
        "apps/a/src/x.ts",
        `// emits "tenant.created" one day\nconst s = "the tenant.created event";`,
      ),
      file("apps/a/src/y.ts", `const t = "xtenant.created";`),
    ]);
    expect(census.sites).toEqual([]);
  });
});

describe("statedWebhookEventFigure", () => {
  it("reads the figure out of a sentence, and answers null when it carries none", () => {
    expect(
      statedWebhookEventFigure("so 0 of the 18 declared WEBHOOK_EVENTS has a producer"),
    ).toEqual({
      produced: 0,
      declared: 18,
    });
    expect(statedWebhookEventFigure("no figure here")).toBeNull();
  });
});

describe("the real workspace", () => {
  const declared = readDeclaredWebhookEvents(
    readFileSync(join(REPO_ROOT, WEBHOOK_EVENT_DECLARATION_FILE), "utf8"),
  );
  const sources = readWorkspaceSources().files;
  const census = censusWebhookEventProducers(declared, sources);

  it("read the declaration and walked the workspace", () => {
    // Floors, so a parse or a walk that collapsed cannot pass as a clean census.
    expect(declared.length).toBeGreaterThanOrEqual(10);
    expect(new Set(declared).size).toBe(declared.length);
    expect(sources.length).toBeGreaterThanOrEqual(700);
    expect(sources.some((s) => s.file === WEBHOOK_EVENT_DECLARATION_FILE)).toBe(true);
  });

  it("the matcher finds every declared event in the declaration file itself", () => {
    // The positive control: the same matcher over the one file that must spell all of them. Without
    // it, a matcher that matched nothing would make the census below read as 'no producer'.
    const declaration = sources.filter((s) => s.file === WEBHOOK_EVENT_DECLARATION_FILE);
    const asIfElsewhere = declaration.map((s) => ({ ...s, file: "control/elsewhere.ts" }));
    expect(censusWebhookEventProducers(declared, asIfElsewhere).produced).toEqual(declared);
  });

  it("the storeless declaration states the census, so the sentence cannot go stale silently", () => {
    const endpoints = STORELESS_TABLES.find((d) => d.table === "meta.webhook_endpoints");
    const stated = statedWebhookEventFigure(endpoints?.consequence ?? "");
    expect(
      stated,
      "meta.webhook_endpoints' consequence must state the producer figure",
    ).not.toBeNull();
    // A producer landing, or a nineteenth event, fails here with the file that did it — update the
    // consequence in pg-storeless-tables.ts to the new figure (and say which model the producer
    // belongs to), rather than this assertion.
    const where = census.sites.map((s) => `${s.event} in ${s.file}`).join(", ");
    expect(
      { produced: census.produced.length, declared: declared.length },
      `census of WEBHOOK_EVENTS producer literals (${where === "" ? "none" : where})`,
    ).toEqual({ produced: stated?.produced, declared: stated?.declared });
  });
});
