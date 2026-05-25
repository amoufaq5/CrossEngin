import { z } from "zod";

const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const DISPLAY_MODES = ["fullscreen", "standalone", "minimal-ui", "browser"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

export const ORIENTATIONS = [
  "any",
  "natural",
  "landscape",
  "portrait",
  "portrait-primary",
  "landscape-primary",
] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export const IconPurposeSchema = z.enum(["any", "maskable", "monochrome"]);
export type IconPurpose = z.infer<typeof IconPurposeSchema>;

export const ManifestIconSchema = z
  .object({
    src: z.string().min(1),
    sizes: z.string().regex(/^(?:any|\d+x\d+(?:\s+\d+x\d+)*)$/, {
      message: "sizes must be 'any' or one-or-more 'WxH' tokens",
    }),
    type: z.string().regex(/^image\/[a-z0-9.+-]+$/),
    purpose: IconPurposeSchema.default("any"),
  })
  .superRefine((v, ctx) => {
    if (v.sizes === "any" && v.type !== "image/svg+xml") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sizes"],
        message: "sizes='any' is only valid for SVG icons",
      });
    }
  });
export type ManifestIcon = z.infer<typeof ManifestIconSchema>;

export const ShortcutSchema = z.object({
  name: z.string().min(1),
  short_name: z.string().min(1).optional(),
  url: z.string().min(1),
  description: z.string().optional(),
  icons: z.array(ManifestIconSchema).optional(),
});

export const RELATED_APPLICATION_PLATFORMS = [
  "play",
  "itunes",
  "windows",
  "f-droid",
  "amazon",
] as const;

export const RelatedApplicationSchema = z.object({
  platform: z.enum(RELATED_APPLICATION_PLATFORMS),
  url: z.string().url(),
  id: z.string().min(1).optional(),
});

const REQUIRED_ICON_SIZES = ["192x192", "512x512"] as const;

export const WebAppManifestSchema = z
  .object({
    name: z.string().min(1).max(120),
    short_name: z.string().min(1).max(12).optional(),
    description: z.string().max(300).optional(),
    start_url: z.string().min(1).default("/"),
    scope: z.string().min(1).default("/"),
    display: z.enum(DISPLAY_MODES).default("standalone"),
    orientation: z.enum(ORIENTATIONS).default("any"),
    theme_color: z.string().regex(HEX_COLOR_REGEX),
    background_color: z.string().regex(HEX_COLOR_REGEX),
    lang: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
      .default("en"),
    dir: z.enum(["ltr", "rtl", "auto"]).default("auto"),
    id: z.string().min(1).optional(),
    icons: z.array(ManifestIconSchema).min(1),
    shortcuts: z.array(ShortcutSchema).max(8).default([]),
    categories: z.array(z.string().min(1)).max(15).default([]),
    prefer_related_applications: z.boolean().default(false),
    related_applications: z.array(RelatedApplicationSchema).default([]),
  })
  .superRefine((v, ctx) => {
    if (!v.scope.endsWith("/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "scope must end with '/'",
      });
    }
    if (!v.start_url.startsWith(v.scope) && v.start_url !== v.scope.slice(0, -1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["start_url"],
        message: `start_url '${v.start_url}' must be within scope '${v.scope}'`,
      });
    }
    const sizes = new Set<string>();
    for (const icon of v.icons) {
      for (const token of icon.sizes.split(/\s+/)) {
        sizes.add(token);
      }
    }
    for (const required of REQUIRED_ICON_SIZES) {
      const ok = sizes.has(required) || sizes.has("any");
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["icons"],
          message: `manifest must include an icon at '${required}' (or an 'any' SVG)`,
        });
        return;
      }
    }
    if (v.prefer_related_applications && v.related_applications.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["related_applications"],
        message:
          "prefer_related_applications=true requires at least one related_applications entry",
      });
    }
  });
export type WebAppManifest = z.infer<typeof WebAppManifestSchema>;

export function manifestForTheme(input: {
  readonly name: string;
  readonly themeColor: string;
  readonly backgroundColor: string;
  readonly lang?: string;
  readonly dir?: "ltr" | "rtl" | "auto";
  readonly icons: readonly ManifestIcon[];
}): WebAppManifest {
  return WebAppManifestSchema.parse({
    name: input.name,
    theme_color: input.themeColor,
    background_color: input.backgroundColor,
    icons: input.icons,
    ...(input.lang !== undefined ? { lang: input.lang } : {}),
    ...(input.dir !== undefined ? { dir: input.dir } : {}),
  });
}
