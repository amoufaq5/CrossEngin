import { z } from "zod";

export const COMMON_CONTENT_TYPES = [
  "application/json",
  "application/xml",
  "application/vnd.api+json",
  "application/x-ndjson",
  "text/csv",
  "text/plain",
  "application/octet-stream",
  "multipart/form-data",
  "application/x-www-form-urlencoded",
  "application/vnd.crossengin.v1+json",
] as const;
export type CommonContentType = (typeof COMMON_CONTENT_TYPES)[number];

export const SUPPORTED_ENCODINGS = [
  "identity",
  "gzip",
  "br",
  "deflate",
  "zstd",
] as const;
export type SupportedEncoding = (typeof SUPPORTED_ENCODINGS)[number];

export interface AcceptEntry {
  readonly mediaType: string;
  readonly quality: number;
  readonly parameters: Readonly<Record<string, string>>;
}

export const parseAcceptHeader = (
  header: string | null,
): readonly AcceptEntry[] => {
  if (header === null || header.trim().length === 0) return [];
  return header
    .split(",")
    .map((piece) => parseAcceptPiece(piece.trim()))
    .filter((e): e is AcceptEntry => e !== null);
};

const parseAcceptPiece = (piece: string): AcceptEntry | null => {
  if (piece.length === 0) return null;
  const segments = piece.split(";").map((s) => s.trim());
  const mediaType = segments[0];
  if (mediaType === undefined || mediaType.length === 0) return null;
  let quality = 1;
  const parameters: Record<string, string> = {};
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const eqIdx = seg.indexOf("=");
    if (eqIdx === -1) continue;
    const k = seg.slice(0, eqIdx).trim();
    const v = seg.slice(eqIdx + 1).trim().replace(/^"|"$/g, "");
    if (k === "q") {
      const parsed = Number(v);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
        quality = parsed;
      }
    } else {
      parameters[k] = v;
    }
  }
  return { mediaType, quality, parameters };
};

export const matchesMediaType = (
  pattern: string,
  candidate: string,
): boolean => {
  if (pattern === "*/*") return true;
  if (pattern === candidate) return true;
  const [pType, pSub] = pattern.split("/");
  const [cType, cSub] = candidate.split("/");
  if (pSub === "*" && pType === cType) return true;
  if (pType === cType && pSub === cSub) return true;
  return false;
};

export const selectResponseContentType = (input: {
  readonly acceptHeader: string | null;
  readonly serverOffers: readonly string[];
  readonly defaultType: string;
}): string | null => {
  const entries = parseAcceptHeader(input.acceptHeader);
  if (entries.length === 0) {
    return input.serverOffers.includes(input.defaultType)
      ? input.defaultType
      : (input.serverOffers[0] ?? null);
  }
  const sorted = [...entries].sort((a, b) => b.quality - a.quality);
  for (const e of sorted) {
    if (e.quality === 0) continue;
    for (const offer of input.serverOffers) {
      if (matchesMediaType(e.mediaType, offer)) {
        return offer;
      }
    }
  }
  return null;
};

export const parseAcceptEncodingHeader = (
  header: string | null,
): readonly { encoding: SupportedEncoding; quality: number }[] => {
  if (header === null) return [{ encoding: "identity", quality: 1 }];
  const entries = header
    .split(",")
    .map((p) => p.trim())
    .map((p) => {
      const [enc, ...params] = p.split(";").map((s) => s.trim());
      let q = 1;
      for (const param of params) {
        const eq = param.indexOf("=");
        if (eq === -1) continue;
        const k = param.slice(0, eq).trim();
        const v = param.slice(eq + 1).trim();
        if (k === "q") {
          const parsed = Number(v);
          if (Number.isFinite(parsed)) q = parsed;
        }
      }
      return { encoding: enc, quality: q };
    })
    .filter((e): e is { encoding: string; quality: number } => e.encoding !== undefined)
    .filter((e): e is { encoding: SupportedEncoding; quality: number } =>
      (SUPPORTED_ENCODINGS as readonly string[]).includes(e.encoding),
    );
  return entries;
};

export const selectResponseEncoding = (input: {
  readonly acceptEncodingHeader: string | null;
  readonly serverSupports: readonly SupportedEncoding[];
}): SupportedEncoding => {
  const entries = parseAcceptEncodingHeader(input.acceptEncodingHeader);
  const sorted = [...entries].sort((a, b) => b.quality - a.quality);
  for (const e of sorted) {
    if (e.quality === 0) continue;
    if (input.serverSupports.includes(e.encoding)) return e.encoding;
  }
  return "identity";
};

export const ContentNegotiationDecisionSchema = z
  .object({
    requestContentType: z.string().max(200).nullable(),
    selectedResponseContentType: z.string().max(200),
    selectedResponseEncoding: z.enum(SUPPORTED_ENCODINGS),
    selectedResponseLanguage: z.string().max(35).nullable(),
    acceptableLanguages: z.array(z.string().max(35)).default([]),
    requestContentTypeAccepted: z.boolean(),
    rejectedReason: z.string().max(200).nullable(),
  })
  .superRefine((d, ctx) => {
    if (!d.requestContentTypeAccepted && d.rejectedReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rejectedReason"],
        message:
          "rejected content type requires rejectedReason",
      });
    }
  });
export type ContentNegotiationDecision = z.infer<
  typeof ContentNegotiationDecisionSchema
>;

export const parseAcceptLanguageHeader = (
  header: string | null,
): readonly { tag: string; quality: number }[] => {
  if (header === null) return [];
  return header
    .split(",")
    .map((p) => p.trim())
    .map((p) => {
      const [tag, ...params] = p.split(";").map((s) => s.trim());
      let q = 1;
      for (const param of params) {
        const eq = param.indexOf("=");
        if (eq === -1) continue;
        const k = param.slice(0, eq).trim();
        const v = param.slice(eq + 1).trim();
        if (k === "q") {
          const parsed = Number(v);
          if (Number.isFinite(parsed)) q = parsed;
        }
      }
      return { tag, quality: q };
    })
    .filter((e): e is { tag: string; quality: number } => e.tag !== undefined && e.tag.length > 0);
};

export const selectResponseLanguage = (input: {
  readonly acceptLanguageHeader: string | null;
  readonly availableLanguages: readonly string[];
  readonly defaultLanguage: string;
}): string => {
  const entries = parseAcceptLanguageHeader(input.acceptLanguageHeader);
  if (entries.length === 0) return input.defaultLanguage;
  const sorted = [...entries].sort((a, b) => b.quality - a.quality);
  for (const e of sorted) {
    if (e.quality === 0) continue;
    if (input.availableLanguages.includes(e.tag)) return e.tag;
    const baseTag = e.tag.split("-")[0];
    if (baseTag !== undefined) {
      const fallback = input.availableLanguages.find((l) =>
        l.startsWith(`${baseTag}-`) || l === baseTag,
      );
      if (fallback !== undefined) return fallback;
    }
  }
  return input.defaultLanguage;
};
