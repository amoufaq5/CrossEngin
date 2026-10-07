import { describe, expect, it } from "vitest";

import {
  SEALED_CURSOR_PREFIX,
  buildCursorSealer,
  cursorSealAad,
  type CursorSealContext,
} from "./cursor-seal.js";
import { decodeKeyset, encodeKeyset } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

/** One deployment secret, one key for every tenant: the per-tenant source is the app's business. */
const KEY = new Uint8Array(32).fill(7);
const sealer = buildCursorSealer(() => KEY);

/** A real keyset token, so what is sealed is the thing the stores actually produce. */
const PLAIN = encodeKeyset({ k: ["Bea", null], id: "r-2" });

function ctx(over: Partial<CursorSealContext> = {}): CursorSealContext {
  return {
    tenantId: TENANT,
    entity: "Roster",
    sort: [{ field: "name", direction: "asc" }],
    ...over,
  };
}

describe("cursor seal — round trip", () => {
  it("seals and opens, yielding the original token", () => {
    const opened = sealer.open(sealer.seal(PLAIN, ctx()), ctx());
    expect(opened.kind).toBe("opened");
    expect(opened.kind === "opened" ? opened.value : null).toBe(PLAIN);
    // And the recovered token is still a keyset the store can consume — the envelope is the only
    // thing that changed, so nothing below the handler needs to know this exists.
    expect(decodeKeyset(PLAIN)).toEqual({ k: ["Bea", null], id: "r-2" });
  });

  it("carries the version tag at a fixed offset", () => {
    expect(sealer.seal(PLAIN, ctx()).startsWith(SEALED_CURSOR_PREFIX)).toBe(true);
  });

  it("two seals of one cursor differ", () => {
    // Nonce freshness surfacing through this layer: equal ciphertexts for equal plaintexts would
    // make the token itself a stable identifier for a position across pages and callers.
    expect(sealer.seal(PLAIN, ctx())).not.toBe(sealer.seal(PLAIN, ctx()));
  });
});

describe("cursor seal — the disclosure is closed", () => {
  it("a sealed cursor does not parse as a base64url keyset", () => {
    // The pin. Before this the cursor was `base64url(JSON.stringify({k, id}))`, so a caller walking
    // at `limit=1` collected one id per page — including ids of rows the row filter withheld.
    const sealed = sealer.seal(PLAIN, ctx());
    expect(decodeKeyset(sealed)).toBeNull();
    // Not the plaintext token with a tag in front of it, which is the shape a "sealed" cursor would
    // take if the envelope were ever reduced to a label.
    expect(sealed).not.toContain(PLAIN);

    // And nothing keyset-shaped survives even if a reader strips the tag and decodes by hand.
    const body = Buffer.from(sealed.slice(SEALED_CURSOR_PREFIX.length), "base64url").toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    const isKeysetShaped =
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { k?: unknown }).k) &&
      typeof (parsed as { id?: unknown }).id === "string";
    expect(isKeysetShaped).toBe(false);
  });
});

describe("cursor seal — a legacy plaintext cursor passes through", () => {
  it("is reported as plain, with the value unchanged", () => {
    // Accepted so a rollout does not break the walks in flight. Safe because a client can only
    // construct a plaintext cursor whose contents it already knows.
    const opened = sealer.open(PLAIN, ctx());
    expect(opened).toEqual({ kind: "plain", value: PLAIN });
  });

  it("a legacy cursor is not bound to anything", () => {
    // The stated cost: the confinement below reaches sealed cursors only, so the same token opens
    // under every context. Pinned so that `plain` is understood as a gap and not as a binding.
    expect(sealer.open(PLAIN, ctx({ entity: "Ward" })).kind).toBe("plain");
    expect(sealer.open(PLAIN, ctx({ tenantId: OTHER_TENANT })).kind).toBe("plain");
  });
});

describe("cursor seal — a prefixed value that will not open is refused", () => {
  it("refuses a corrupt body rather than reading it as plaintext", () => {
    // `refused` and never `plain`: falling back would decode to nothing and silently restart the
    // walk, so a tampered cursor would answer 200 with page one.
    expect(sealer.open(`${SEALED_CURSOR_PREFIX}not-a-sealed-cursor`, ctx())).toEqual({
      kind: "refused",
      reason: "not_for_this_request",
    });
  });

  it("refuses a flipped byte in an otherwise valid seal", () => {
    // Flipped at the *front* of the body, not the end: base64url's final character can carry unused
    // bits, so editing it may decode to the identical bytes and prove nothing.
    const sealed = sealer.seal(PLAIN, ctx());
    const head = sealed.slice(0, SEALED_CURSOR_PREFIX.length);
    const body = sealed.slice(SEALED_CURSOR_PREFIX.length);
    const first = body.slice(0, 1);
    const flipped = `${head}${first === "A" ? "B" : "A"}${body.slice(1)}`;
    expect(sealer.open(flipped, ctx()).kind).toBe("refused");
  });

  it("refuses an empty body and a bare tag", () => {
    expect(sealer.open(SEALED_CURSOR_PREFIX, ctx()).kind).toBe("refused");
  });

  it("refuses a seal made under a different key", () => {
    const rotated = buildCursorSealer(() => new Uint8Array(32).fill(9));
    expect(sealer.open(rotated.seal(PLAIN, ctx()), ctx()).kind).toBe("refused");
  });
});

describe("cursor seal — the context is three separate bindings", () => {
  it("refuses a cursor sealed for another entity", () => {
    const sealed = sealer.seal(PLAIN, ctx({ entity: "Roster" }));
    expect(sealer.open(sealed, ctx({ entity: "Ward" })).kind).toBe("refused");
  });

  it("refuses a cursor sealed for another tenant", () => {
    const sealed = sealer.seal(PLAIN, ctx({ tenantId: TENANT }));
    expect(sealer.open(sealed, ctx({ tenantId: OTHER_TENANT })).kind).toBe("refused");
  });

  it("refuses a cursor sealed under another sort", () => {
    // Confinement, and a soundness fix with it: `isAfter` compares the cursor's `k[i]` against
    // `sort[i]`'s field, so replaying a cursor under a different `?sort` produced a meaningless
    // keyset comparison. The fix reaches sealed cursors only — the legacy path keeps the hole.
    const sealed = sealer.seal(PLAIN, ctx({ sort: [{ field: "name", direction: "asc" }] }));
    expect(sealer.open(sealed, ctx({ sort: [{ field: "ward", direction: "asc" }] })).kind).toBe(
      "refused",
    );
  });
});

describe("cursorSealAad", () => {
  function aad(over: Partial<CursorSealContext> = {}): string {
    return Buffer.from(cursorSealAad(ctx(over))).toString("utf8");
  }

  it("renders the context as canonical JSON of [tenantId, entity, sortSpec]", () => {
    expect(aad()).toBe(`["${TENANT}","Roster",["name:asc"]]`);
  });

  it("differs for two contexts that differ only in sort direction", () => {
    expect(aad({ sort: [{ field: "name", direction: "asc" }] })).not.toBe(
      aad({ sort: [{ field: "name", direction: "desc" }] }),
    );
  });

  it("sort order matters", () => {
    // `a,b` and `b,a` are different orderings and so different positions; a set-shaped binding
    // would let a cursor from one open under the other.
    const ab: readonly { field: string; direction: "asc" }[] = [
      { field: "a", direction: "asc" },
      { field: "b", direction: "asc" },
    ];
    expect(aad({ sort: ab })).not.toBe(aad({ sort: [...ab].reverse() }));
  });

  it("an empty sort is expressible and binds", () => {
    // The common case — no view default and no `?sort` — so it has to be a context like any other
    // rather than something that skips the binding.
    expect(aad({ sort: [] })).toBe(`["${TENANT}","Roster",[]]`);
    const sealed = sealer.seal(PLAIN, ctx({ sort: [] }));
    expect(sealer.open(sealed, ctx({ sort: [] })).kind).toBe("opened");
    expect(sealer.open(sealed, ctx()).kind).toBe("refused");
  });

  it("is unambiguous where a delimiter-joined form would not be", () => {
    // The reason it is JSON: a `:`-joined string would render these two contexts identically, and
    // then a cursor would open under a request it was not issued for.
    expect(aad({ entity: "A", sort: [{ field: "b:asc", direction: "asc" }] })).not.toBe(
      aad({ entity: "A:b", sort: [{ field: "asc", direction: "asc" }] }),
    );
  });
});
