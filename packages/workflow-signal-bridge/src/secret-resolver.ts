export interface SecretLookupInput {
  readonly tenantId: string | null;
  readonly sourceSystem: string | null;
  readonly hint: string | null;
}

export interface SecretLookupResult {
  readonly secretBytes: Uint8Array;
  readonly toleranceSeconds: number;
}

export interface SecretResolver {
  resolve(input: SecretLookupInput): Promise<SecretLookupResult | null>;
}

export interface StaticSecretEntry {
  readonly tenantId: string | null;
  readonly sourceSystem: string | null;
  readonly secretBytes: Uint8Array;
  readonly toleranceSeconds?: number;
}

export class StaticSecretResolver implements SecretResolver {
  private readonly entries: readonly StaticSecretEntry[];
  private readonly defaultTolerance: number;

  constructor(entries: readonly StaticSecretEntry[], opts: { readonly defaultToleranceSeconds?: number } = {}) {
    this.entries = entries;
    this.defaultTolerance = opts.defaultToleranceSeconds ?? 300;
  }

  async resolve(input: SecretLookupInput): Promise<SecretLookupResult | null> {
    for (const entry of this.entries) {
      if (entry.tenantId !== null && entry.tenantId !== input.tenantId) continue;
      if (entry.sourceSystem !== null && entry.sourceSystem !== input.sourceSystem) continue;
      return {
        secretBytes: entry.secretBytes,
        toleranceSeconds: entry.toleranceSeconds ?? this.defaultTolerance,
      };
    }
    return null;
  }
}
