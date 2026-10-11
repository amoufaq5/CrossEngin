import { AEAD_KEY_BYTES, ColumnSecretRefused } from "@crossengin/crypto";
import type { Manifest } from "@crossengin/kernel";
import { encodeKeyset, keysetOf, type CursorKeySource } from "@crossengin/operate-runtime";
import { DATA_CLASSIFICATIONS, isSensitiveDataClass } from "@crossengin/types/meta-schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALLOW_CURSOR_DISCLOSURE_FLAG,
  CURSOR_DISCLOSURE_FIELD_LIMIT,
  CURSOR_DISCLOSURE_MAY_SERVE,
  CURSOR_DISCLOSURE_VERDICTS,
  CURSOR_ENCRYPTION_SECRET_VAR,
  CURSOR_SEALING_MODES,
  buildCursorKeySource,
  decideCursorDisclosure,
  formatCursorDisclosure,
  formatCursorSealing,
  resolveCursorSealing,
  surveySortableClassifiedFields,
  type SortableClassifiedField,
} from "./cursor-encryption.js";
import { BUILTIN_PACK_NAMES, loadBuiltinPack } from "./manifest-source.js";

/** 36 bytes, 20 distinct — comfortably past any floor a derivation secret has. */
const SECRET = "0123456789abcdefghij0123456789abcdef";
/** Five bytes. Short of a 256-bit key's worth of material by any measure. */
const WEAK = "short";
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("CURSOR_SEALING_MODES", () => {
  it("lists the three modes in a stable order", () => {
    expect(CURSOR_SEALING_MODES).toEqual(["sealed", "plaintext_accepted", "absent"]);
  });
});

describe("resolveCursorSealing", () => {
  it("seals when a secret is present", () => {
    const resolved = resolveCursorSealing({ secret: SECRET, allowDisclosure: false });
    expect(resolved.mode).toBe("sealed");
    expect(resolved.sealer).not.toBeNull();
  });

  /**
   * The asymmetry that matters. The flag *accepts* a disclosure; it does not request one, so a
   * deployment holding both — a compose file carrying the flag through a migration — must not be
   * silently downgraded from ciphertext to plaintext by the thing it passed while arranging the
   * key.
   */
  it("still seals when a secret is present and the flag was also passed", () => {
    const resolved = resolveCursorSealing({ secret: SECRET, allowDisclosure: true });
    expect(resolved.mode).toBe("sealed");
    expect(resolved.sealer).not.toBeNull();
  });

  it("accepts the disclosure when there is no secret and the flag was passed", () => {
    const resolved = resolveCursorSealing({ secret: null, allowDisclosure: true });
    expect(resolved.mode).toBe("plaintext_accepted");
    expect(resolved.sealer).toBeNull();
  });

  it("answers absent when there is neither a secret nor the flag", () => {
    const resolved = resolveCursorSealing({ secret: null, allowDisclosure: false });
    expect(resolved.mode).toBe("absent");
    expect(resolved.sealer).toBeNull();
  });

  it("reads an empty or whitespace-only secret as unset rather than as a nought-byte secret", () => {
    // The spelling the column secret's reader already uses. Routing `""` to the parser would
    // answer `too_short` where the true fact is that nothing was set, and the remedy for the two
    // is not the same.
    for (const secret of ["", "   ", "\n\t"]) {
      expect(resolveCursorSealing({ secret, allowDisclosure: false }).mode).toBe("absent");
      expect(resolveCursorSealing({ secret, allowDisclosure: true }).mode).toBe(
        "plaintext_accepted",
      );
    }
  });

  it("returns a sealer only in the sealed mode", () => {
    const sealing = [
      resolveCursorSealing({ secret: SECRET, allowDisclosure: false }),
      resolveCursorSealing({ secret: null, allowDisclosure: true }),
      resolveCursorSealing({ secret: null, allowDisclosure: false }),
    ];
    expect(sealing.filter((s) => s.sealer !== null).map((s) => s.mode)).toEqual(["sealed"]);
  });

  it("refuses a weak secret rather than resolving to a mode that reads as configured", () => {
    // The refusal must not degrade to `absent`: a deployment that supplied a secret and had it
    // rejected has a fixable misconfiguration, and reporting it as "no secret set" would hide
    // the remedy behind the mode whose remedy is a flag.
    expect(() => resolveCursorSealing({ secret: WEAK, allowDisclosure: false })).toThrow();
    expect(() => resolveCursorSealing({ secret: WEAK, allowDisclosure: true })).toThrow();
  });
});

describe("buildCursorKeySource", () => {
  afterEach(() => {
    vi.doUnmock("@crossengin/crypto");
    vi.resetModules();
  });

  /**
   * The whole point of validating eagerly: the refusal lands on the build call, so there is no
   * closure to have failed later on the first page of a list.
   */
  it("refuses a weak secret on the build call, not on first use", () => {
    let source: CursorKeySource | null = null;
    expect(() => {
      source = buildCursorKeySource(WEAK);
    }).toThrow();
    expect(source).toBeNull();
  });

  it("refuses a short secret as too_short, naming the measured figure", () => {
    try {
      buildCursorKeySource(WEAK);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ColumnSecretRefused);
      expect((err as ColumnSecretRefused).reason).toBe("too_short");
    }
  });

  it("refuses a long but uniform secret as too_uniform", () => {
    try {
      buildCursorKeySource("ab".repeat(30));
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as ColumnSecretRefused).reason).toBe("too_uniform");
    }
  });

  it("sends the operator to the cursor secret rather than the column one", () => {
    // The two secrets are separate variables with separate rotation costs, and the refusal class
    // is shared — so a refusal that named the column secret would send an operator to rotate the
    // key holding their PHI at rest.
    try {
      buildCursorKeySource(WEAK);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as Error).message).toContain("cursor");
    }
  });

  it("puts no part of the secret in the refusal message", () => {
    const weak = "zz".repeat(30);
    try {
      buildCursorKeySource(weak);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as Error).message).not.toContain(weak);
      expect((err as Error).message).not.toContain("zzzz");
    }
  });

  it("derives a key of exactly the cipher's key length", () => {
    // Read off `AEAD_KEY_BYTES` rather than written as 32, so this cannot drift from the cipher
    // that consumes it — and a wrong length is a throw inside the sealer on the first page.
    const key = buildCursorKeySource(SECRET)(TENANT_A);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(AEAD_KEY_BYTES);
  });

  it("derives independent keys per tenant", () => {
    const source = buildCursorKeySource(SECRET);
    expect(hex(source(TENANT_A))).not.toBe(hex(source(TENANT_B)));
  });

  it("serves one tenant the identical key across calls", () => {
    const source = buildCursorKeySource(SECRET);
    // Identity and not equality: a cache hit returns the same object, so this fails if the
    // cache is missing while the bytes still agree.
    expect(source(TENANT_A)).toBe(source(TENANT_A));
  });

  it("derives a different key from a different secret", () => {
    const other = `${SECRET}-other-material`;
    expect(hex(buildCursorKeySource(SECRET)(TENANT_A))).not.toBe(
      hex(buildCursorKeySource(other)(TENANT_A)),
    );
  });

  it("derives a different key per generation", () => {
    expect(hex(buildCursorKeySource(SECRET, { generation: 1 })(TENANT_A))).not.toBe(
      hex(buildCursorKeySource(SECRET, { generation: 2 })(TENANT_A)),
    );
  });

  it("treats an omitted generation as the crypto package's default", () => {
    expect(hex(buildCursorKeySource(SECRET)(TENANT_A))).toBe(
      hex(buildCursorKeySource(SECRET, { generation: 1 })(TENANT_A)),
    );
  });

  it("propagates the refusal of an empty tenant id rather than deriving a shared key", () => {
    // A key shared across tenants is one any of them could open, which is the sealing undone.
    const source = buildCursorKeySource(SECRET);
    expect(() => source("")).toThrow();
  });

  it("derives once per tenant and serves the cached key afterwards", async () => {
    const derivedFor: string[] = [];
    vi.doMock("@crossengin/crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@crossengin/crypto")>();
      return {
        ...actual,
        deriveTenantCursorKey: (
          secret: Uint8Array,
          tenantId: string,
          generation?: number,
        ): Uint8Array => {
          derivedFor.push(tenantId);
          return generation === undefined
            ? actual.deriveTenantCursorKey(secret, tenantId)
            : actual.deriveTenantCursorKey(secret, tenantId, generation);
        },
      };
    });
    const mod = await import("./cursor-encryption.js");
    const source = mod.buildCursorKeySource(SECRET);
    source(TENANT_A);
    source(TENANT_A);
    source(TENANT_B);
    source(TENANT_A);
    expect(derivedFor).toEqual([TENANT_A, TENANT_B]);
  });

  it("parses the secret once, before any key is asked for", async () => {
    let parses = 0;
    let derives = 0;
    vi.doMock("@crossengin/crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@crossengin/crypto")>();
      return {
        ...actual,
        parseCursorEncryptionSecret: (raw: string): Uint8Array => {
          parses += 1;
          return actual.parseCursorEncryptionSecret(raw);
        },
        deriveTenantCursorKey: (
          secret: Uint8Array,
          tenantId: string,
          generation?: number,
        ): Uint8Array => {
          derives += 1;
          return generation === undefined
            ? actual.deriveTenantCursorKey(secret, tenantId)
            : actual.deriveTenantCursorKey(secret, tenantId, generation);
        },
      };
    });
    const mod = await import("./cursor-encryption.js");
    const source = mod.buildCursorKeySource(SECRET);
    expect(parses).toBe(1);
    expect(derives).toBe(0);
    source(TENANT_A);
    source(TENANT_B);
    expect(parses).toBe(1);
    expect(derives).toBe(2);
  });
});

describe("formatCursorSealing", () => {
  it("leads with the mode, so a boot log is greppable", () => {
    for (const mode of CURSOR_SEALING_MODES) {
      expect(formatCursorSealing(mode).startsWith(`cursor sealing: ${mode} —`)).toBe(true);
    }
  });

  it("gives every mode its own line", () => {
    const lines = CURSOR_SEALING_MODES.map(formatCursorSealing);
    expect(new Set(lines).size).toBe(CURSOR_SEALING_MODES.length);
  });

  it("names the secret the sealed mode derives from", () => {
    expect(formatCursorSealing("sealed")).toContain(CURSOR_ENCRYPTION_SECRET_VAR);
  });

  it("says sealing is uniform rather than per entity", () => {
    expect(formatCursorSealing("sealed")).toContain("not filtered");
  });

  it("names the flag that was given when a disclosure was accepted", () => {
    const line = formatCursorSealing("plaintext_accepted");
    expect(line).toContain(ALLOW_CURSOR_DISCLOSURE_FLAG);
    expect(line).toContain(CURSOR_ENCRYPTION_SECRET_VAR);
  });

  it("names the refusal the absent mode can produce, and that it is conditional", () => {
    // `absent` is not itself a fault — most manifests withhold no rows — so the line has to say
    // what makes it one rather than reading as a standing warning an operator learns to ignore.
    const line = formatCursorSealing("absent");
    expect(line).toContain("cursor_discloses_withheld_rows");
    expect(line).toContain("only if");
  });

  it("never claims a refusal of its own, because the mode alone does not refuse", () => {
    for (const mode of CURSOR_SEALING_MODES) {
      expect(formatCursorSealing(mode)).not.toContain("REFUSED");
    }
  });
});

/**
 * A manifest carrying one entity, one list view and whatever classification the caller wants on
 * the sorted column. `sortable` defaults to true because that is `listConfigForEntity`'s own
 * default for a visible column (`sortable !== false`), and spelling it out per fixture would hide
 * which tests are about the default and which about an opt-out.
 *
 * `classification: null` is **an unclassified field** and an absent key is `pii` — ADR-0331's
 * distinction, needed here because a destructuring default treats an explicit `undefined` as
 * absent, so `{classification: undefined}` quietly asked for the opposite of what it reads as.
 */
function manifestWith(parts: {
  readonly classification?: (typeof DATA_CLASSIFICATIONS)[number] | null;
  readonly sortable?: boolean;
  readonly hidden?: boolean;
  readonly withView?: boolean;
  readonly columns?: readonly string[];
}): Manifest {
  const { classification = "pii", withView = true } = parts;
  return {
    manifestVersion: "1.0",
    meta: { name: "Fixture", slug: "fixture/pack", version: "1.0.0" },
    entities: [
      {
        name: "Patient",
        fields: [
          { name: "mrn", type: { kind: "text" }, ...(classification !== null ? { classification } : {}) },
          { name: "room", type: { kind: "text" } },
        ],
      },
    ],
    ...(withView
      ? {
          views: {
            patients: {
              kind: "list",
              entity: "Patient",
              columns: (parts.columns ?? ["mrn", "room"]).map((field) => ({
                field,
                ...(field === "mrn" && parts.sortable !== undefined ? { sortable: parts.sortable } : {}),
                ...(field === "mrn" && parts.hidden !== undefined ? { hidden: parts.hidden } : {}),
              })),
            },
          },
        }
      : {}),
  } as Manifest;
}

/** `n` distinct synthetic members, so a truncated render is checkable per member. */
function synthetic(n: number): readonly SortableClassifiedField[] {
  return Array.from({ length: n }, (_, i) => ({
    entity: `E${(i + 1).toString()}`,
    field: `f${(i + 1).toString()}`,
    classification: "pii" as const,
  }));
}

const ONE: readonly SortableClassifiedField[] = [
  { entity: "Patient", field: "mrn", classification: "phi" },
];

describe("the premise: an unsealed cursor carries the sort key's plaintext", () => {
  /**
   * The control for this whole verdict, checked rather than asserted in a comment. `keysetOf` maps
   * over the sort it is given and renders `String(row[field])`, so the field a caller named in
   * `?sort` is the field whose value comes back — and `encodeKeyset` is an encoding, not a token.
   * If either stopped being true the verdict would be describing a disclosure that no longer
   * happens, and nothing else in the suite would notice.
   */
  it("round-trips a classified value out of the encoded cursor", () => {
    const row = { id: "rec_1", mrn: "MRN-SECRET-1", room: "4B" };
    const encoded = encodeKeyset(keysetOf(row, [{ field: "mrn", direction: "asc" }]));
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      k: readonly string[];
    };
    expect(decoded.k).toEqual(["MRN-SECRET-1"]);
  });

  it("carries every declared sort key, not only the first", () => {
    // Why the survey is over the whole sortable set: a multi-key sort discloses each key.
    const keyset = keysetOf({ id: "rec_1", mrn: "MRN-SECRET-1", room: "4B" }, [
      { field: "room", direction: "asc" },
      { field: "mrn", direction: "asc" },
    ]);
    expect(keyset.k).toEqual(["4B", "MRN-SECRET-1"]);
  });
});

describe("surveySortableClassifiedFields", () => {
  it("reports a classified field a visible column makes sortable", () => {
    expect(surveySortableClassifiedFields(manifestWith({}))).toEqual([
      { entity: "Patient", field: "mrn", classification: "pii" },
    ]);
  });

  it("reports nothing when the field carries no classification", () => {
    expect(surveySortableClassifiedFields(manifestWith({ classification: null }))).toEqual([]);
  });

  it("reports nothing when the column opts out of sorting", () => {
    expect(surveySortableClassifiedFields(manifestWith({ sortable: false }))).toEqual([]);
  });

  it("reports nothing when the column is hidden", () => {
    // A hidden column is excluded from `sortableFields` by `listConfigForEntity`, so a caller
    // cannot name it and there is nothing to disclose.
    expect(surveySortableClassifiedFields(manifestWith({ hidden: true }))).toEqual([]);
  });

  it("reports nothing for an entity with no list view, which exposes no sort surface", () => {
    expect(surveySortableClassifiedFields(manifestWith({ withView: false }))).toEqual([]);
  });

  it("reports nothing when the classified field is not among the view's columns", () => {
    expect(surveySortableClassifiedFields(manifestWith({ columns: ["room"] }))).toEqual([]);
  });

  /**
   * The predicate is **classified**, not `isSensitiveDataClass` — ADR-0345's stated reason at a
   * second surface. The widening is vacuous on the shipped packs (asserted below) and is still the
   * right rule, because a tenant's own activated manifest is surveyed by this same function.
   */
  it("reports an internal-classified sortable field, which a sensitive-only predicate would miss", () => {
    const survey = surveySortableClassifiedFields(manifestWith({ classification: "internal" }));
    expect(survey).toEqual([{ entity: "Patient", field: "mrn", classification: "internal" }]);
    expect(isSensitiveDataClass("internal")).toBe(false);
  });

  it("reports every classification the vocabulary has, so none is silently exempt", () => {
    for (const classification of DATA_CLASSIFICATIONS) {
      expect(surveySortableClassifiedFields(manifestWith({ classification }))).toHaveLength(1);
    }
  });

  it("finds a classified field contributed by a trait", () => {
    // `resolvedFields` is what the validator uses, so a trait field is a real column the view can
    // sort by. Surveying `entity.fields` alone would be a blind spot of the shape this fence
    // exists to close.
    const manifest = {
      manifestVersion: "1.0",
      meta: { name: "Fixture", slug: "fixture/pack", version: "1.0.0" },
      traits: [
        { name: "contactable", fields: [{ name: "work_email", type: { kind: "email" }, classification: "pii" }] },
      ],
      entities: [{ name: "Staff", traits: ["contactable"], fields: [{ name: "label", type: { kind: "text" } }] }],
      views: {
        staff: { kind: "list", entity: "Staff", columns: [{ field: "work_email" }, { field: "label" }] },
      },
    } as unknown as Manifest;
    expect(surveySortableClassifiedFields(manifest)).toEqual([
      { entity: "Staff", field: "work_email", classification: "pii" },
    ]);
  });

  it("reports one finding for a field a view declares as two columns", () => {
    // Iterating the resolved fields rather than `sortableFields` is what makes this free: a view
    // may legitimately repeat a field, and two findings would double every count beside it.
    expect(surveySortableClassifiedFields(manifestWith({ columns: ["mrn", "mrn", "room"] }))).toEqual(
      [{ entity: "Patient", field: "mrn", classification: "pii" }],
    );
  });

  it("answers empty for a manifest with no entities at all", () => {
    expect(
      surveySortableClassifiedFields({
        manifestVersion: "1.0",
        meta: { name: "Empty", slug: "empty/pack", version: "1.0.0" },
      } as Manifest),
    ).toEqual([]);
  });
});

describe("surveySortableClassifiedFields over the shipped packs", () => {
  /**
   * The measurement the `mayServe` decision rests on, taken against the real resolved packs rather
   * than a fixture. **Every** pack has a member, so refusing when the sealer is absent would
   * refuse every deployment there is — which is why this verdict reports. If a pack ever loses its
   * last member this fails, and it should: the argument in `CURSOR_DISCLOSURE_MAY_SERVE` would
   * then be describing a world that no longer exists.
   */
  it("finds at least one classified sortable field in every builtin pack", async () => {
    for (const name of BUILTIN_PACK_NAMES) {
      const survey = surveySortableClassifiedFields(await loadBuiltinPack(name));
      expect(survey.length, `pack ${name}`).toBeGreaterThan(0);
    }
  });

  it("finds one in erp-core, which is the shipped compose default", async () => {
    const survey = surveySortableClassifiedFields(await loadBuiltinPack("erp-core"));
    expect(survey).toContainEqual({
      entity: "Employee",
      field: "work_email",
      classification: "pii",
    });
  });

  it("finds Patient.mrn in erp-healthcare, the phi field ADR-0338 made ciphertext at rest", async () => {
    // The sharpest member, and the one a default-sort survey misses entirely: healthcare's
    // `Patient` list sorts by `family_name` by default, so `mrn` is reachable only as a
    // caller-chosen `?sort`.
    const survey = surveySortableClassifiedFields(await loadBuiltinPack("erp-healthcare"));
    expect(survey).toContainEqual({ entity: "Patient", field: "mrn", classification: "phi" });
  });

  /**
   * A floor and not an equality: the figure moves when a pack gains a field, and a test that
   * pinned it would fail on correct code. The floor guards the direction that matters — a survey
   * that stopped matching would report zero and the verdict would go quiet.
   */
  it("finds at least eight distinct members across the seven packs", async () => {
    const distinct = new Set<string>();
    for (const name of BUILTIN_PACK_NAMES) {
      for (const f of surveySortableClassifiedFields(await loadBuiltinPack(name))) {
        distinct.add(`${f.entity}.${f.field}`);
      }
    }
    expect(distinct.size).toBeGreaterThanOrEqual(8);
  });

  it("reports no field value anywhere in the survey, only names and classifications", async () => {
    for (const name of BUILTIN_PACK_NAMES) {
      for (const f of surveySortableClassifiedFields(await loadBuiltinPack(name))) {
        expect(Object.keys(f).sort()).toEqual(["classification", "entity", "field"]);
      }
    }
  });
});

describe("CURSOR_DISCLOSURE_VERDICTS", () => {
  it("lists the four verdicts in a stable order", () => {
    expect(CURSOR_DISCLOSURE_VERDICTS).toEqual([
      "no_sortable_classified_field",
      "sealed",
      "plaintext_accepted",
      "plaintext_disclosing",
    ]);
  });

  it("answers mayServe for every verdict", () => {
    // The map's totality is what makes a fifth verdict a compile error; this asserts no member was
    // left out of the runtime object either.
    expect(Object.keys(CURSOR_DISCLOSURE_MAY_SERVE).sort()).toEqual(
      [...CURSOR_DISCLOSURE_VERDICTS].sort(),
    );
  });

  /**
   * This verdict reports and never refuses, and the reason is measured: every shipped pack has a
   * member, so refusing would refuse the compose default. Pinned here so flipping it is a visible
   * diff against a stated decision rather than a quiet change of grade.
   */
  it("permits a boot for every verdict, including the disclosing one", () => {
    for (const verdict of CURSOR_DISCLOSURE_VERDICTS) {
      expect(CURSOR_DISCLOSURE_MAY_SERVE[verdict]).toBe(true);
    }
  });
});

describe("decideCursorDisclosure", () => {
  it("answers no_sortable_classified_field for every mode when the manifest has none", () => {
    // Checked before the mode: with nothing to disclose, `sealed` would claim a hole was closed
    // that never existed and `plaintext_disclosing` would send an operator to configure a secret
    // for data the manifest does not hold.
    for (const mode of CURSOR_SEALING_MODES) {
      expect(decideCursorDisclosure({ mode, fields: [] }).verdict).toBe(
        "no_sortable_classified_field",
      );
    }
  });

  it("maps each sealing mode to its own verdict once a member exists", () => {
    expect(CURSOR_SEALING_MODES.map((mode) => decideCursorDisclosure({ mode, fields: ONE }).verdict)).toEqual(
      ["sealed", "plaintext_accepted", "plaintext_disclosing"],
    );
  });

  it("reads mayServe off the map rather than deciding it per branch", () => {
    for (const mode of CURSOR_SEALING_MODES) {
      const decision = decideCursorDisclosure({ mode, fields: ONE });
      expect(decision.mayServe).toBe(CURSOR_DISCLOSURE_MAY_SERVE[decision.verdict]);
    }
  });

  it("echoes the surveyed members, so one decision is enough to render the line", () => {
    expect(decideCursorDisclosure({ mode: "absent", fields: ONE }).fields).toEqual(ONE);
  });
});

describe("formatCursorDisclosure", () => {
  const line = (mode: (typeof CURSOR_SEALING_MODES)[number], fields = ONE): string =>
    formatCursorDisclosure(decideCursorDisclosure({ mode, fields }));

  it("leads with the verdict, so a boot log is greppable", () => {
    for (const mode of CURSOR_SEALING_MODES) {
      const decision = decideCursorDisclosure({ mode, fields: ONE });
      expect(formatCursorDisclosure(decision).startsWith(`cursor disclosure: ${decision.verdict} —`)).toBe(
        true,
      );
    }
  });

  it("gives every verdict its own line", () => {
    const lines = new Set([line("sealed"), line("plaintext_accepted"), line("absent"), line("absent", [])]);
    expect(lines.size).toBe(CURSOR_DISCLOSURE_VERDICTS.length);
  });

  /**
   * The affirmative case. "We surveyed and found none" cannot be claimed from the absence of a log
   * line, which is this repo's recurring rule — and this is the line that makes the verdict's
   * vacuity visible on a deployment that has nothing to fix.
   */
  it("says so affirmatively when nothing is sortable and classified", () => {
    const text = line("absent", []);
    expect(text).toContain("no classified field");
    expect(text).not.toContain(CURSOR_ENCRYPTION_SECRET_VAR);
  });

  it("says so affirmatively when the sealer closes it", () => {
    const text = line("sealed");
    expect(text).toContain(CURSOR_ENCRYPTION_SECRET_VAR);
    expect(text).toContain("in the clear");
  });

  it("names the secret as the remedy whenever a member is disclosed", () => {
    for (const mode of ["plaintext_accepted", "absent"] as const) {
      expect(line(mode)).toContain(CURSOR_ENCRYPTION_SECRET_VAR);
    }
  });

  it("names the cursor's construction rather than calling it reversible", () => {
    // An operator weighing the flag has to be able to see for themselves that this is an encoding
    // and not a token.
    expect(line("absent")).toContain("base64url(JSON.stringify(");
  });

  it("names the asymmetry that is the actual finding", () => {
    // That the body redacts and the cursor does not is the whole defect; a line naming only the
    // field would read as a classification notice.
    const text = line("absent");
    expect(text).toContain("redacted");
    expect(text).toContain("two code paths");
  });

  it("says the deployment starts, so the line is not read as a refusal", () => {
    expect(line("absent")).toContain("starts either way");
    for (const mode of CURSOR_SEALING_MODES) {
      expect(line(mode)).not.toContain("REFUSED");
    }
  });

  /**
   * The flag is not this verdict's own: it also accepts `cursor_discloses_withheld_rows`, the
   * refusal about rows the caller was never shown. Saying so is what keeps the line from reading
   * as "pass this and you are done".
   */
  it("warns that the acknowledging flag concedes more than this line asks for", () => {
    const text = line("absent");
    expect(text).toContain(ALLOW_CURSOR_DISCLOSURE_FLAG);
    expect(text).toContain("concedes more");
  });

  it("still says the disclosure out loud once the flag has been passed", () => {
    // ADR-0322's rule: the flag buys a boot, not silence.
    const text = line("plaintext_accepted");
    expect(text).toContain(ALLOW_CURSOR_DISCLOSURE_FLAG);
    expect(text).toContain("Patient.mrn (phi)");
  });

  it("truncates a long member list while keeping the count exact", () => {
    const fields = synthetic(CURSOR_DISCLOSURE_FIELD_LIMIT + 3);
    const text = line("absent", fields);
    expect(text).toContain(`${fields.length.toString()} classified field(s)`);
    expect(text).toContain("(+3 more)");
    expect(text).toContain(`E${CURSOR_DISCLOSURE_FIELD_LIMIT.toString()}.f${CURSOR_DISCLOSURE_FIELD_LIMIT.toString()}`);
    expect(text).not.toContain(`E${(CURSOR_DISCLOSURE_FIELD_LIMIT + 1).toString()}.`);
  });

  it("does not truncate a list that fits", () => {
    expect(line("absent", synthetic(CURSOR_DISCLOSURE_FIELD_LIMIT))).not.toContain("more)");
  });

  it("renders a real pack's survey without naming a value", async () => {
    // The end-to-end shape, on the manifest an operator actually boots.
    const fields = surveySortableClassifiedFields(await loadBuiltinPack("erp-healthcare"));
    const text = formatCursorDisclosure(decideCursorDisclosure({ mode: "absent", fields }));
    expect(text).toContain("cursor disclosure: plaintext_disclosing");
    expect(text).toContain("Patient.mrn (phi)");
    // The field's name and class, never a value: no rendered line may contain an MRN.
    expect(text).not.toMatch(/MRN-/);
  });
});

describe("the two verdicts beside each other", () => {
  /**
   * The row-filtering refusal stays exactly as it was; this is a second verdict, not a
   * replacement. The `absent` sealing line has to keep naming it, because that is the refusal the
   * mode alone can produce.
   */
  it("leaves the sealing line naming cursor_discloses_withheld_rows", () => {
    expect(formatCursorSealing("absent")).toContain("cursor_discloses_withheld_rows");
  });

  it("no longer claims there is nothing for an absent sealer to disclose", () => {
    // That clause was true of rows and false of fields. Two boot lines contradicting each other is
    // worse than either.
    expect(formatCursorSealing("absent")).not.toContain("nothing is withheld");
  });

  it("points the sealing line at the disclosure line", () => {
    expect(formatCursorSealing("absent")).toContain("cursor disclosure");
  });

  it("keeps the two lines distinguishable by prefix", () => {
    // An operator greps one or the other; a shared prefix would make `[cursor]` ambiguous.
    expect(formatCursorSealing("absent").startsWith("cursor sealing:")).toBe(true);
    expect(
      formatCursorDisclosure(decideCursorDisclosure({ mode: "absent", fields: ONE })).startsWith(
        "cursor disclosure:",
      ),
    ).toBe(true);
  });
});
