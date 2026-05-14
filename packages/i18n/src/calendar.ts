import { z } from "zod";

export const CALENDAR_SYSTEMS = [
  "gregorian",
  "islamic-umalqura",
  "islamic-civil",
  "hebrew",
  "buddhist",
  "japanese",
  "persian",
  "iso8601",
] as const;
export type CalendarSystem = (typeof CALENDAR_SYSTEMS)[number];

export const CalendarSystemSchema = z.enum(CALENDAR_SYSTEMS);

export const NUMBERING_SYSTEMS = [
  "latn",
  "arab",
  "arabext",
  "deva",
  "thai",
  "beng",
  "hebr",
  "hanidec",
] as const;
export type NumberingSystem = (typeof NUMBERING_SYSTEMS)[number];

export const NumberingSystemSchema = z.enum(NUMBERING_SYSTEMS);

export const DateFormatPresetSchema = z.enum(["iso", "locale", "short", "medium", "long", "full"]);
export type DateFormatPreset = z.infer<typeof DateFormatPresetSchema>;

export const CalendarConfigSchema = z.object({
  primary: CalendarSystemSchema.default("gregorian"),
  secondary: z.array(CalendarSystemSchema).default([]),
  numberingSystem: NumberingSystemSchema.default("latn"),
  dateFormat: DateFormatPresetSchema.default("locale"),
});
export type CalendarConfig = z.infer<typeof CalendarConfigSchema>;

export const RTL_NUMBERING_FOR_LOCALE: Readonly<Record<string, NumberingSystem>> = Object.freeze({
  ar: "arab",
  "ar-AE": "arab",
  "ar-SA": "arab",
  fa: "arabext",
  he: "hebr",
});

export function defaultNumberingSystemFor(locale: string): NumberingSystem {
  return RTL_NUMBERING_FOR_LOCALE[locale] ?? "latn";
}

export function isHijriCalendar(system: CalendarSystem): boolean {
  return system === "islamic-umalqura" || system === "islamic-civil";
}
