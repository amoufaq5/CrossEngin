import { z } from "zod";

const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const HexColorSchema = z.string().regex(HEX_COLOR_REGEX, {
  message: "color must be #RGB, #RRGGBB, or #RRGGBBAA",
});

export const NEUTRAL_PALETTES = ["slate", "stone", "zinc", "gray", "neutral"] as const;
export type NeutralPalette = (typeof NEUTRAL_PALETTES)[number];

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const VOICES = ["professional", "warm", "regulator-aware", "playful"] as const;
export type Voice = (typeof VOICES)[number];

export const FAMILIES = ["operate", "govern", "heal", "educate", "serve", "build"] as const;
export type Family = (typeof FAMILIES)[number];

export const FAMILY_DEFAULT_VOICE: Readonly<Record<Family, Voice>> = Object.freeze({
  operate: "professional",
  govern: "regulator-aware",
  heal: "warm",
  educate: "warm",
  serve: "warm",
  build: "professional",
});

export const ThemeOverlaySchema = z
  .object({
    brandColor: HexColorSchema.optional(),
    accentColor: HexColorSchema.optional(),
    neutralPalette: z.enum(NEUTRAL_PALETTES).optional(),
    density: z.enum(DENSITIES).optional(),
    logoUrl: z.string().url().optional(),
    faviconUrl: z.string().url().optional(),
    fontFamily: z.string().min(1).optional(),
    voice: z.enum(VOICES).optional(),
    family: z.enum(FAMILIES).optional(),
    darkMode: z
      .object({
        brandColor: HexColorSchema.optional(),
        accentColor: HexColorSchema.optional(),
      })
      .optional(),
  })
  .refine(
    (v) => v.brandColor !== v.accentColor || v.brandColor === undefined,
    { message: "brandColor and accentColor must differ" },
  );
export type ThemeOverlay = z.infer<typeof ThemeOverlaySchema>;

export const FAMILY_DEFAULT_BRAND_COLORS: Readonly<Record<Family, string>> = Object.freeze({
  operate: "#1e6f3f",
  govern: "#23467c",
  heal: "#3d8b8b",
  educate: "#8a4fbf",
  serve: "#c2410c",
  build: "#374151",
});

export function resolveTheme(...overlays: readonly Partial<ThemeOverlay>[]): ThemeOverlay {
  const result: Record<string, unknown> = {};
  for (const overlay of overlays) {
    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) continue;
      result[key] = value;
    }
  }
  return ThemeOverlaySchema.parse(result);
}
