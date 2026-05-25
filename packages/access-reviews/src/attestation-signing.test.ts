import { InMemoryKeyStore, generateEd25519Keypair, signEd25519 } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { DecisionAttestationSchema } from "./decisions.js";
import {
  canonicalAttestationBytes,
  computeAttestationSha256,
  signDecisionAttestation,
  signDecisionAttestationWithStore,
  verifyDecisionAttestation,
  type AttestationInput,
} from "./attestation-signing.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";
const PEER = "00000000-0000-4000-8000-000000000020";

function fixtureInput(overrides: Partial<AttestationInput> = {}): AttestationInput {
  return {
    subject: {
      decisionId: "ard_dec00001",
      campaignId: "arc_camp0001",
      itemId: "ari_itm00001",
      tenantId: TENANT,
    },
    kind: "e_signature_digital",
    attestedAt: "2026-05-16T12:00:00.000Z",
    attestedByUserId: USER,
    attestationPhrase: "I attest this access is appropriate.",
    coAttestingUserId: null,
    coAttestedAt: null,
    ipAddress: "203.0.113.42",
    userAgent: "Mozilla/5.0",
    ...overrides,
  };
}

describe("canonicalAttestationBytes", () => {
  it("is stable across runs for identical input", () => {
    const a = canonicalAttestationBytes(fixtureInput());
    const b = canonicalAttestationBytes(fixtureInput());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("prefixes the attestation domain tag", () => {
    const bytes = canonicalAttestationBytes(fixtureInput());
    expect(
      new TextDecoder().decode(bytes).startsWith("crossengin.access-review.attestation.v1\n"),
    ).toBe(true);
  });

  it("changes when subject changes", () => {
    const a = canonicalAttestationBytes(fixtureInput());
    const b = canonicalAttestationBytes(
      fixtureInput({ subject: { ...fixtureInput().subject, decisionId: "ard_dec00002" } }),
    );
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("computeAttestationSha256", () => {
  it("returns 64-char hex", () => {
    expect(computeAttestationSha256(fixtureInput())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(computeAttestationSha256(fixtureInput())).toBe(computeAttestationSha256(fixtureInput()));
  });
});

describe("signDecisionAttestation", () => {
  it("produces a schema-valid attestation", () => {
    const kp = generateEd25519Keypair();
    const signed = signDecisionAttestation({
      attestation: fixtureInput(),
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
    });
    expect(DecisionAttestationSchema.parse(signed)).toEqual(signed);
    expect(signed.signatureSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.signingKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips through verifyDecisionAttestation", () => {
    const kp = generateEd25519Keypair();
    const input = fixtureInput();
    const signed = signDecisionAttestation({
      attestation: input,
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
    });
    const signatureBase64 = signEd25519(
      kp.privateKeyBase64,
      kp.publicKeyBase64,
      canonicalAttestationBytes(input),
    );
    expect(
      verifyDecisionAttestation({
        attestation: signed,
        subject: input.subject,
        publicKeyBase64: kp.publicKeyBase64,
        signatureBase64,
      }),
    ).toBe(true);
  });
});

describe("verifyDecisionAttestation", () => {
  it("returns true for weak attestation kinds without checking signature", () => {
    const signed = signDecisionAttestation({
      attestation: fixtureInput({ kind: "click_through_acknowledgement" }),
      privateKeyBase64: generateEd25519Keypair().privateKeyBase64,
      publicKeyBase64: generateEd25519Keypair().publicKeyBase64,
    });
    expect(
      verifyDecisionAttestation({
        attestation: signed,
        subject: fixtureInput().subject,
        publicKeyBase64: "0".repeat(43) + "=",
        signatureBase64: "0".repeat(86) + "==",
      }),
    ).toBe(true);
  });

  it("rejects when fingerprint does not match the supplied public key", () => {
    const kp1 = generateEd25519Keypair();
    const kp2 = generateEd25519Keypair();
    const input = fixtureInput();
    const signed = signDecisionAttestation({
      attestation: input,
      privateKeyBase64: kp1.privateKeyBase64,
      publicKeyBase64: kp1.publicKeyBase64,
    });
    const signatureBase64 = signEd25519(
      kp1.privateKeyBase64,
      kp1.publicKeyBase64,
      canonicalAttestationBytes(input),
    );
    expect(
      verifyDecisionAttestation({
        attestation: signed,
        subject: input.subject,
        publicKeyBase64: kp2.publicKeyBase64,
        signatureBase64,
      }),
    ).toBe(false);
  });

  it("rejects a tampered subject (different decisionId)", () => {
    const kp = generateEd25519Keypair();
    const input = fixtureInput();
    const signed = signDecisionAttestation({
      attestation: input,
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
    });
    const signatureBase64 = signEd25519(
      kp.privateKeyBase64,
      kp.publicKeyBase64,
      canonicalAttestationBytes(input),
    );
    expect(
      verifyDecisionAttestation({
        attestation: signed,
        subject: { ...input.subject, decisionId: "ard_dec99999" },
        publicKeyBase64: kp.publicKeyBase64,
        signatureBase64,
      }),
    ).toBe(false);
  });
});

describe("signDecisionAttestationWithStore", () => {
  it("signs via a KeyStore handle", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "evidence_sealing",
    });
    const signed = await signDecisionAttestationWithStore({
      attestation: fixtureInput(),
      store,
      handle: record.handle,
      tenantId: TENANT,
    });
    expect(signed.signingKeyFingerprint).toBe(record.fingerprint);
  });

  it("rejects wrong-purpose keys (pack_signing)", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    await expect(
      signDecisionAttestationWithStore({
        attestation: fixtureInput(),
        store,
        handle: record.handle,
        tenantId: TENANT,
      }),
    ).rejects.toThrow(/evidence_sealing/);
  });

  it("rejects wrong-algorithm keys (hmac-sha256)", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    await expect(
      signDecisionAttestationWithStore({
        attestation: fixtureInput(),
        store,
        handle: record.handle,
        tenantId: TENANT,
      }),
    ).rejects.toThrow(/ed25519/);
  });

  it("rejects cross-tenant signing", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "evidence_sealing",
    });
    await expect(
      signDecisionAttestationWithStore({
        attestation: fixtureInput(),
        store,
        handle: record.handle,
        tenantId: "00000000-0000-4000-8000-000000000999",
      }),
    ).rejects.toThrow(/tenant/);
  });
});

describe("two_person_attestation flow", () => {
  it("schema-valid two_person attestation passes", () => {
    const kp = generateEd25519Keypair();
    const signed = signDecisionAttestation({
      attestation: fixtureInput({
        kind: "two_person_attestation",
        coAttestingUserId: PEER,
        coAttestedAt: "2026-05-16T12:05:00.000Z",
      }),
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
    });
    expect(signed.kind).toBe("two_person_attestation");
    expect(signed.coAttestingUserId).toBe(PEER);
  });
});
