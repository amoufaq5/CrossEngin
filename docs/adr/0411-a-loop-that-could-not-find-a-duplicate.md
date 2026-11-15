# ADR-0411: A loop that could not find a duplicate

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0337 (a falsely-true control is the failure), ADR-0361 (a report's and a dashboard's roles validated by nobody), ADR-0348 (refusing an incoherent case is free when its population is zero), ADR-0388 (the manifest section census), ADR-0386 (a dead exemption reads as a judgement) |

## Context

Register P1.2 names eight manifest sections that are merged across lineage, hashed into
`manifestHash`, and read by no request path. One of them, `files`, was listed as *validated* on the
strength of `validateFiles`, the eighth of `validateManifest`'s twelve calls. Its whole body was:

```ts
function validateFiles(manifest: Manifest): void {
  const files = manifest.files ?? {};
  const seen = new Set<string>();
  for (const key of Object.keys(files)) {
    if (seen.has(key)) {
      throw new ManifestValidationError(`files.${key}`, `duplicate file type id '${key}'`);
    }
    seen.add(key);
  }
}
```

`Object.keys` never yields a key twice, so the `seen.has` branch is unreachable for every possible
input. The function examined each key and could conclude nothing about any of them. So `files` was
**merge-only in effect and validated in name**, which is the direction this repository ranks worst:
a control that reports success is harder to find than one that is absent, because the next reader
sees a call in the list and stops (ADR-0337).

### The measurement's own remedy, and why it is refused

The pass that measured P1.2 prescribed deleting the dead loop and reclassifying `files` as `unread`,
on the stated ground that *"`FileTypeDeclaration` offers no cross-section rule to replace it with."*

There are two, and each had a **declaration site and no reader**:

| Declaration | State before this change |
|---|---|
| `FileTypeIdSchema` (`@crossengin/files`) | `/^[a-z][a-zA-Z0-9]*$/`, **exactly one occurrence in the workspace: its own definition.** `ManifestSchema.files` keys on a bare `z.string()`, so the camelCase id rule this repo wrote down was enforced by nothing. |
| `retention.compliancePackOverride` | A free `z.string().min(1)`, compared against `manifest.meta.compliancePacks` by nothing. |

The second is `validateViews`' role check one section across, and the same gap ADR-0361 closed for a
report's and a dashboard's `permissions.roles`. So the honest move is to make the control **true**
rather than to withdraw the claim — withdrawing it would have left `files` merge-only with two
available rules unused, and would have deleted the only record that the rules exist.

## Decision

`validateFiles` enforces both, in `packages/kernel/src/manifest/validate.ts`:

```ts
for (const [key, file] of Object.entries(files)) {
  if (!FileTypeIdSchema.safeParse(key).success) {
    throw new ManifestValidationError(
      `files.${key}`,
      `file type id '${key}' must be camelCase starting with a lowercase letter`,
    );
  }
  const override = file.retention.compliancePackOverride;
  if (override !== undefined && !declaredPacks.has(override)) {
    throw new ManifestValidationError(
      `files.${key}.retention.compliancePackOverride`,
      `retention override references compliance pack '${override}' which is not declared in ` +
        `manifest.meta.compliancePacks`,
    );
  }
}
```

Three decisions behind that:

**The id rule is `FileTypeIdSchema.safeParse` and never a local regex.** A second spelling of a
pattern is ADR-0288's maintained list in its cheapest form, and the schema is the only place the
convention is written down — so importing it is also what gives it its first reader.

**The pack check is a *validation error* and not a boot refusal**, on ADR-0348's split: both
properties are decidable from the manifest alone, so a pack author, `crossengin validate`, a pack's
own test suite and the reviewer approving an Architect design can each answer them. A rule
checkable earlier should be.

**Measured cost: zero.** `files` is **absent, not empty**, on all seven resolved packs, so no shipped
declaration changes meaning and nothing that validated before is refused now. That is exactly the
moment a refusal is free (ADR-0348), and a test pins the vacuity rather than asserting it in prose.

## Consequences

A manifest declaring `files` with a `Snake_case` or `kebab-case` id is refused with the path and the
rule, and one whose retention override names a pack `meta.compliancePacks` does not declare is
refused with both names. Both are reachable from a hand-edited proposal and from an AI design that
exceeds the design spec.

Both refusals were mutation-checked: each fires for exactly its own test, the restoration is
byte-identical (`f14e26fedddf1cd50fdb2bcd1ea9c544`), and `packages/kernel` is 836 tests green.

### Two figures corrected, both wrong when written

`git log -S` settles the class, which decides the remedy (ADR-0389): a drifted figure wants
re-measuring, a wrong-when-written one wants its arithmetic checked.

- `sections.ts`' reach doc comment said **thirteen** sections are not served. At `bc91803`, the
  commit that wrote it, the figure was **12**.
- Register P1.2 said **eleven**. At `2b98f46`, the commit that wrote it, the figure was also **12**.

One quantity, two hand-counted figures, **wrong in opposite directions, neither drifted** — and the
arithmetic was free to check against `MANIFEST_SECTION_REACH`, which both sentences sit beside.

## Alternatives

**Delete the loop and reclassify `files` as `unread`** — the measurement's prescription, refused
above. It rests on a premise (`FileTypeDeclaration` offers no rule) that two unread declarations
falsify.

**Leave the loop and note the vacuity in a comment.** This is the shape ADR-0351, ADR-0362,
ADR-0372, ADR-0395 and ADR-0398 each record as *documented the hazard and checked nothing* — five
instances already on file, which is reason enough not to add a sixth.

**Fence the id rule with a regex in `validate.ts`.** Cheaper by one import and a second spelling of
a pattern that already exists, which is ADR-0288's class.

**Enforce `FileTypeIdSchema` in `ManifestSchema` instead**, as `z.record(FileTypeIdSchema, …)`.
Rejected on blast radius: the key type would change for every consumer of `Manifest["files"]`, and
`validateManifest` is where this repo puts cross-section rules — the pack-override half has no
schema-level home at all, since `meta.compliancePacks` is a sibling key.

## Open questions

1. **`files` is still read by no request path**, which is the rest of P1.2 and is unaffected: this
   makes the validation claim true and does not make the section served. Seven sections remain in
   that state, three of them (`customWidgets`, `theme`, `i18n`) validated by nothing at all —
   `validateManifest` is a hand-written sequence of twelve calls that names none of them, which is
   ADR-0288's list in the function that decides what a manifest may say.
2. **`FileTypeDeclaration` carries further unchecked cross-section references.**
   `retention.legalHoldExempt` and the storage-tier fields were not surveyed here; whether any of
   them names something another section declares is the next question for this file.
3. **The id rule is checked and the *value* shape is not.** `FileTypeIdSchema` bounds the key;
   nothing compares a declared MIME type against the storage tier's capabilities, because no tier
   declares any.
