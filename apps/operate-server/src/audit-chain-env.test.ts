import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  ed25519PublicKeyFingerprint,
  generateEd25519Keypair,
} from "@crossengin/crypto";

import {
  AUDIT_CHAIN_KEY_SOURCES,
  AUDIT_CHAIN_REFUSALS,
  AUDIT_CHAIN_SIGNING_KEY_VAR,
  AuditChainFileSchema,
  KEY_SOURCE_EXPOSES_A_LAYER,
  formatAuditChain,
  loadAuditChainFile,
  resolveAuditChain,
  type AuditChainResolution,
} from "./audit-chain-env.js";

const A = generateEd25519Keypair();
const B = generateEd25519Keypair();

const env = (seed?: string): Record<string, string | undefined> =>
  seed === undefined ? {} : { [AUDIT_CHAIN_SIGNING_KEY_VAR]: seed };

function resolved(r: AuditChainResolution) {
  if (r.kind !== "resolved") throw new Error(`expected resolved, got ${r.kind}`);
  return r.material;
}
function refused(r: AuditChainResolution) {
  if (r.kind !== "refused") throw new Error(`expected refused, got ${r.kind}`);
  return r;
}

describe("AuditChainFileSchema", () => {
  it("admits a policy-only file, which the resolved schema refuses", () => {
    // The one shape this module exists to admit: `--audit-chain-config` may now carry the chain's
    // policy with no key in it at all, which is what lets the keypair live only in the environment.
    const parsed = AuditChainFileSchema.parse({ sampleRate: 0.5, actorReference: "svc" });
    expect(parsed.privateKeyBase64).toBeUndefined();
    expect(parsed.sampleRate).toBe(0.5);
    expect(parsed.schema).toBe("meta");
  });

  it("admits the seed alone, since the public half is derived", () => {
    const parsed = AuditChainFileSchema.parse({ privateKeyBase64: A.privateKeyBase64 });
    expect(parsed.privateKeyBase64).toBe(A.privateKeyBase64);
    expect(parsed.publicKeyBase64).toBeUndefined();
  });

  it("still refines a key half that IS supplied, and still refuses an unknown key", () => {
    // `.partial()` relaxes presence and nothing else — the refinement and `.strict()` both survive,
    // which is why the file shape is derived from the real schema rather than hand-written.
    expect(AuditChainFileSchema.safeParse({ privateKeyBase64: "x" }).success).toBe(false);
    expect(AuditChainFileSchema.safeParse({ publicKeyBase64: "not!base64!" }).success).toBe(false);
    const unknown = AuditChainFileSchema.safeParse({ nope: 1 });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues.map((i) => i.code)).toContain("unrecognized_keys");
    }
  });
});

describe("resolveAuditChain", () => {
  it("is not configured when neither source speaks", () => {
    expect(resolveAuditChain({ env: env(), file: null }).kind).toBe("not_configured");
  });

  it("the variable alone turns the chain on, and the public half is derived", () => {
    const material = resolved(resolveAuditChain({ env: env(A.privateKeyBase64), file: null }));
    expect(material.source).toBe("env_only");
    expect(material.config.publicKeyBase64).toBe(A.publicKeyBase64);
    expect(material.fingerprint).toBe(ed25519PublicKeyFingerprint(A.publicKeyBase64));
  });

  it("the derived keypair is byte-identical to a correctly configured one", () => {
    // The migration guarantee: moving a consistent pair from a file to the variable changes no
    // `signingKeyFingerprint` a chain has already recorded.
    const fromFile = resolved(
      resolveAuditChain({
        env: env(),
        file: AuditChainFileSchema.parse({
          privateKeyBase64: A.privateKeyBase64,
          publicKeyBase64: A.publicKeyBase64,
        }),
      }),
    );
    const fromEnv = resolved(resolveAuditChain({ env: env(A.privateKeyBase64), file: null }));
    expect(fromEnv.config.publicKeyBase64).toBe(fromFile.config.publicKeyBase64);
    expect(fromEnv.fingerprint).toBe(fromFile.fingerprint);
  });

  it("keeps a policy-only file's policy when the key comes from the variable", () => {
    const material = resolved(
      resolveAuditChain({
        env: env(A.privateKeyBase64),
        file: AuditChainFileSchema.parse({ sampleRate: 0.25, actorReference: "b8-policy" }),
      }),
    );
    expect(material.source).toBe("env_only");
    expect(material.config.sampleRate).toBe(0.25);
    expect(material.config.actorReference).toBe("b8-policy");
  });

  it("admits both sources when they state the SAME keypair", () => {
    const material = resolved(
      resolveAuditChain({
        env: env(A.privateKeyBase64),
        file: AuditChainFileSchema.parse({ privateKeyBase64: A.privateKeyBase64 }),
      }),
    );
    expect(material.source).toBe("both");
    expect(material.fingerprint).toBe(ed25519PublicKeyFingerprint(A.publicKeyBase64));
  });

  it("refuses two sources that disagree, naming BOTH fingerprints and neither seed", () => {
    // Precedence is what is refused here. A rule picking a winner would make the fingerprint every
    // entry announces depend on a rule nobody reads, and concatenation — ADR-0357's answer for
    // api-key specs — is unavailable because a keypair is not a list.
    const r = refused(
      resolveAuditChain({
        env: env(B.privateKeyBase64),
        file: AuditChainFileSchema.parse({ privateKeyBase64: A.privateKeyBase64 }),
      }),
    );
    expect(r.refusal).toBe("sources_disagree");
    expect(r.detail).toContain(ed25519PublicKeyFingerprint(A.publicKeyBase64));
    expect(r.detail).toContain(ed25519PublicKeyFingerprint(B.publicKeyBase64));
    expect(r.detail).not.toContain(A.privateKeyBase64);
    expect(r.detail).not.toContain(B.privateKeyBase64);
  });

  it("refuses a malformed variable, naming the width and not the value", () => {
    const r = refused(resolveAuditChain({ env: env("REPLACE_WITH_32_BYTES_OF_BASE64"), file: null }));
    expect(r.refusal).toBe("signing_key_malformed");
    expect(r.detail).toContain("32 bytes");
    expect(r.detail).not.toContain("REPLACE_WITH_32_BYTES_OF_BASE64");
  });

  it("refuses the placeholder by SHAPE, so no published-placeholder check is owed", () => {
    // ADR-0377 needed `SECRET_PLACEHOLDER_PREFIX` because an entropy floor cannot see that a
    // placeholder is *published*. A seed's width is exact, so every placeholder shape is refused
    // here without one — asserted rather than reasoned, including a 32-character one that would
    // clear a length floor.
    for (const placeholder of [
      "REPLACE_WITH_32_BYTES_OF_BASE64",
      "REPLACE_WITH_32_PLUS_RANDOM_CHARS",
      "CHANGEME",
      "x".repeat(32),
      "",
    ]) {
      expect(resolveAuditChain({ env: env(placeholder), file: null }).kind).not.toBe("resolved");
    }
  });

  it("refuses a policy-only file with no variable, by name", () => {
    const r = refused(
      resolveAuditChain({ env: env(), file: AuditChainFileSchema.parse({ sampleRate: 1 }) }),
    );
    expect(r.refusal).toBe("private_key_absent");
    expect(r.detail).toContain(AUDIT_CHAIN_SIGNING_KEY_VAR);
  });

  it("refuses a file whose two halves are not a pair, naming which source stated what", () => {
    // `ed25519ChainSigner` refuses this too, and keeps doing so as a backstop for a direct caller.
    // What only this site can say is WHICH source stated the half that does not match.
    const r = refused(
      resolveAuditChain({
        env: env(),
        file: AuditChainFileSchema.parse({
          privateKeyBase64: A.privateKeyBase64,
          publicKeyBase64: B.publicKeyBase64,
        }),
      }),
    );
    expect(r.refusal).toBe("public_half_mismatched");
    expect(r.detail).toContain("--audit-chain-config");
    expect(r.detail).not.toContain(A.privateKeyBase64);
  });

  it("trims the variable, so a trailing newline from a secret file is not a malformed key", () => {
    const material = resolved(
      resolveAuditChain({ env: env(`${A.privateKeyBase64}\n`), file: null }),
    );
    expect(material.source).toBe("env_only");
  });

  it("an empty variable is ABSENT and not malformed", () => {
    // ADR-0365's rule: an empty value is nothing supplied. A compose that interpolates an unset
    // `${AUDIT_CHAIN_SIGNING_KEY:-}` must read as "no chain", not as a refused boot.
    expect(resolveAuditChain({ env: env(""), file: null }).kind).toBe("not_configured");
    expect(resolveAuditChain({ env: env("   "), file: null }).kind).toBe("not_configured");
  });

  it("every refusal has a producer, and every source is reachable", () => {
    // The totality fence both ways: no modelled refusal is unreachable (ADR-0375 — a judgement
    // with no case left is not a judgement) and no source is unproducible.
    const seen = new Set<string>();
    const sources = new Set<string>();
    const cases: { env?: string; file?: unknown }[] = [
      { env: "nope" },
      { file: { sampleRate: 1 } },
      { file: { privateKeyBase64: A.privateKeyBase64, publicKeyBase64: B.publicKeyBase64 } },
      { env: B.privateKeyBase64, file: { privateKeyBase64: A.privateKeyBase64 } },
      { env: A.privateKeyBase64 },
      { file: { privateKeyBase64: A.privateKeyBase64 } },
      { env: A.privateKeyBase64, file: { privateKeyBase64: A.privateKeyBase64 } },
    ];
    for (const c of cases) {
      const r = resolveAuditChain({
        env: env(c.env),
        file: c.file === undefined ? null : AuditChainFileSchema.parse(c.file),
      });
      if (r.kind === "refused") seen.add(r.refusal);
      if (r.kind === "resolved") sources.add(r.material.source);
    }
    expect([...seen].sort()).toEqual([...AUDIT_CHAIN_REFUSALS].sort());
    expect([...sources].sort()).toEqual([...AUDIT_CHAIN_KEY_SOURCES].sort());
  });
});

describe("KEY_SOURCE_EXPOSES_A_LAYER", () => {
  it("is total over the sources, and only the env route is clean", () => {
    expect(Object.keys(KEY_SOURCE_EXPOSES_A_LAYER).sort()).toEqual([...AUDIT_CHAIN_KEY_SOURCES].sort());
    expect(
      AUDIT_CHAIN_KEY_SOURCES.filter((s) => !KEY_SOURCE_EXPOSES_A_LAYER[s]),
    ).toEqual(["env_only"]);
  });
});

describe("formatAuditChain", () => {
  it("says the chain is off and what that costs", () => {
    const line = formatAuditChain({ kind: "not_configured" });
    expect(line).toContain(AUDIT_CHAIN_SIGNING_KEY_VAR);
    expect(line).toContain("unanchored");
  });

  it("names the fingerprint on the enabled line and never the seed", () => {
    const r = resolveAuditChain({ env: env(A.privateKeyBase64), file: null });
    const line = formatAuditChain(r);
    expect(line).toContain(ed25519PublicKeyFingerprint(A.publicKeyBase64));
    expect(line).not.toContain(A.privateKeyBase64);
    // `env_only` is the one source with nothing to warn about, so its line ends at the facts.
    expect(line).not.toContain("docker save");
  });

  it("warns about the pushable layer when the seed came from a file", () => {
    for (const file of [
      { privateKeyBase64: A.privateKeyBase64 },
      { privateKeyBase64: A.privateKeyBase64, publicKeyBase64: A.publicKeyBase64 },
    ]) {
      const line = formatAuditChain(
        resolveAuditChain({ env: env(), file: AuditChainFileSchema.parse(file) }),
      );
      expect(line).toContain("docker save");
      expect(line).toContain(AUDIT_CHAIN_SIGNING_KEY_VAR);
      expect(line).not.toContain(A.privateKeyBase64);
    }
  });

  it("warns on `both` too, because the file still holds a seed", () => {
    const line = formatAuditChain(
      resolveAuditChain({
        env: env(A.privateKeyBase64),
        file: AuditChainFileSchema.parse({ privateKeyBase64: A.privateKeyBase64 }),
      }),
    );
    expect(line).toContain("docker save");
  });

  it("no line, on any arm, contains a seed", () => {
    // A text fence over every reachable arm rather than a convention: ADR-0367's shape, because the
    // next arm is a comment away from interpolating the thing it must not print.
    const arms: AuditChainResolution[] = [
      { kind: "not_configured" },
      resolveAuditChain({ env: env("nope"), file: null }),
      resolveAuditChain({ env: env(), file: AuditChainFileSchema.parse({ sampleRate: 1 }) }),
      resolveAuditChain({
        env: env(),
        file: AuditChainFileSchema.parse({
          privateKeyBase64: A.privateKeyBase64,
          publicKeyBase64: B.publicKeyBase64,
        }),
      }),
      resolveAuditChain({
        env: env(B.privateKeyBase64),
        file: AuditChainFileSchema.parse({ privateKeyBase64: A.privateKeyBase64 }),
      }),
      resolveAuditChain({ env: env(A.privateKeyBase64), file: null }),
      resolveAuditChain({ env: env(), file: AuditChainFileSchema.parse({ privateKeyBase64: A.privateKeyBase64 }) }),
    ];
    expect(arms.length).toBeGreaterThanOrEqual(7);
    for (const arm of arms) {
      const line = formatAuditChain(arm);
      expect(line).not.toContain(A.privateKeyBase64);
      expect(line).not.toContain(B.privateKeyBase64);
      // And not a long prefix of one either, which a naive slice would leave.
      expect(line).not.toContain(A.privateKeyBase64.slice(0, 16));
    }
  });
});

describe("loadAuditChainFile", () => {
  it("reads and validates a policy-only file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-env-"));
    const path = join(dir, "policy.json");
    await writeFile(path, JSON.stringify({ sampleRate: 0.5 }), "utf8");
    const file = await loadAuditChainFile(path);
    expect(file.sampleRate).toBe(0.5);
    expect(file.actorReference).toBe("operate-server");
  });

  it("names the flag and the path on a missing file and on bad JSON", async () => {
    // Kept verbatim from the function this replaces: zod's own message names neither, and the path
    // is what an operator edits (ADR-0364's addendum class).
    await expect(loadAuditChainFile("/no/such.json")).rejects.toThrow(
      /--audit-chain-config: cannot read \/no\/such\.json/,
    );
    const dir = await mkdtemp(join(tmpdir(), "audit-env-"));
    const path = join(dir, "bad.json");
    await writeFile(path, "{not json", "utf8");
    await expect(loadAuditChainFile(path)).rejects.toThrow(
      new RegExp(`--audit-chain-config: invalid JSON in ${path.replace(/[.]/g, "\\.")}`),
    );
  });
});

// The `deploy/.env.example` fence that was here is **deleted** and lives in
// `deployment-defaults.test.ts` instead, which is the one fence over `deploy/` — and not because
// two places is untidy: this copy asserted `toContain(AUDIT_CHAIN_SIGNING_KEY_VAR)`, which passes
// on the variable merely being *mentioned in prose*, so the weaker of two fences over one fact was
// the one in the module that owns the variable. A fence belongs where its subject is, and `deploy/`
// is that file's subject.
