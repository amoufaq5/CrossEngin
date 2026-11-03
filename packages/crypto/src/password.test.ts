import { describe, expect, it } from "vitest";

import {
  PASSWORD_HASH_BYTES,
  PASSWORD_KDF,
  PASSWORD_OUTCOME_ADMITS,
  PASSWORD_SALT_BYTES,
  PASSWORD_SCRYPT_DEFAULTS,
  PASSWORD_VERIFY_OUTCOMES,
  type PasswordScryptParams,
  encodePasswordHash,
  hashPassword,
  parsePasswordHash,
  passwordHashIsStale,
  passwordParamsAreDerivable,
  scryptMaxmem,
  spendPasswordWork,
  verifyPassword,
} from "./password.js";

const PEPPER = "a-deployment-pepper-with-plenty-of-distinct-bytes-0123456789";
const PASSWORD = "correct horse battery staple";

// Every test but the two that name the shipped parameters runs at N=2^10, which is ~4 ms against
// ~130 ms at the default. At the default a file this size would roughly double this package's
// whole suite, and none of the logic under test depends on the cost -- but *something* has to
// exercise the shipped set, so two tests below deliberately pay for it rather than leaving the
// production parameters unexercised.
const CHEAP: PasswordScryptParams = { n: 1024, r: 8, p: 1 };
const FIXED_SALT = Buffer.alloc(PASSWORD_SALT_BYTES, 0x2b);

describe("password constants", () => {
  it("names one KDF and three outcomes", () => {
    expect(PASSWORD_KDF).toBe("scrypt");
    expect(PASSWORD_VERIFY_OUTCOMES).toEqual(["matched", "mismatched", "unreadable_hash"]);
  });

  it("admits on exactly one outcome", () => {
    // A map and not `=== "matched"`, so a fourth outcome is a compile error at the one place that
    // decides rather than a new member inheriting an if-chain's last branch.
    expect(PASSWORD_OUTCOME_ADMITS.matched).toBe(true);
    const admitting = PASSWORD_VERIFY_OUTCOMES.filter((o) => PASSWORD_OUTCOME_ADMITS[o]);
    expect(admitting).toEqual(["matched"]);
  });

  it("defaults to N=2^15, r=8, p=1", () => {
    expect(PASSWORD_SCRYPT_DEFAULTS).toEqual({ n: 32768, r: 8, p: 1 });
    expect(Math.log2(PASSWORD_SCRYPT_DEFAULTS.n)).toBe(15);
  });

  it("pins the salt and hash widths the column CHECK encodes as hex", () => {
    expect(PASSWORD_SALT_BYTES * 2).toBe(32);
    expect(PASSWORD_HASH_BYTES * 2).toBe(128);
  });
});

describe("scryptMaxmem", () => {
  // The whole reason this function exists: node's default ceiling is 32 MiB and the real
  // requirement is 128*r*(N+p+2), which at the default parameters is 3,072 bytes ABOVE
  // 128*N*r -- and 128*N*r at N=2^15, r=8 is exactly the ceiling. So the default parameters
  // need an explicit maxmem, and one computed from the documented formula would still fail.
  const NODE_DEFAULT_MAXMEM = 32 * 1024 * 1024;

  it("the default parameters require more than node's default ceiling", () => {
    const { n, r, p } = PASSWORD_SCRYPT_DEFAULTS;
    const measuredMinimum = 128 * r * (n + p + 2);
    expect(128 * n * r).toBe(NODE_DEFAULT_MAXMEM);
    expect(measuredMinimum).toBeGreaterThan(NODE_DEFAULT_MAXMEM);
    expect(measuredMinimum - 128 * n * r).toBe(3072);
  });

  it("clears the measured minimum with headroom at every parameter set", () => {
    // `p` is in the loop since ADR-0398, and its absence was the defect: the title said "every
    // parameter set" while the loop varied two of three and hardcoded `p = 1`, which is precisely
    // the slice on which the old `256 * n * r` happened to be sufficient. The requirement the
    // comment above already states correctly, `128*r*(n+p+2)`, crosses `256*n*r` at `n = p + 2`.
    for (const n of [2, 4, 1024, 16384, 32768, 65536, 131072]) {
      for (const r of [1, 8, 16]) {
        for (const p of [1, 2, 8, n, n + 4]) {
          expect(scryptMaxmem(n, r, p)).toBeGreaterThan(128 * r * (n + p + 2));
        }
      }
    }
  });

  it("every parameter set the predicate admits can actually derive", async () => {
    // The assertion above is pure arithmetic: it compares `scryptMaxmem` against a formula written
    // in this file and never calls `scrypt`. That is how ADR-0398 shipped a predicate admitting
    // **127** sets that throw at any `maxmem` -- `r = 1` with `n >= 2^16`, refused by RFC 7914 §6's
    // `N < 2^(16*r)` and reported by OpenSSL under the *memory-limit* error code. 10 of that loop's
    // own 105 members were in that state while it passed, which is this repo's
    // documented-the-hazard-and-checked-nothing shape for the fifth time.
    //
    // So this one derives. Small `n` only, because the point is the **shape** boundary rather than
    // cost: `r = 1` at `n = 2^15` is the largest admitted `r = 1` set and the pairs either side of
    // the cap are what the clause is about.
    const probes: readonly (readonly [number, number, number])[] = [
      [2, 1, 1], // the degenerate corner the maxmem fix closed
      [2, 8, 1],
      [4, 1, 2], // where the old and new maxmem forms are exactly equal
      [32768, 1, 1], // the largest n an r=1 set may carry
      [1024, 8, 8],
      [32768, 8, 1], // the shipped defaults
    ];
    for (const [n, r, p] of probes) {
      expect(passwordParamsAreDerivable({ n, r, p }), `admits ${n}/${r}/${p}`).toBe(true);
      const encoded = await hashPassword("pw", PEPPER, { params: { n, r, p } });
      expect(await verifyPassword("pw", encoded, PEPPER), `derives ${n}/${r}/${p}`).toBe("matched");
    }
  });

  it("refuses an n beyond RFC 7914's 2^(16*r), which throws at any maxmem", async () => {
    // `scrypt` throws **synchronously** here rather than calling back with an error, and under
    // `error:030000AC … memory limit exceeded` -- so it reads as a `maxmem` problem and is not one.
    // Measured at `maxmem: Number.MAX_SAFE_INTEGER`: `n=65536, r=1` throws, `n=32768, r=1` does not.
    for (const [n, r, p] of [
      [65536, 1, 1],
      [131072, 1, 1],
      [4194304, 1, 1],
    ] as const) {
      expect(passwordParamsAreDerivable({ n, r, p }), `refuses ${n}/${r}/${p}`).toBe(false);
      expect(parsePasswordHash(`scrypt$${n}$${r}$${p}$${"a".repeat(32)}$${"b".repeat(128)}`)).toBeNull();
    }
    // And the clause is not a blanket ban on those `n`: the same sizes are fine at `r >= 2`, where
    // the bound is 2^32 and the work ceiling is what decides.
    expect(passwordParamsAreDerivable({ n: 65536, r: 2, p: 1 })).toBe(true);
    expect(passwordParamsAreDerivable({ n: 131072, r: 8, p: 1 })).toBe(true);
  });

  it("the old form was below the requirement for n < p + 2, which is where n=2 sat", () => {
    // The boundary, measured against real `scrypt` on Node v22.23.4: `n=2, r=1, p=1` threw
    // `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` under `256*n*r` and answers in 0 ms under this form;
    // `n=4, r=1, p=1` worked under both. Same boundary at larger `p`: `n=1024, p=1024` threw and
    // `n=2048, p=1024` did not.
    const oldForm = (n: number, r: number): number => 256 * n * r;
    for (const [n, r, p] of [
      [2, 1, 1],
      [2, 8, 1],
      [1024, 8, 1024],
    ] as const) {
      expect(oldForm(n, r)).toBeLessThan(128 * r * (n + p + 2));
      expect(scryptMaxmem(n, r, p)).toBeGreaterThan(128 * r * (n + p + 2));
    }
    // And it is a no-op where every real hash lives: 6,144 bytes of extra allowance at the
    // shipped defaults, which is why the correction carries no behaviour change for them.
    const { n, r, p } = PASSWORD_SCRYPT_DEFAULTS;
    expect(scryptMaxmem(n, r, p) - oldForm(n, r)).toBe(6144);
  });

  it("the default parameters really do derive, which is what the headroom buys", async () => {
    // Pays the ~130 ms deliberately: this is the one place the shipped parameter set is proved to
    // work rather than assumed, and it is the exact call that throws without `maxmem`.
    const hash = await hashPassword(PASSWORD, PEPPER);
    expect(parsePasswordHash(hash)?.params).toEqual(PASSWORD_SCRYPT_DEFAULTS);
  });
});

describe("encode / parse", () => {
  it("round-trips", () => {
    const parsed = {
      kdf: PASSWORD_KDF,
      params: CHEAP,
      saltHex: "a".repeat(32),
      hashHex: "b".repeat(128),
    } as const;
    const encoded = encodePasswordHash(parsed);
    expect(encoded).toBe(`scrypt$1024$8$1$${"a".repeat(32)}$${"b".repeat(128)}`);
    expect(parsePasswordHash(encoded)).toEqual(parsed);
  });

  it("answers null and never throws for anything it did not produce", () => {
    for (const bad of [
      "",
      "not-a-hash",
      // A bare sha256 is the shape the rest of the catalog stores and is NOT a password hash.
      "a".repeat(64),
      `sha256$1024$8$1$${"a".repeat(32)}$${"b".repeat(128)}`,
      `scrypt$1024$8$1$${"a".repeat(31)}$${"b".repeat(128)}`, // short salt
      `scrypt$1024$8$1$${"a".repeat(32)}$${"b".repeat(127)}`, // short hash
      `scrypt$1024$8$1$${"A".repeat(32)}$${"b".repeat(128)}`, // uppercase hex
      `scrypt$1024$8$${"1"}$${"a".repeat(32)}$${"b".repeat(128)}extra`,
      `scrypt$1024$8$1$${"a".repeat(32)}`, // truncated
    ]) {
      expect(parsePasswordHash(bad), bad.slice(0, 40)).toBeNull();
    }
  });

  it("refuses parameters it could not re-derive under", () => {
    // Not a mismatch and not a throw: a degenerate stored parameter is `unreadable_hash`, because
    // telling the caller their password was wrong would be a different and false claim.
    const salt = "a".repeat(32);
    const hash = "b".repeat(128);
    expect(parsePasswordHash(`scrypt$1000$8$1$${salt}$${hash}`)).toBeNull(); // N not a power of 2
    expect(parsePasswordHash(`scrypt$1$8$1$${salt}$${hash}`)).toBeNull(); // N < 2
    expect(parsePasswordHash(`scrypt$1024$0$1$${salt}$${hash}`)).toBeNull(); // r = 0
    expect(parsePasswordHash(`scrypt$1024$8$0$${salt}$${hash}`)).toBeNull(); // p = 0
  });

  it("refuses a parameter set whose cost this build will not pay", () => {
    // ADR-0398. The column's CHECK is `[0-9]+` three times, so every one of these stores; what
    // refuses them is this parse. Measured costs on 4 cores at the shipped n=2^15, r=8:
    // p=512 is 29.8 s at 34.1 MB and p=1024 is 60.7 s at 34.6 MB -- linear in `p` and flat in
    // memory, so `p` is the lever and it is the one ADR-0395 did not name.
    const salt = "a".repeat(32);
    const hash = "b".repeat(128);
    const at = (n: number, r: number, p: number): string =>
      `scrypt$${n.toString()}$${r.toString()}$${p.toString()}$${salt}$${hash}`;

    expect(parsePasswordHash(at(32768, 8, 512))).toBeNull(); // 29.8 s measured, 34 MB
    expect(parsePasswordHash(at(32768, 8, 99999999))).toBeNull(); // ~19 days, storable today
    expect(parsePasswordHash(at(32768, 1024, 1))).toBeNull(); // 4.3 GB
    expect(parsePasswordHash(at(16777216, 8, 1))).toBeNull(); // 17 GB

    // And admits every parameter set a real deployment can hold: the shipped defaults, the two
    // weaker sets this suite's own fixtures use, and OWASP's N=2^17 floor the module's cost table
    // prices at ~700 ms -- which is the band the 16x ceiling exists to keep open.
    expect(parsePasswordHash(at(32768, 8, 1))).not.toBeNull();
    expect(parsePasswordHash(at(16384, 8, 1))).not.toBeNull();
    expect(parsePasswordHash(at(512, 8, 1))).not.toBeNull();
    expect(parsePasswordHash(at(131072, 8, 1))).not.toBeNull();
  });

  it("n=2 round-trips, which it could not before the maxmem correction", async () => {
    // The sharper half of ADR-0398. `n=2, p=1` satisfied every clause of the floor -- integer,
    // >= 2, a power of two -- so `parsePasswordHash` called it re-derivable, and `deriveScrypt`
    // threw `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` because `256*n*r` sat below the requirement for
    // `n < p + 2`. A throw out of `verifyPassword` is not `unreadable_hash`: it propagates to the
    // login route's `ctx.verify` catch and answers a retryable 503 claiming the credential
    // directory was unreachable -- a false diagnosis that also bypasses the `credential_unreadable`
    // 401 built for exactly this row.
    //
    // The fix is the formula, not a higher floor, and this proves the whole path: the row parses,
    // and the derivation it promised now actually happens.
    const encoded = await hashPassword("pw", PEPPER, { params: { n: 2, r: 1, p: 1 } });
    expect(parsePasswordHash(encoded)?.params).toEqual({ n: 2, r: 1, p: 1 });
    expect(await verifyPassword("pw", encoded, PEPPER)).toBe("matched");
    expect(await verifyPassword("nope", encoded, PEPPER)).toBe("mismatched");
  });

  it("imposes no work FLOOR, because a weak stored hash is upgraded by the login it allows", () => {
    // Deliberate, and the one place this parse is permissive where the write path is strict --
    // ADR-0348's `update` / `read` asymmetry, read the other way round. A floor would refuse a
    // credential that works today, and `passwordHashIsStale` plus the login's `rehashTo` already
    // answer a weak row by accepting it once and re-deriving under the deployment's current
    // parameters. Refusing it instead would deny the very login that performs the upgrade, so the
    // floor here is *derivability* and strength is the write path's business.
    //
    // The cost of that permissiveness is a timing oracle while the weak row stands, and it is
    // measured rather than reasoned: live against the real route on PG 16.15, an `n=2` row refuses
    // a wrong password in **10 ms** against an 82-87 ms floor for every other refusal -- ~8.5x
    // cheaper, which is what tells a guesser the row is weak. The ratio is the durable form and
    // "~0 ms" is not: once scrypt is free the HMAC and the round trip dominate, so the absolute
    // figure is a property of the host.
    //
    // It closes itself on the **first successful login** -- the same run measured the correct
    // password at 88 ms, the column move from `n=2` to the shipped 32768, and the next wrong
    // password back at the full 87 ms. So the window is open until the legitimate holder
    // authenticates once, and permanently open only for an account nobody ever signs in as.
    // Saying it is open full stop overstates the exposure; saying a floor would close it inverts
    // the remedy, because the floor denies the login that performs the upgrade.
    const salt = "a".repeat(32);
    const hash = "b".repeat(128);
    expect(parsePasswordHash(`scrypt$2$1$1$${salt}$${hash}`)).not.toBeNull();
    expect(passwordHashIsStale(`scrypt$2$1$1$${salt}$${hash}`)).toBe(true);
  });

  it("refuses a caller's own hostile parameters at the write, with a message naming them", async () => {
    // A throw and not a `null`, at the salt-length guard's position: a caller supplying parameters
    // has made a mistake it can fix, where a *stored* row is a fact the reader must absorb.
    await expect(
      hashPassword("pw", PEPPER, { params: { n: 32768, r: 8, p: 512 } }),
    ).rejects.toThrow(/outside this build's bounds: n=32768 r=8 p=512/);
    await expect(hashPassword("pw", PEPPER, { params: { n: 32768, r: 1024, p: 1 } })).rejects.toThrow(
      /outside this build's bounds/,
    );
    // The shipped defaults are not refused, which is the non-vacuity floor for the two above.
    await expect(
      hashPassword("pw", PEPPER, { params: PASSWORD_SCRYPT_DEFAULTS }),
    ).resolves.toMatch(/^scrypt\$32768\$8\$1\$/);
  });

  it("the write path and the read path refuse the same parameter sets", () => {
    // One predicate, two readers. A set `hashPassword` accepts and `parsePasswordHash` refuses
    // would be a row this binary wrote and calls unreadable, which is the shape the shared
    // predicate makes unrepresentable -- asserted rather than assumed, over the band and past it.
    const salt = "a".repeat(32);
    const hash = "b".repeat(128);
    for (const params of [
      { n: 32768, r: 8, p: 1 },
      { n: 512, r: 8, p: 1 },
      { n: 131072, r: 8, p: 1 },
      { n: 2, r: 1, p: 1 },
      { n: 32768, r: 8, p: 512 },
      { n: 32768, r: 1024, p: 1 },
      { n: 1000, r: 8, p: 1 },
    ]) {
      const encoded = `scrypt$${params.n.toString()}$${params.r.toString()}$${params.p.toString()}$${salt}$${hash}`;
      expect(passwordParamsAreDerivable(params)).toBe(parsePasswordHash(encoded) !== null);
    }
  });

  it("matches the shape META_USERS.credential_hash constrains", () => {
    // The same regex the catalog carries. Pinned here so the two cannot drift: a hash this module
    // produces that the column refuses would be a 23514 on every password set.
    const columnCheck = /^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[0-9a-f]{32}\$[0-9a-f]{128}$/;
    const encoded = encodePasswordHash({
      kdf: PASSWORD_KDF,
      params: PASSWORD_SCRYPT_DEFAULTS,
      saltHex: FIXED_SALT.toString("hex"),
      hashHex: "c".repeat(128),
    });
    expect(encoded).toMatch(columnCheck);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("verifies the password it hashed", async () => {
    const hash = await hashPassword(PASSWORD, PEPPER, { params: CHEAP });
    await expect(verifyPassword(PASSWORD, hash, PEPPER)).resolves.toBe("matched");
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword(PASSWORD, PEPPER, { params: CHEAP });
    await expect(verifyPassword(`${PASSWORD}!`, hash, PEPPER)).resolves.toBe("mismatched");
    await expect(verifyPassword("", hash, PEPPER)).resolves.toBe("mismatched");
  });

  it("rejects the right password under a different pepper", async () => {
    // The point of the pepper: a stolen `meta.users` row is not enough, because the deployment
    // secret is not in the database.
    const hash = await hashPassword(PASSWORD, PEPPER, { params: CHEAP });
    await expect(
      verifyPassword(PASSWORD, hash, `${PEPPER}-different`),
    ).resolves.toBe("mismatched");
  });

  it("answers unreadable_hash rather than mismatched for a foreign format", async () => {
    // Distinct outcomes because the caller must not count this as a failed attempt -- a corrupt
    // row would otherwise lock out an account whose password was typed correctly.
    await expect(verifyPassword(PASSWORD, "a".repeat(64), PEPPER)).resolves.toBe("unreadable_hash");
    await expect(verifyPassword(PASSWORD, "", PEPPER)).resolves.toBe("unreadable_hash");
  });

  it("salts, so one password hashed twice differs", async () => {
    const a = await hashPassword(PASSWORD, PEPPER, { params: CHEAP });
    const b = await hashPassword(PASSWORD, PEPPER, { params: CHEAP });
    expect(a).not.toBe(b);
    expect(parsePasswordHash(a)?.saltHex).not.toBe(parsePasswordHash(b)?.saltHex);
    await expect(verifyPassword(PASSWORD, a, PEPPER)).resolves.toBe("matched");
    await expect(verifyPassword(PASSWORD, b, PEPPER)).resolves.toBe("matched");
  });

  it("verifies under the hash's own parameters, not today's defaults", async () => {
    // This is what makes raising the floor safe, and it is why the parameters are in the string
    // rather than in a sibling column or a constant.
    const old = await hashPassword(PASSWORD, PEPPER, { params: { n: 512, r: 8, p: 1 } });
    expect(parsePasswordHash(old)?.params.n).toBe(512);
    await expect(verifyPassword(PASSWORD, old, PEPPER)).resolves.toBe("matched");
  });

  it("refuses a salt of the wrong width", async () => {
    await expect(
      hashPassword(PASSWORD, PEPPER, { params: CHEAP, salt: Buffer.alloc(8, 1) }),
    ).rejects.toThrow(/salt must be 16 bytes/);
  });

  it("imposes no floor on the password itself", async () => {
    // The deployment secret has a floor (`parseCredentialPepper`); a user's password deliberately
    // does not. A 32-byte, 16-distinct-byte minimum is a sane rule for a secret an operator
    // generates and a hostile one for a person.
    for (const weak of ["a", "1234", "aaaaaaaa"]) {
      const hash = await hashPassword(weak, PEPPER, { params: CHEAP });
      await expect(verifyPassword(weak, hash, PEPPER)).resolves.toBe("matched");
    }
  });

  it("matches a pinned known-answer vector", async () => {
    // Pinned as a literal, following `key-derivation.test.ts`: the parameters are stored per hash
    // so raising them breaks nothing, but changing the *construction* -- the pepper HMAC, the salt
    // handling, the output width -- makes every stored credential unverifiable. Editing this
    // literal is the deliberate act that says a forced password reset was considered.
    const hash = await hashPassword(PASSWORD, PEPPER, { params: CHEAP, salt: FIXED_SALT });
    expect(hash).toBe(
      "scrypt$1024$8$1$2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b$" +
        "0f564d034e8e6afff0ca79a7a92b36b27c11d836b1bc4d260cb9082b7795f0ad" +
        "9dc17093cfe79fa7be8c04a8fb8075ed51a15170ba35b8d80f698e3d3b11f662",
    );
  });
});

describe("spendPasswordWork", () => {
  it("answers mismatched and costs a derivation", async () => {
    await expect(spendPasswordWork(PASSWORD, PEPPER, CHEAP)).resolves.toBe("mismatched");
  });

  it("is indistinguishable in outcome from a wrong password", async () => {
    // An unauthenticated caller must not be able to tell `no such email` from `wrong password`,
    // and the outcome is the first half of that; the cost is the second.
    const hash = await hashPassword(PASSWORD, PEPPER, { params: CHEAP });
    const wrong = await verifyPassword("nope", hash, PEPPER);
    const absent = await spendPasswordWork("nope", PEPPER, CHEAP);
    expect(absent).toBe(wrong);
  });

  it("derives under the parameters it is given", async () => {
    // A fixed dummy cost would equalise today and diverge the moment the floor rose, bringing the
    // oracle back silently in a deployment that had already tested this. Proved by cost: the
    // default set is measurably dearer than the cheap one.
    const t0 = process.hrtime.bigint();
    await spendPasswordWork(PASSWORD, PEPPER, CHEAP);
    const cheapMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    await spendPasswordWork(PASSWORD, PEPPER, PASSWORD_SCRYPT_DEFAULTS);
    const defaultMs = Number(process.hrtime.bigint() - t1) / 1e6;
    expect(defaultMs).toBeGreaterThan(cheapMs);
  });
});

describe("passwordHashIsStale", () => {
  it("is true below the floor and false at or above it", async () => {
    const old = await hashPassword(PASSWORD, PEPPER, { params: { n: 1024, r: 8, p: 1 } });
    expect(passwordHashIsStale(old, { n: 32768, r: 8, p: 1 })).toBe(true);
    expect(passwordHashIsStale(old, { n: 1024, r: 8, p: 1 })).toBe(false);
    expect(passwordHashIsStale(old, { n: 512, r: 8, p: 1 })).toBe(false);
  });

  it("answers false for an unreadable hash", () => {
    // Unreadable is a different problem with a different remedy: re-hashing needs the plaintext
    // and a corrupt row needs a reset, so claiming staleness here would send a caller to the
    // wrong fix.
    expect(passwordHashIsStale("a".repeat(64))).toBe(false);
    expect(passwordHashIsStale("")).toBe(false);
  });
});
