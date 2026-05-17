export interface CorrelationExtractor {
  extract(body: Record<string, unknown>): string | null;
}

export class FieldPathExtractor implements CorrelationExtractor {
  private readonly segments: readonly string[];

  constructor(path: string) {
    if (path.length === 0) {
      throw new Error("FieldPathExtractor requires a non-empty path");
    }
    this.segments = path.split(".");
  }

  extract(body: Record<string, unknown>): string | null {
    let current: unknown = body;
    for (const segment of this.segments) {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return null;
      }
      const next = (current as Record<string, unknown>)[segment];
      if (next === undefined) return null;
      current = next;
    }
    if (typeof current === "string") return current;
    if (typeof current === "number" && Number.isFinite(current)) {
      return current.toString();
    }
    return null;
  }
}

export class FixedExtractor implements CorrelationExtractor {
  private readonly value: string;
  constructor(value: string) {
    if (value.length === 0) {
      throw new Error("FixedExtractor requires a non-empty value");
    }
    this.value = value;
  }
  extract(): string {
    return this.value;
  }
}

export class FirstFieldExtractor implements CorrelationExtractor {
  private readonly fieldNames: readonly string[];

  constructor(fieldNames: readonly string[]) {
    if (fieldNames.length === 0) {
      throw new Error("FirstFieldExtractor requires at least one field name");
    }
    this.fieldNames = fieldNames;
  }

  extract(body: Record<string, unknown>): string | null {
    for (const name of this.fieldNames) {
      const value = body[name];
      if (typeof value === "string" && value.length > 0) return value;
      if (typeof value === "number" && Number.isFinite(value)) {
        return value.toString();
      }
    }
    return null;
  }
}

export function fieldPathExtractor(path: string): CorrelationExtractor {
  return new FieldPathExtractor(path);
}

export function fixedExtractor(value: string): CorrelationExtractor {
  return new FixedExtractor(value);
}

export function firstFieldExtractor(...names: readonly string[]): CorrelationExtractor {
  return new FirstFieldExtractor(names);
}
