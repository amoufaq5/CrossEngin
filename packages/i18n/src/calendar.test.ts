import { describe, expect, it } from "vitest";
import {
  CALENDAR_SYSTEMS,
  CalendarConfigSchema,
  defaultNumberingSystemFor,
  isHijriCalendar,
  NUMBERING_SYSTEMS,
} from "./calendar.js";

describe("CALENDAR_SYSTEMS / NUMBERING_SYSTEMS", () => {
  it("includes Hijri + Gregorian + Buddhist + ISO 8601", () => {
    expect(CALENDAR_SYSTEMS).toContain("gregorian");
    expect(CALENDAR_SYSTEMS).toContain("islamic-umalqura");
    expect(CALENDAR_SYSTEMS).toContain("buddhist");
    expect(CALENDAR_SYSTEMS).toContain("iso8601");
  });

  it("includes Western Arabic + Eastern Arabic-Indic numbering", () => {
    expect(NUMBERING_SYSTEMS).toContain("latn");
    expect(NUMBERING_SYSTEMS).toContain("arab");
    expect(NUMBERING_SYSTEMS).toContain("arabext");
  });
});

describe("CalendarConfigSchema", () => {
  it("applies defaults", () => {
    const c = CalendarConfigSchema.parse({});
    expect(c.primary).toBe("gregorian");
    expect(c.secondary).toEqual([]);
    expect(c.numberingSystem).toBe("latn");
    expect(c.dateFormat).toBe("locale");
  });

  it("parses a Saudi-style Hijri-primary config", () => {
    const c = CalendarConfigSchema.parse({
      primary: "islamic-umalqura",
      secondary: ["gregorian"],
      numberingSystem: "arab",
      dateFormat: "long",
    });
    expect(c.primary).toBe("islamic-umalqura");
  });

  it("rejects an unknown calendar system", () => {
    expect(() => CalendarConfigSchema.parse({ primary: "imaginary" })).toThrow();
  });
});

describe("defaultNumberingSystemFor", () => {
  it("returns arab for Arabic locales", () => {
    expect(defaultNumberingSystemFor("ar")).toBe("arab");
    expect(defaultNumberingSystemFor("ar-AE")).toBe("arab");
  });

  it("returns arabext for Persian", () => {
    expect(defaultNumberingSystemFor("fa")).toBe("arabext");
  });

  it("returns latn for English / French / German", () => {
    expect(defaultNumberingSystemFor("en")).toBe("latn");
    expect(defaultNumberingSystemFor("fr")).toBe("latn");
    expect(defaultNumberingSystemFor("de")).toBe("latn");
  });
});

describe("isHijriCalendar", () => {
  it("returns true for islamic-umalqura + islamic-civil", () => {
    expect(isHijriCalendar("islamic-umalqura")).toBe(true);
    expect(isHijriCalendar("islamic-civil")).toBe(true);
  });

  it("returns false for gregorian / buddhist", () => {
    expect(isHijriCalendar("gregorian")).toBe(false);
    expect(isHijriCalendar("buddhist")).toBe(false);
  });
});
