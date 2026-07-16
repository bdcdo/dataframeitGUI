import { describe, it, expect } from "vitest";
import {
  APP_TIME_ZONE,
  formatDate,
  formatDateTime,
  formatDateForFilename,
} from "../date-format";

// 2026-07-16T23:30:00Z = 20:30 de 16/07 em Sao Paulo (-03).
const EVENING_UTC = "2026-07-16T23:30:00Z";
// 2026-07-17T02:30:00Z = 23:30 de 16/07 em Sao Paulo — o caso que motiva o
// helper: em UTC ja e dia 17, no fuso do usuario ainda e dia 16.
const AFTER_MIDNIGHT_UTC = "2026-07-17T02:30:00Z";

describe("formatDate", () => {
  it("formata como dd/mm/aaaa", () => {
    expect(formatDate(EVENING_UTC)).toBe("16/07/2026");
  });

  it("usa o dia do fuso de Sao Paulo, nao o de UTC", () => {
    // O bug que o helper corrige: fatiar o ISO (ou formatar sem timeZone num
    // runtime UTC) daria 17/07 para um instante que, para o usuario, e dia 16.
    expect(AFTER_MIDNIGHT_UTC.slice(0, 10)).toBe("2026-07-17");
    expect(formatDate(AFTER_MIDNIGHT_UTC)).toBe("16/07/2026");
  });
});

describe("formatDateTime", () => {
  it("formata como dd/mm/aaaa, hh:mm no fuso de Sao Paulo", () => {
    expect(formatDateTime(EVENING_UTC)).toBe("16/07/2026, 20:30");
  });

  it("converte a hora para o fuso do usuario na virada do dia", () => {
    expect(formatDateTime(AFTER_MIDNIGHT_UTC)).toBe("16/07/2026, 23:30");
  });
});

describe("formatDateForFilename", () => {
  it("formata como aaaa-mm-dd, ordenavel", () => {
    expect(formatDateForFilename(new Date(EVENING_UTC))).toBe("2026-07-16");
  });

  it("nao data o arquivo com o dia seguinte a noite", () => {
    expect(formatDateForFilename(new Date(AFTER_MIDNIGHT_UTC))).toBe(
      "2026-07-16",
    );
  });
});

describe("determinismo entre servidor e cliente", () => {
  // A garantia que sustenta o fim do hydration mismatch: a saida nao pode
  // depender do fuso do runtime. Estes testes reformatam o mesmo instante com
  // o TZ do processo trocado no meio, simulando SSR (UTC) e hidratacao (-03).
  const withProcessTimeZone = <T,>(tz: string, fn: () => T): T => {
    const previous = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      process.env.TZ = previous;
    }
  };

  it.each([
    ["formatDate", formatDate],
    ["formatDateTime", formatDateTime],
  ])("%s produz a mesma saida em UTC e em Sao Paulo", (_name, format) => {
    const asServer = withProcessTimeZone("UTC", () =>
      format(AFTER_MIDNIGHT_UTC),
    );
    const asBrowser = withProcessTimeZone(APP_TIME_ZONE, () =>
      format(AFTER_MIDNIGHT_UTC),
    );
    expect(asServer).toBe(asBrowser);
  });
});
