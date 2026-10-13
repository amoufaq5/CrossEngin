import { describe, expect, it } from "vitest";

import {
  EVENT_NAME_FINDING_KINDS,
  EVENT_NAME_REASONS,
  EventNameDeclarationSchema,
  MANIFEST_EVENT_NAME_DECLARATIONS,
  MISSING_KINDS,
  MISSING_KIND_SHAPES,
  SCAN_DEFECT_KINDS,
  TRIGGER_KINDS,
  TRIGGER_NAME_FIELD,
  auditManifestEventNames,
  grammarAgreement,
  indexPacksBySlug,
  parsePackSources,
  resolvePack,
  scanEventNameSegment,
  scanPackEventFacts,
  type EventNameDeclaration,
  type EventNameFinding,
  type EventNameFindingKind,
  type PackSourceFile,
  type ResolvedPackFacts,
  type ScanDefect,
} from "./manifest-event-names.js";

/* The live scan is one filesystem walk over ~77 pack sources; every suite below shares it. */
const scan = scanPackEventFacts();
const live = auditManifestEventNames({
  packs: scan.packs,
  declarations: MANIFEST_EVENT_NAME_DECLARATIONS,
});

const packBySlug = new Map(scan.packs.map((p) => [p.pack, p]));

function pack(slug: string): ResolvedPackFacts {
  const found = packBySlug.get(slug);
  if (found === undefined) throw new Error(`no scanned pack '${slug}'`);
  return found;
}

function kinds(findings: readonly EventNameFinding[]): readonly EventNameFindingKind[] {
  return [...new Set(findings.map((f) => f.kind))].sort();
}

/*
 * A minimal two-pack fixture, so the rule's own branches are driven without the real packs.
 *
 * The declared name is `invoice.issued`, which is grammar-shaped and unproducible — the shape
 * `erp-core-einvoice-submission` would have after a rename that guessed the verb — because the
 * paths worth driving are the ones a correction reaches, not the two-part spelling every pack
 * already has a declaration for.
 */
function fixturePack(slug: string, targets: readonly string[]): ResolvedPackFacts {
  return {
    pack: slug,
    entities: ["Invoice", "Permit"],
    lifecycles: [{ key: "invoice_lifecycle", entity: "Invoice", targets: [...targets] }],
    producibleEventNames: [
      "invoice.created",
      "invoice.deleted",
      "invoice.updated",
      "permit.created",
      "permit.deleted",
      "permit.updated",
      ...targets.map((t) => `invoice.${t}`),
    ],
    declaredEvents: [{ jobId: "demo-issued", eventName: "invoice.issued", triggerKind: "event" }],
  };
}

const FIXTURE_PACKS: readonly ResolvedPackFacts[] = [
  fixturePack("operate-erp/core", ["sent", "paid"]),
  fixturePack("operate-erp/retail", ["sent", "paid"]),
];

/** The same two packs, after an `issued` transition landed — which is how `overtaken` arises. */
const SERVING_PACKS: readonly ResolvedPackFacts[] = [
  fixturePack("operate-erp/core", ["sent", "paid", "issued"]),
  fixturePack("operate-erp/retail", ["sent", "paid", "issued"]),
];

const WITNESS_FIXTURE: EventNameDeclaration = EventNameDeclarationSchema.parse({
  jobId: "demo-issued",
  eventName: "invoice.issued",
  packs: ["operate-erp/core", "operate-erp/retail"],
  reason: "witness_named_differently",
  witness: "invoice.sent",
  note: "The fixture's invoice lifecycle sends rather than issuing, which is the real pack's shape.",
});

function fixtureAudit(
  declarations: readonly EventNameDeclaration[],
  packs: readonly ResolvedPackFacts[] = FIXTURE_PACKS,
): readonly EventNameFinding[] {
  return auditManifestEventNames({ packs, declarations });
}

/** The declaration with one field replaced, re-parsed so a mutation cannot skip the schema. */
function mutate(
  base: EventNameDeclaration,
  patch: Record<string, unknown>,
): EventNameDeclaration {
  return EventNameDeclarationSchema.parse({ ...base, ...patch });
}

describe("the vocabulary", () => {
  it("gives every reason a declared member, so neither is a branch nothing takes", () => {
    for (const reason of EVENT_NAME_REASONS) {
      expect(
        MANIFEST_EVENT_NAME_DECLARATIONS.filter((d) => d.reason === reason).length,
      ).toBeGreaterThan(0);
    }
  });

  it("gives every missing kind a declared member", () => {
    for (const kind of MISSING_KINDS) {
      expect(
        MANIFEST_EVENT_NAME_DECLARATIONS.filter((d) => d.missingKind === kind).length,
      ).toBeGreaterThan(0);
    }
  });

  it("shapes a missing claim per kind, and refuses the other kind's shape", () => {
    expect(MISSING_KIND_SHAPES.entity.test("Payroll")).toBe(true);
    expect(MISSING_KIND_SHAPES.entity.test("WorkOrder.completed")).toBe(false);
    expect(MISSING_KIND_SHAPES.state.test("WorkOrder.completed")).toBe(true);
    expect(MISSING_KIND_SHAPES.state.test("Payroll")).toBe(false);
  });

  it("names the field each trigger kind holds its event name in", () => {
    expect(TRIGGER_KINDS.map((k) => TRIGGER_NAME_FIELD[k])).toEqual(["eventName", "afterEvent"]);
  });
});

describe("EventNameDeclarationSchema", () => {
  it("accepts every shipped declaration", () => {
    expect(() =>
      MANIFEST_EVENT_NAME_DECLARATIONS.forEach((d) => EventNameDeclarationSchema.parse(d)),
    ).not.toThrow();
  });

  it("refuses a witness on a no_producible_counterpart declaration", () => {
    const missing = MANIFEST_EVENT_NAME_DECLARATIONS.find(
      (d) => d.reason === "no_producible_counterpart",
    );
    expect(() =>
      EventNameDeclarationSchema.parse({ ...missing, witness: "invoice.sent" }),
    ).toThrow(/only a witness_named_differently declaration may name a witness/);
  });

  it("refuses a witness_named_differently declaration with no witness", () => {
    const { witness: _dropped, ...rest } = WITNESS_FIXTURE;
    expect(() => EventNameDeclarationSchema.parse(rest)).toThrow(/must name one/);
  });

  it("refuses a missing claim with no kind to check it against", () => {
    expect(() =>
      EventNameDeclarationSchema.parse({
        ...WITNESS_FIXTURE,
        reason: "no_producible_counterpart",
        witness: undefined,
        missing: "Payroll",
      }),
    ).toThrow(/may name a missing kind/);
  });

  it("refuses a missing claim shaped for the other kind", () => {
    expect(() =>
      EventNameDeclarationSchema.parse({
        ...WITNESS_FIXTURE,
        reason: "no_producible_counterpart",
        witness: undefined,
        missing: "Payroll",
        missingKind: "state",
      }),
    ).toThrow(/a 'state' absence names/);
  });

  it("refuses a witness equal to the declared name", () => {
    expect(() =>
      EventNameDeclarationSchema.parse({ ...WITNESS_FIXTURE, witness: WITNESS_FIXTURE.eventName }),
    ).toThrow(/would claim the name produces itself/);
  });

  it("refuses an empty pack list, since a declaration about no pack adjudicates nothing", () => {
    expect(() => EventNameDeclarationSchema.parse({ ...WITNESS_FIXTURE, packs: [] })).toThrow();
  });

  it("declares each job at most once, so two reasons cannot both pass", () => {
    const ids = MANIFEST_EVENT_NAME_DECLARATIONS.map((d) => d.jobId);
    expect(ids).toEqual([...new Set(ids)]);
  });
});

describe("scanPackEventFacts — the walk", () => {
  it("reads something, so a scan that found nothing cannot pass", () => {
    expect(scan.files).toBeGreaterThan(50);
    expect(scan.packs.length).toBe(7);
  });

  it("reports no defect it could not read", () => {
    expect(scan.defects).toEqual([]);
  });

  it("gives every scan defect kind a reportable shape", () => {
    // No live member by design — the assertion above is that the walk is complete. What this pins
    // is that the vocabulary is a closed set the scan can only report from.
    expect(new Set(SCAN_DEFECT_KINDS).size).toBe(SCAN_DEFECT_KINDS.length);
    for (const defect of scan.defects) expect(SCAN_DEFECT_KINDS).toContain(defect.kind);
  });

  it("agrees with resolveManifest on erp-core: 51 entities, 19 lifecycles, 230 producible names", () => {
    // Measured against the real async `resolveManifest` over the seven built packs, with the
    // grammar re-implemented in a throwaway oracle so a wrong scan could not confirm itself. Exact
    // rather than a floor: a dead `: Entity = {` const would add three names nothing can emit, and
    // over-reporting the producible set is the direction that *under*-reports findings.
    const core = pack("operate-erp/core");
    expect(core.entities.length).toBe(51);
    expect(core.lifecycles.length).toBe(19);
    expect(core.producibleEventNames.length).toBe(230);
  });

  it("decomposes core's 230 as 51 entities x 3 verbs plus 77 transition targets, with no collision", () => {
    const core = pack("operate-erp/core");
    const pairs = new Set(
      core.lifecycles.flatMap((l) => l.targets.map((t) => `${l.entity}|${t}`)),
    );
    expect(pairs.size).toBe(77);
    expect(core.entities.length * 3 + pairs.size).toBe(core.producibleEventNames.length);
  });

  it("reads transition targets and not states, which is an 18-name difference on core alone", () => {
    // `producibleEntityEventNames`' whole content: a state nothing transitions *to* is reached by a
    // create and emits `created`. Core has 95 (entity, state) pairs against 77 (entity, target)
    // ones, so reading `states` would answer 248. `perishablelot.received` is the live member —
    // PerishableLot's initial state — and it is absent from grocery's producible set.
    expect(pack("operate-erp/grocery").producibleEventNames).not.toContain(
      "perishablelot.received",
    );
    expect(pack("operate-erp/grocery").producibleEventNames).toContain("perishablelot.on_shelf");
  });

  it("agrees with resolveManifest on all seven producible-name counts", () => {
    expect(
      Object.fromEntries(scan.packs.map((p) => [p.pack, p.producibleEventNames.length])),
    ).toEqual({
      "operate-erp/construction": 233,
      "operate-erp/core": 230,
      "operate-erp/education": 243,
      "operate-erp/government": 243,
      "operate-erp/grocery": 247,
      "operate-erp/healthcare": 243,
      "operate-erp/retail": 238,
    });
  });

  it("unions to 294 names across the seven packs", () => {
    const union = new Set(scan.packs.flatMap((p) => p.producibleEventNames));
    expect(union.size).toBe(294);
  });

  it("merges workflows by key, so an overlay that re-keys a lifecycle takes its targets away", () => {
    // `mergeContent`'s `workflows: mergeRecord(base, overlay)`. Retail keys its cart -> placed
    // lifecycle `sales_order_lifecycle`, which is core's key, so core's `confirmed` is gone — and
    // construction does the same to `work_order_lifecycle`, which is what makes core's
    // work-order job addressable on six packs and not on the seventh.
    expect(pack("operate-erp/retail").producibleEventNames).toContain("salesorder.placed");
    expect(pack("operate-erp/retail").producibleEventNames).not.toContain("salesorder.confirmed");
    expect(pack("operate-erp/core").producibleEventNames).toContain("salesorder.confirmed");
    expect(pack("operate-erp/core").producibleEventNames).not.toContain("salesorder.placed");
    expect(pack("operate-erp/construction").producibleEventNames).toContain("workorder.done");
    expect(pack("operate-erp/construction").producibleEventNames).not.toContain(
      "workorder.completed",
    );
  });

  it("resolves lineage three deep, so grocery holds retail's lifecycle and core's entities", () => {
    const grocery = pack("operate-erp/grocery");
    expect(grocery.producibleEventNames).toContain("salesorder.placed");
    expect(grocery.producibleEventNames).toContain("invoice.sent");
    expect(grocery.producibleEventNames).toContain("perishablelot.expired");
  });

  it("finds 12 distinct declared event names over 55 (pack, job) instances", () => {
    const instances = scan.packs.flatMap((p) => p.declaredEvents);
    expect(instances.length).toBe(55);
    expect(new Set(instances.map((e) => e.eventName)).size).toBe(12);
  });

  it("finds no delayed trigger, which is why that arm is vacuous and still wired", () => {
    const instances = scan.packs.flatMap((p) => p.declaredEvents);
    expect(instances.filter((e) => e.triggerKind === "delayed")).toEqual([]);
    expect(instances.every((e) => e.triggerKind === "event")).toBe(true);
  });
});

describe("grammarAgreement", () => {
  it("finds every fragment of the grammar in kernel's own source", () => {
    const diverged = grammarAgreement().checks.filter((c) => !c.found);
    expect(diverged).toEqual([]);
  });

  it("checks the three regexes, the three verbs and the join, and nothing vacuous", () => {
    const { checks } = grammarAgreement();
    expect(checks.length).toBe(7);
    expect(checks.every((c) => c.fragment.length > 5)).toBe(true);
  });

  it("computes `found` rather than asserting it, which is only visible on a fragment kernel lacks", () => {
    // Without this, a `found` hardcoded true passes the suite above — measured: that mutation
    // survived 559 of 559 tests.
    expect(grammarAgreement(['replace(/[^a-z0-9]+/g, "-")']).checks).toEqual([
      { fragment: 'replace(/[^a-z0-9]+/g, "-")', found: false },
    ]);
  });

  it("reproduces eventNameSegment on the inputs the live packs cannot reach", () => {
    // Every pack entity is PascalCase (`EntityNameSchema`) and every transition target is
    // snake_case, so the escape and the strip are unreachable from the scan and would drift
    // unnoticed. `x_` is also the one output the transform is not idempotent on.
    expect(scanEventNameSegment("SalesOrder")).toBe("salesorder");
    expect(scanEventNameSegment("in_progress")).toBe("in_progress");
    expect(scanEventNameSegment("Order-Line")).toBe("order_line");
    expect(scanEventNameSegment("2Factor")).toBe("x_2factor");
    expect(scanEventNameSegment("")).toBe("x_");
    expect(scanEventNameSegment("x_")).toBe("x");
  });
});

/*
 * A one-file pack, so each extractor can be driven at shapes the real packs do not reach.
 *
 * `parsePackSources` takes comment-stripped text, so these fixtures carry none.
 */
const FIXTURE_SLUGS = new Map([
  ["DEMO_PACK_SLUG", "operate-erp/demo"],
  ["ERP_CORE_PACK_SLUG", "operate-erp/core"],
]);

function demoPack(body: string): { source: ReturnType<typeof parsePackSources>; defects: ScanDefect[] } {
  const defects: ScanDefect[] = [];
  const files: PackSourceFile[] = [
    {
      file: "packages/pack-erp-demo/src/pack.ts",
      text: `export const DEMO_PACK_SLUG = "operate-erp/demo";\n${body}`,
    },
  ];
  return { source: parsePackSources("@crossengin/pack-erp-demo", files, FIXTURE_SLUGS, defects), defects };
}

const ONE_ENTITY = `
const INVOICE_ENTITY: Entity = { name: "Invoice", fields: [{ name: "total" }] };
export const DEMO_ENTITIES: readonly Entity[] = [INVOICE_ENTITY];
`;

describe("parsePackSources — the extractors", () => {
  it("resolves the entity list through the pack's own array, not every Entity const it finds", () => {
    // The guard M4/M5 proved unpinned: both "take every const" and "drop the unreferenced
    // finding" passed the whole suite, because every const in the real packs is in its array.
    const { source, defects } = demoPack(`
const INVOICE_ENTITY: Entity = { name: "Invoice", fields: [] };
const GHOST_ENTITY: Entity = { name: "Ghost", fields: [] };
export const DEMO_ENTITIES: readonly Entity[] = [INVOICE_ENTITY];
export function buildDemoPack() { return { entities: [...DEMO_ENTITIES] }; }
`);
    expect(source?.entities).toEqual(["Invoice"]);
    expect(defects.map((d) => d.kind)).toEqual(["entity_unreferenced"]);
    expect(defects[0]?.detail).toContain("GHOST_ENTITY");
  });

  it("follows a call over the array, which is how core's withModules() wrapper is reached", () => {
    const { source, defects } = demoPack(`
const INVOICE_ENTITY: Entity = { name: "Invoice", fields: [] };
const DEMO_RAW: readonly Entity[] = [INVOICE_ENTITY];
export const DEMO_ENTITIES: readonly Entity[] = withModules(DEMO_RAW, {});
export function buildDemoPack() { return { entities: [...DEMO_ENTITIES] }; }
`);
    expect(source?.entities).toEqual(["Invoice"]);
    expect(defects).toEqual([]);
  });

  it("reports an entity list it cannot resolve rather than answering an empty one", () => {
    const { source, defects } = demoPack(`
const INVOICE_ENTITY: Entity = { name: "Invoice", fields: [] };
export function buildDemoPack() { return { entities: [...DEMO_ENTITIES] }; }
`);
    expect(source?.entities).toEqual([]);
    expect(defects.map((d) => d.kind)).toEqual(["pack_unresolved", "entity_unreferenced"]);
  });

  it("reads a lifecycle's transition targets and ignores its states and SLAs", () => {
    const { source } = demoPack(`${ONE_ENTITY}
const INVOICE_LIFECYCLE: EntityLifecycleWorkflow = {
  kind: "entityLifecycle",
  entity: "Invoice",
  initialState: "draft",
  states: [{ name: "draft" }, { name: "sent" }, { name: "void" }],
  transitions: [{ name: "send", from: "draft", to: "sent" }],
  slas: [{ name: "fast", from: "draft", to: "void", deadline: "P1D" }],
};
export const DEMO_WORKFLOWS: Readonly<Record<string, Workflow>> = { invoice_lifecycle: INVOICE_LIFECYCLE };
export function buildDemoPack() { return { entities: [...DEMO_ENTITIES] }; }
`);
    expect(source?.lifecycles).toEqual([
      { key: "invoice_lifecycle", entity: "Invoice", targets: ["sent"] },
    ]);
  });

  it("reads the lifecycle(...) factory's entity and its only array of objects", () => {
    const { source } = demoPack(`${ONE_ENTITY}
const INVOICE_LIFECYCLE = lifecycle("Invoice", "state", "draft", ["draft", "sent"], ["void"], [
  { name: "send", from: "draft", to: "sent" },
  { name: "cancel", from: ["draft", "sent"], to: "void" },
]);
export const DEMO_WORKFLOWS: Readonly<Record<string, Workflow>> = { invoice_lifecycle: INVOICE_LIFECYCLE };
export function buildDemoPack() { return { entities: [...DEMO_ENTITIES] }; }
`);
    expect(source?.lifecycles[0]?.targets).toEqual(["sent", "void"]);
  });

  it("reports a workflow key whose lifecycle it could not read, rather than dropping it", () => {
    const { source, defects } = demoPack(`${ONE_ENTITY}
export const DEMO_WORKFLOWS: Readonly<Record<string, Workflow>> = { invoice_lifecycle: INVOICE_LIFECYCLE };
export function buildDemoPack() { return { entities: [...DEMO_ENTITIES] }; }
`);
    expect(source?.lifecycles).toEqual([]);
    expect(defects.map((d) => d.kind)).toEqual(["lifecycle_unparsed"]);
  });

  it("reports two maps keyed the same, since which lifecycle resolves would be a guess", () => {
    const { defects } = demoPack(`${ONE_ENTITY}
const A_LIFECYCLE = lifecycle("Invoice", "state", "draft", ["draft"], [], [{ name: "a", from: "draft", to: "sent" }]);
const B_LIFECYCLE = lifecycle("Invoice", "state", "draft", ["draft"], [], [{ name: "b", from: "draft", to: "paid" }]);
export const ONE_WORKFLOWS: Readonly<Record<string, Workflow>> = { invoice_lifecycle: A_LIFECYCLE };
export const TWO_WORKFLOWS: Readonly<Record<string, Workflow>> = { invoice_lifecycle: B_LIFECYCLE };
export function buildDemoPack() { return { entities: [...DEMO_ENTITIES] }; }
`);
    expect(defects.map((d) => d.kind)).toEqual(["workflow_key_ambiguous"]);
  });

  it("reads both job forms and skips a deprecated declaration", () => {
    const { source } = demoPack(`${ONE_ENTITY}
export const A_JOB: JobDeclaration = { id: "demo-a", trigger: { kind: "event", eventName: "invoice.sent" } };
export const B_JOB = job("demo-b", "B", "desc", delayed("invoice.paid"));
export const C_JOB: JobDeclaration = { id: "demo-c", deprecated: true, trigger: { kind: "event", eventName: "invoice.void" } };
export function buildDemoPack() { return { entities: [...DEMO_ENTITIES] }; }
`);
    expect(source?.declaredEvents).toEqual([
      { jobId: "demo-a", eventName: "invoice.sent", triggerKind: "event" },
      { jobId: "demo-b", eventName: "invoice.paid", triggerKind: "delayed" },
    ]);
  });

  it("reports an event trigger that falls inside no parsed job declaration", () => {
    const { defects } = demoPack(`${ONE_ENTITY}
const TRIGGERS = { late: { kind: "event", eventName: "invoice.sent" } };
export function buildDemoPack() { return { entities: [...DEMO_ENTITIES] }; }
`);
    expect(defects.map((d) => d.kind)).toEqual(["event_trigger_unattributed"]);
  });

  it("reports an extends identifier no pack declares as a slug", () => {
    const { defects } = demoPack(`${ONE_ENTITY}
export function buildDemoPack() { return { meta: { extends: [ERP_MINING_PACK_SLUG] }, entities: [...DEMO_ENTITIES] }; }
`);
    expect(defects.map((d) => d.kind)).toEqual(["pack_unresolved"]);
    expect(defects[0]?.detail).toContain("ERP_MINING_PACK_SLUG");
  });

  it("reports a pack whose own slug constant it cannot find", () => {
    const defects: ScanDefect[] = [];
    const source = parsePackSources(
      "@crossengin/pack-erp-demo",
      [{ file: "packages/pack-erp-demo/src/pack.ts", text: "export const X = 1;" }],
      FIXTURE_SLUGS,
      defects,
    );
    expect(source).toBeNull();
    expect(defects.map((d) => d.kind)).toEqual(["pack_unresolved"]);
  });
});

describe("indexPacksBySlug", () => {
  const demo = {
    slug: "operate-erp/demo",
    parents: [],
    entities: ["Invoice"],
    lifecycles: [],
    declaredEvents: [],
  };

  it("reports two members declaring one slug rather than letting the second replace the first", () => {
    const defects: ScanDefect[] = [];
    const indexed = indexPacksBySlug(
      [
        { member: "@crossengin/pack-erp-demo", source: demo },
        { member: "@crossengin/pack-erp-clone", source: { ...demo, entities: ["Quote"] } },
      ],
      defects,
    );
    expect(indexed.get("operate-erp/demo")?.entities).toEqual(["Invoice"]);
    expect(defects.map((d) => d.kind)).toEqual(["pack_unresolved"]);
    expect(defects[0]?.detail).toContain("pack-erp-clone");
  });

  it("indexes distinct slugs with no defect, which the live seven do", () => {
    const defects: ScanDefect[] = [];
    indexPacksBySlug([{ member: "@crossengin/pack-erp-demo", source: demo }], defects);
    expect(defects).toEqual([]);
    expect(new Set(scan.packs.map((p) => p.pack)).size).toBe(scan.packs.length);
  });
});

describe("resolvePack — the lineage merge", () => {
  const invoice = {
    slug: "operate-erp/core",
    parents: [],
    entities: ["Invoice"],
    lifecycles: [{ key: "invoice_lifecycle", entity: "Invoice", targets: ["sent"] }],
    declaredEvents: [],
  };

  it("lets an overlay's workflow key replace the parent's, dropping its targets", () => {
    const overlay = {
      slug: "operate-erp/demo",
      parents: ["operate-erp/core"],
      entities: [],
      lifecycles: [{ key: "invoice_lifecycle", entity: "Invoice", targets: ["issued"] }],
      declaredEvents: [],
    };
    const facts = resolvePack(overlay, new Map([["operate-erp/core", invoice]]), []);
    expect(facts.producibleEventNames).toContain("invoice.issued");
    expect(facts.producibleEventNames).not.toContain("invoice.sent");
  });

  it("keeps the parent's lifecycle under a different key, so a new workflow adds rather than replaces", () => {
    const overlay = {
      slug: "operate-erp/demo",
      parents: ["operate-erp/core"],
      entities: [],
      lifecycles: [{ key: "invoice_issuance", entity: "Invoice", targets: ["issued"] }],
      declaredEvents: [],
    };
    const facts = resolvePack(overlay, new Map([["operate-erp/core", invoice]]), []);
    expect(facts.producibleEventNames).toContain("invoice.issued");
    expect(facts.producibleEventNames).toContain("invoice.sent");
  });

  it("reports a parent no scanned pack declares rather than resolving a short lineage silently", () => {
    const defects: ScanDefect[] = [];
    const facts = resolvePack(
      { ...invoice, slug: "operate-erp/demo", parents: ["operate-erp/mining"] },
      new Map(),
      defects,
    );
    expect(defects.map((d) => d.kind)).toEqual(["pack_unresolved"]);
    expect(facts.entities).toEqual(["Invoice"]);
  });

  it("reports an extends cycle instead of recursing forever", () => {
    const defects: ScanDefect[] = [];
    const a = { ...invoice, slug: "operate-erp/a", parents: ["operate-erp/b"] };
    const b = { ...invoice, slug: "operate-erp/b", parents: ["operate-erp/a"], entities: ["Quote"] };
    const facts = resolvePack(a, new Map([["operate-erp/b", b]]), defects);
    expect(defects.map((d) => d.kind)).toEqual(["pack_unresolved"]);
    expect(facts.entities).toEqual(["Invoice", "Quote"]);
  });
});

describe("auditManifestEventNames — the live fence", () => {
  it("reports nothing: every declared event name is producible or declared", () => {
    expect(live).toEqual([]);
  });

  it("examined something, so the empty result is not an empty walk", () => {
    const instances = scan.packs.flatMap((p) => p.declaredEvents);
    expect(instances.length).toBeGreaterThan(50);
    expect(MANIFEST_EVENT_NAME_DECLARATIONS.length).toBe(9);
  });

  it("covers 28 of the 55 instances by declaration and the other 27 by a producible name", () => {
    // The four renames cleared 27 instances; the nine declarations cover the residual 28. Derived
    // from the scan rather than restated, so a rename or a declaration moves both halves.
    const declaredFor = new Map(MANIFEST_EVENT_NAME_DECLARATIONS.map((d) => [d.jobId, d]));
    let covered = 0;
    let producible = 0;
    for (const p of scan.packs) {
      const emitted = new Set(p.producibleEventNames);
      for (const event of p.declaredEvents) {
        if (emitted.has(event.eventName)) producible += 1;
        else if (declaredFor.get(event.jobId)?.packs.includes(p.pack) === true) covered += 1;
      }
    }
    expect({ covered, producible }).toEqual({ covered: 28, producible: 27 });
  });

  it("serves the four renamed names on every pack that resolves them", () => {
    for (const renamed of [
      "quote.sent",
      "lead.created",
      "salesorder.fulfilled",
      "workorder.completed",
    ]) {
      const serving = scan.packs.filter((p) => p.producibleEventNames.includes(renamed));
      expect(serving.length).toBeGreaterThan(0);
      // `workorder.completed` is the one that is not universal, and construction is why.
      expect(serving.length).toBe(renamed === "workorder.completed" ? 6 : 7);
    }
  });

  it("holds every declared witness producible on each pack its declaration names", () => {
    for (const d of MANIFEST_EVENT_NAME_DECLARATIONS) {
      if (d.witness === undefined) continue;
      for (const slug of d.packs) {
        expect(pack(slug).producibleEventNames).toContain(d.witness);
      }
    }
  });
});

describe("auditManifestEventNames — reachability", () => {
  it("reports undeclared for an unproducible name nothing adjudicates", () => {
    const findings = fixtureAudit([]);
    expect(kinds(findings)).toEqual(["undeclared"]);
    expect(findings.length).toBe(2);
    expect(findings[0]?.detail).toContain("eventName 'invoice.issued'");
  });

  it("names the field a delayed trigger holds its name in", () => {
    const delayed = FIXTURE_PACKS.map((p) => ({
      ...p,
      declaredEvents: p.declaredEvents.map((e) => ({ ...e, triggerKind: "delayed" as const })),
    }));
    expect(fixtureAudit([], delayed)[0]?.detail).toContain("afterEvent");
  });

  it("reports undeclared when a declaration omits the pack the gap is on", () => {
    const findings = fixtureAudit([mutate(WITNESS_FIXTURE, { packs: ["operate-erp/core"] })]);
    expect(kinds(findings)).toEqual(["undeclared"]);
    expect(findings[0]?.pack).toBe("operate-erp/retail");
    expect(findings[0]?.detail).toContain("it names operate-erp/core");
  });

  it("reports overtaken when a named pack can emit the name after all", () => {
    const findings = fixtureAudit([WITNESS_FIXTURE], SERVING_PACKS);
    expect(kinds(findings)).toEqual(["overtaken"]);
    expect(findings.length).toBe(2);
    expect(findings[0]?.detail).toContain("a gap that has closed");
  });

  it("reports event_name_changed when the job declares a different name now", () => {
    // Both findings, because they are different facts: the name in use is unadjudicated, and here
    // is why. Reading the job id alone would have reported neither.
    const findings = fixtureAudit([mutate(WITNESS_FIXTURE, { eventName: "invoice.cleared" })]);
    expect(kinds(findings)).toEqual(["event_name_changed", "undeclared"]);
    expect(findings.find((f) => f.kind === "event_name_changed")?.detail).toContain(
      "re-made against the name in use",
    );
    expect(findings.find((f) => f.kind === "undeclared")?.detail).toContain(
      "adjudicates 'invoice.cleared' instead",
    );
  });

  it("reports unknown_job for a declaration no pack resolves", () => {
    const findings = fixtureAudit([
      mutate(WITNESS_FIXTURE, { jobId: "demo-absent" }),
      WITNESS_FIXTURE,
    ]);
    expect(kinds(findings)).toEqual(["unknown_job"]);
    expect(findings[0]?.jobId).toBe("demo-absent");
  });

  it("reports unknown_pack for a slug no scanned pack has", () => {
    const findings = fixtureAudit([
      mutate(WITNESS_FIXTURE, {
        packs: ["operate-erp/core", "operate-erp/retail", "operate-erp/mining"],
      }),
    ]);
    expect(kinds(findings)).toEqual(["unknown_pack"]);
    expect(findings[0]?.pack).toBe("operate-erp/mining");
  });

  it("reports duplicate and keeps the first declaration, so one typo is not two reasons", () => {
    const findings = fixtureAudit([
      WITNESS_FIXTURE,
      mutate(WITNESS_FIXTURE, { witness: "invoice.paid" }),
    ]);
    expect(kinds(findings)).toEqual(["duplicate"]);
  });

  it("reports witness_unproducible for a remedy that does not exist", () => {
    const findings = fixtureAudit([mutate(WITNESS_FIXTURE, { witness: "invoice.cleared" })]);
    expect(kinds(findings)).toEqual(["witness_unproducible"]);
    expect(findings[0]?.detail).toContain("names a remedy that does not exist");
  });

  it("reports counterpart_present when a declared-absent entity is there", () => {
    const findings = fixtureAudit([
      mutate(WITNESS_FIXTURE, {
        reason: "no_producible_counterpart",
        witness: undefined,
        missing: "Invoice",
        missingKind: "entity",
      }),
    ]);
    expect(kinds(findings)).toEqual(["counterpart_present"]);
    expect(findings[0]?.detail).toContain("the pack declares that entity");
  });

  it("reports counterpart_present when a declared-absent lifecycle is there", () => {
    const findings = fixtureAudit([
      mutate(WITNESS_FIXTURE, {
        reason: "no_producible_counterpart",
        witness: undefined,
        missing: "Invoice",
        missingKind: "lifecycle",
      }),
    ]);
    expect(findings[0]?.detail).toContain("invoice_lifecycle");
  });

  it("reports counterpart_present when a declared-absent state is a real transition target", () => {
    const findings = fixtureAudit([
      mutate(WITNESS_FIXTURE, {
        reason: "no_producible_counterpart",
        witness: undefined,
        missing: "Invoice.paid",
        missingKind: "state",
      }),
    ]);
    expect(findings[0]?.detail).toContain("transitions to 'paid'");
  });

  it("names the narrower absence when a kind claims the wrong one", () => {
    // A `lifecycle` claim over an entity that does not exist, and a `state` claim over an entity
    // with no lifecycle: both stand as absences and neither names the remedy an owner would act
    // on, which is the whole reason the kind is a field rather than prose.
    const noEntity = fixtureAudit([
      mutate(WITNESS_FIXTURE, {
        reason: "no_producible_counterpart",
        witness: undefined,
        missing: "Payroll",
        missingKind: "lifecycle",
      }),
    ]);
    expect(noEntity[0]?.detail).toContain("the absence is an 'entity' one");
    const noLifecycle = fixtureAudit([
      mutate(WITNESS_FIXTURE, {
        reason: "no_producible_counterpart",
        witness: undefined,
        missing: "Permit.issued",
        missingKind: "state",
      }),
    ]);
    expect(noLifecycle[0]?.detail).toContain("the absence is a 'lifecycle' one");
  });

  it("checks a claim only where the gap is real, so overtaken is the finding to act on", () => {
    // The witness is unproducible *and* the gap has closed. Only `overtaken` is reported: a remedy
    // asserted about a pack that no longer needs the declaration is noise beside the deletion.
    const findings = fixtureAudit(
      [mutate(WITNESS_FIXTURE, { witness: "invoice.cleared" })],
      SERVING_PACKS,
    );
    expect(kinds(findings)).toEqual(["overtaken"]);
  });

  it("keeps every finding kind reachable from a fixture", () => {
    // Derived from the enum rather than a restated list, so a tenth kind fails here until it is
    // either produced by a case above or deliberately pinned as unreachable.
    const reached = new Set<EventNameFindingKind>();
    for (const findings of [
      fixtureAudit([]),
      fixtureAudit([WITNESS_FIXTURE], SERVING_PACKS),
      fixtureAudit([mutate(WITNESS_FIXTURE, { jobId: "demo-absent" }), WITNESS_FIXTURE]),
      fixtureAudit([mutate(WITNESS_FIXTURE, { eventName: "invoice.cleared" })]),
      fixtureAudit([
        mutate(WITNESS_FIXTURE, { packs: [...WITNESS_FIXTURE.packs, "operate-erp/mining"] }),
      ]),
      fixtureAudit([WITNESS_FIXTURE, mutate(WITNESS_FIXTURE, { witness: "invoice.paid" })]),
      fixtureAudit([mutate(WITNESS_FIXTURE, { witness: "invoice.cleared" })]),
      fixtureAudit([
        mutate(WITNESS_FIXTURE, {
          reason: "no_producible_counterpart",
          witness: undefined,
          missing: "Invoice",
          missingKind: "entity",
        }),
      ]),
    ]) {
      for (const finding of findings) reached.add(finding.kind);
    }
    expect([...reached].sort()).toEqual([...EVENT_NAME_FINDING_KINDS].sort());
  });
});
