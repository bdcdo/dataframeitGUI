import { describe, it, expect } from "vitest";
import {
  arePartsValid,
  buildDateValue,
  formatPartialDate,
  isPartOutOfRange,
  padDatePart,
  parseDatePartsForUI,
} from "@/lib/date-parts";

describe("parseDatePartsForUI", () => {
  it("returns empty parts for empty string and sentinel", () => {
    expect(parseDatePartsForUI("")).toEqual(["", "", ""]);
    expect(parseDatePartsForUI("Não informada")).toEqual(["", "", ""]);
  });

  it("normalizes XX runs to empty (case-insensitive)", () => {
    expect(parseDatePartsForUI("XX/03/2024")).toEqual(["", "03", "2024"]);
    expect(parseDatePartsForUI("xx/XX/XXXX")).toEqual(["", "", ""]);
    expect(parseDatePartsForUI("XX/XX/2024")).toEqual(["", "", "2024"]);
  });

  it("preserves digit parts as-is", () => {
    expect(parseDatePartsForUI("01/03/2024")).toEqual(["01", "03", "2024"]);
    expect(parseDatePartsForUI("5/3/2024")).toEqual(["5", "3", "2024"]);
  });

  it("returns empty parts for malformed input", () => {
    expect(parseDatePartsForUI("garbage")).toEqual(["", "", ""]);
    expect(parseDatePartsForUI("01-03-2024")).toEqual(["", "", ""]);
    expect(parseDatePartsForUI("01/03")).toEqual(["", "", ""]);
  });
});

describe("buildDateValue", () => {
  it("returns empty when all parts are empty", () => {
    expect(buildDateValue("", "", "")).toBe("");
  });

  it("inserts XX placeholders for empty slots", () => {
    expect(buildDateValue("", "03", "2024")).toBe("XX/03/2024");
    expect(buildDateValue("01", "", "2024")).toBe("01/XX/2024");
    expect(buildDateValue("01", "03", "")).toBe("01/03/XXXX");
    expect(buildDateValue("", "", "2024")).toBe("XX/XX/2024");
  });

  it("preserves complete dates", () => {
    expect(buildDateValue("01", "03", "2024")).toBe("01/03/2024");
  });

  it("round-trips with parseDatePartsForUI for legacy values", () => {
    const cases = ["XX/03/2024", "01/XX/2024", "XX/XX/2024", "01/03/2024"];
    for (const c of cases) {
      const parts = parseDatePartsForUI(c);
      expect(buildDateValue(...parts)).toBe(c);
    }
  });
});

describe("isPartOutOfRange", () => {
  it("returns false for empty values", () => {
    expect(isPartOutOfRange("", "day")).toBe(false);
    expect(isPartOutOfRange("", "month")).toBe(false);
    expect(isPartOutOfRange("", "year")).toBe(false);
  });

  it("returns false for incomplete partial inputs (mid-typing)", () => {
    expect(isPartOutOfRange("3", "day")).toBe(false);
    expect(isPartOutOfRange("9", "day")).toBe(false);
    expect(isPartOutOfRange("1", "month")).toBe(false);
    expect(isPartOutOfRange("20", "year")).toBe(false);
    expect(isPartOutOfRange("2", "year")).toBe(false);
  });

  it("flags day out of range when length is 2", () => {
    expect(isPartOutOfRange("00", "day")).toBe(true);
    expect(isPartOutOfRange("32", "day")).toBe(true);
    expect(isPartOutOfRange("99", "day")).toBe(true);
    expect(isPartOutOfRange("01", "day")).toBe(false);
    expect(isPartOutOfRange("31", "day")).toBe(false);
  });

  it("flags month out of range when length is 2", () => {
    expect(isPartOutOfRange("00", "month")).toBe(true);
    expect(isPartOutOfRange("13", "month")).toBe(true);
    expect(isPartOutOfRange("99", "month")).toBe(true);
    expect(isPartOutOfRange("01", "month")).toBe(false);
    expect(isPartOutOfRange("12", "month")).toBe(false);
  });

  it("flags year out of range when length is 4", () => {
    expect(isPartOutOfRange("0000", "year")).toBe(true);
    expect(isPartOutOfRange("0999", "year")).toBe(true);
    expect(isPartOutOfRange("1000", "year")).toBe(false);
    expect(isPartOutOfRange("2024", "year")).toBe(false);
    expect(isPartOutOfRange("9999", "year")).toBe(false);
  });
});

describe("arePartsValid", () => {
  it("true when all parts are empty or valid", () => {
    expect(arePartsValid(["", "", ""])).toBe(true);
    expect(arePartsValid(["", "03", "2024"])).toBe(true);
    expect(arePartsValid(["31", "12", "2024"])).toBe(true);
    expect(arePartsValid(["3", "1", "20"])).toBe(true);
  });

  it("false when any complete part is out of range", () => {
    expect(arePartsValid(["32", "03", "2024"])).toBe(false);
    expect(arePartsValid(["01", "13", "2024"])).toBe(false);
    expect(arePartsValid(["01", "03", "0999"])).toBe(false);
  });
});

describe("padDatePart", () => {
  it("pads single-digit day/month from 1-9 to 0X", () => {
    expect(padDatePart("5", "day")).toBe("05");
    expect(padDatePart("9", "month")).toBe("09");
    expect(padDatePart("1", "day")).toBe("01");
  });

  it("does not pad zero or empty", () => {
    expect(padDatePart("0", "day")).toBe("0");
    expect(padDatePart("", "day")).toBe("");
  });

  it("does not pad already-2-digit values", () => {
    expect(padDatePart("10", "day")).toBe("10");
    expect(padDatePart("12", "month")).toBe("12");
  });

  it("does not pad year (would invent year)", () => {
    expect(padDatePart("5", "year")).toBe("5");
    expect(padDatePart("20", "year")).toBe("20");
  });
});

describe("formatPartialDate", () => {
  it("replaces X runs with em-dash for partial dates", () => {
    expect(formatPartialDate("XX/03/2024")).toBe("—/03/2024");
    expect(formatPartialDate("01/XX/2024")).toBe("01/—/2024");
    expect(formatPartialDate("XX/XX/2024")).toBe("—/—/2024");
    expect(formatPartialDate("XX/XX/XXXX")).toBe("—/—/—");
  });

  it("leaves complete dates unchanged", () => {
    expect(formatPartialDate("01/03/2024")).toBe("01/03/2024");
  });

  it("leaves non-date strings unchanged", () => {
    expect(formatPartialDate("texto livre")).toBe("texto livre");
    expect(formatPartialDate("Não informada")).toBe("Não informada");
    expect(formatPartialDate("")).toBe("");
    expect(formatPartialDate("2024")).toBe("2024");
  });
});
