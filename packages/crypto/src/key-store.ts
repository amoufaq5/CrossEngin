import { type KeyAlgorithm, type KeyPurpose, isPurposeAllowed } from "./algorithms.js";
import { generateHmacKey, hmacSha256Hex } from "./hmac.js";
import {
  type KeyHandle,
  assertHandleTenant,
  generateKeyId,
  withRotatedVersion,
} from "./key-handles.js";
import {
  type Ed25519Keypair,
  ed25519PublicKeyFingerprint,
  generateEd25519Keypair,
  signEd25519,
  verifyEd25519,
} from "./signing.js";

export interface CreateKeyInput {
  readonly tenantId: string | null;
  readonly algorithm: KeyAlgorithm;
  readonly purpose: KeyPurpose;
}

export interface ListKeysFilter {
  readonly tenantId?: string | null;
  readonly algorithm?: KeyAlgorithm;
  readonly purpose?: KeyPurpose;
  readonly includeRevoked?: boolean;
}

export type KeyStatus = "active" | "rotating" | "revoked";

export interface KeyRecord {
  readonly handle: KeyHandle;
  readonly status: KeyStatus;
  readonly publicKeyBase64: string | null;
  readonly fingerprint: string | null;
  readonly rotatedFromKeyId: string | null;
  readonly createdAt: Date;
}

export interface KeyStore {
  createKey(input: CreateKeyInput): Promise<KeyRecord>;
  getRecord(handle: KeyHandle): Promise<KeyRecord>;
  getPublicMaterial(handle: KeyHandle): Promise<string>;
  signWith(
    handle: KeyHandle,
    tenantId: string | null,
    message: Uint8Array | string,
  ): Promise<string>;
  hmacWith(
    handle: KeyHandle,
    tenantId: string | null,
    message: Uint8Array | string,
  ): Promise<string>;
  verifyWith(
    handle: KeyHandle,
    signatureBase64: string,
    message: Uint8Array | string,
  ): Promise<boolean>;
  rotateKey(handle: KeyHandle): Promise<KeyRecord>;
  destroyKey(handle: KeyHandle): Promise<void>;
  listKeys(filter?: ListKeysFilter): Promise<readonly KeyRecord[]>;
}

interface InternalKeyMaterial {
  readonly record: KeyRecord;
  readonly secret: Ed25519Keypair | { readonly hmacKeyBytes: Uint8Array };
}

export class InMemoryKeyStore implements KeyStore {
  private readonly keys: Map<string, InternalKeyMaterial> = new Map();
  private readonly now: () => Date;

  constructor(opts: { readonly now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async createKey(input: CreateKeyInput): Promise<KeyRecord> {
    if (!isPurposeAllowed(input.algorithm, input.purpose)) {
      throw new Error(`purpose ${input.purpose} is not allowed for algorithm ${input.algorithm}`);
    }
    const handle: KeyHandle = {
      id: generateKeyId(input.algorithm),
      tenantId: input.tenantId,
      algorithm: input.algorithm,
      purpose: input.purpose,
      version: 1,
    };
    let record: KeyRecord;
    let secret: InternalKeyMaterial["secret"];
    if (input.algorithm === "ed25519") {
      const kp = generateEd25519Keypair();
      record = {
        handle,
        status: "active",
        publicKeyBase64: kp.publicKeyBase64,
        fingerprint: ed25519PublicKeyFingerprint(kp.publicKeyBase64),
        rotatedFromKeyId: null,
        createdAt: this.now(),
      };
      secret = kp;
    } else {
      const hmacKeyBytes = generateHmacKey(32);
      record = {
        handle,
        status: "active",
        publicKeyBase64: null,
        fingerprint: null,
        rotatedFromKeyId: null,
        createdAt: this.now(),
      };
      secret = { hmacKeyBytes };
    }
    this.keys.set(handle.id, { record, secret });
    return record;
  }

  async getRecord(handle: KeyHandle): Promise<KeyRecord> {
    const material = this.requireMaterial(handle);
    return material.record;
  }

  async getPublicMaterial(handle: KeyHandle): Promise<string> {
    const material = this.requireMaterial(handle);
    if (material.record.publicKeyBase64 === null) {
      throw new Error(`key ${handle.id} has no public material (algorithm ${handle.algorithm})`);
    }
    return material.record.publicKeyBase64;
  }

  async signWith(
    handle: KeyHandle,
    tenantId: string | null,
    message: Uint8Array | string,
  ): Promise<string> {
    assertHandleTenant(handle, tenantId);
    const material = this.requireMaterial(handle);
    if (material.record.status === "revoked") {
      throw new Error(`key ${handle.id} is revoked`);
    }
    if (handle.algorithm !== "ed25519") {
      throw new Error(`signWith requires an ed25519 key, got ${handle.algorithm}`);
    }
    const secret = material.secret as Ed25519Keypair;
    return signEd25519(secret.privateKeyBase64, secret.publicKeyBase64, message);
  }

  async hmacWith(
    handle: KeyHandle,
    tenantId: string | null,
    message: Uint8Array | string,
  ): Promise<string> {
    assertHandleTenant(handle, tenantId);
    const material = this.requireMaterial(handle);
    if (material.record.status === "revoked") {
      throw new Error(`key ${handle.id} is revoked`);
    }
    if (handle.algorithm !== "hmac-sha256") {
      throw new Error(`hmacWith requires an hmac-sha256 key, got ${handle.algorithm}`);
    }
    const secret = material.secret as { hmacKeyBytes: Uint8Array };
    return hmacSha256Hex(secret.hmacKeyBytes, message);
  }

  async verifyWith(
    handle: KeyHandle,
    signatureBase64: string,
    message: Uint8Array | string,
  ): Promise<boolean> {
    const material = this.requireMaterial(handle);
    if (handle.algorithm !== "ed25519") {
      throw new Error(`verifyWith requires an ed25519 key, got ${handle.algorithm}`);
    }
    if (material.record.publicKeyBase64 === null) {
      throw new Error(`key ${handle.id} has no public material`);
    }
    return verifyEd25519(material.record.publicKeyBase64, signatureBase64, message);
  }

  async rotateKey(handle: KeyHandle): Promise<KeyRecord> {
    const old = this.requireMaterial(handle);
    if (old.record.status === "revoked") {
      throw new Error(`key ${handle.id} is revoked`);
    }
    const newHandle = withRotatedVersion(handle);
    let secret: InternalKeyMaterial["secret"];
    let record: KeyRecord;
    if (handle.algorithm === "ed25519") {
      const kp = generateEd25519Keypair();
      record = {
        handle: newHandle,
        status: "active",
        publicKeyBase64: kp.publicKeyBase64,
        fingerprint: ed25519PublicKeyFingerprint(kp.publicKeyBase64),
        rotatedFromKeyId: handle.id,
        createdAt: this.now(),
      };
      secret = kp;
    } else {
      const hmacKeyBytes = generateHmacKey(32);
      record = {
        handle: newHandle,
        status: "active",
        publicKeyBase64: null,
        fingerprint: null,
        rotatedFromKeyId: handle.id,
        createdAt: this.now(),
      };
      secret = { hmacKeyBytes };
    }
    const updatedOldRecord: KeyRecord = { ...old.record, status: "rotating" };
    this.keys.set(handle.id, { record: updatedOldRecord, secret: old.secret });
    this.keys.set(newHandle.id, { record, secret });
    return record;
  }

  async destroyKey(handle: KeyHandle): Promise<void> {
    const material = this.requireMaterial(handle);
    const updated: KeyRecord = { ...material.record, status: "revoked" };
    this.keys.set(handle.id, { record: updated, secret: material.secret });
  }

  async listKeys(filter?: ListKeysFilter): Promise<readonly KeyRecord[]> {
    const records: KeyRecord[] = [];
    for (const material of this.keys.values()) {
      const rec = material.record;
      if (filter?.tenantId !== undefined && rec.handle.tenantId !== filter.tenantId) continue;
      if (filter?.algorithm !== undefined && rec.handle.algorithm !== filter.algorithm) continue;
      if (filter?.purpose !== undefined && rec.handle.purpose !== filter.purpose) continue;
      if (filter?.includeRevoked !== true && rec.status === "revoked") continue;
      records.push(rec);
    }
    return records;
  }

  private requireMaterial(handle: KeyHandle): InternalKeyMaterial {
    const material = this.keys.get(handle.id);
    if (material === undefined) {
      throw new Error(`unknown key handle: ${handle.id}`);
    }
    return material;
  }
}
