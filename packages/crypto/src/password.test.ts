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
    for (const n of [1024, 16384, 32768, 65536, 131072]) {
      for (const r of [8, 16]) {
        expect(scryptMaxmem(n, r)).toBeGreaterThan(128 * r * (n + 1 + 2));
      }
    }
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
