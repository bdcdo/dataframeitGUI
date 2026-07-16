import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  formatCondition,
  formatRelativeDate,
  formatTarget,
  formatType,
  formatVersion,
  propertyLabel,
} from "../schema-change-format";

describe("formatCondition", () => {
  it("formata equals", () => {
    expect(formatCondition({ field: "x", equals: "a" })).toBe('x = "a"');
  });

  it("formata not_equals com número", () => {
    expect(formatCondition({ field: "x", not_equals: 5 })).toBe("x ≠ 5");
  });

  it("formata in", () => {
    expect(formatCondition({ field: "x", in: ["a", "b"] })).toBe('x ∈ ["a", "b"]');
  });

  it("formata not_in", () => {
    expect(formatCondition({ field: "x", not_in: [1, 2] })).toBe("x ∉ [1, 2]");
  });

  it("formata exists true/false", () => {
    expect(formatCondition({ field: "x", exists: true })).toBe("x existe");
    expect(formatCondition({ field: "x", exists: false })).toBe("x ausente");
  });

  it("retorna 'sem condição' para null/undefined", () => {
    expect(formatCondition(null)).toBe("sem condição");
    expect(formatCondition(undefined)).toBe("sem condição");
  });
});

describe("formatRelativeDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retorna 'agora' para diff < 60s", () => {
    expect(formatRelativeDate("2026-05-04T11:59:30Z")).toBe("agora");
  });

  it("retorna minutos para até 60min", () => {
    expect(formatRelativeDate("2026-05-04T11:55:00Z")).toBe("há 5 minutos");
    expect(formatRelativeDate("2026-05-04T11:59:00Z")).toBe("há 1 minuto");
  });

  it("retorna horas para até 24h", () => {
    expect(formatRelativeDate("2026-05-04T09:00:00Z")).toBe("há 3 horas");
    expect(formatRelativeDate("2026-05-04T11:00:00Z")).toBe("há 1 hora");
  });

  it("retorna 'ontem' para 1 dia", () => {
    expect(formatRelativeDate("2026-05-03T12:00:00Z")).toBe("ontem");
  });

  it("retorna 'há N dias' para 2-6 dias", () => {
    expect(formatRelativeDate("2026-05-01T12:00:00Z")).toBe("há 3 dias");
  });

  it("retorna data formatada para >= 7 dias", () => {
    // Assert na string exata: o fallback delega a formatDate, que fixa o fuso
    // (ver lib/date-format.ts), entao a saida nao depende do TZ da maquina.
    expect(formatRelativeDate("2026-04-20T12:00:00Z")).toBe("20/04/2026");
  });
});

describe("formatVersion / formatTarget / formatType / propertyLabel", () => {
  it("formatVersion", () => {
    expect(formatVersion(null)).toBe("—");
    expect(formatVersion({ major: 1, minor: 2, patch: 3 })).toBe("v1.2.3");
  });

  it("formatTarget cobre labels conhecidos e fallback", () => {
    expect(formatTarget("all")).toBe("Todos");
    expect(formatTarget("llm_only")).toBe("Só LLM");
    expect(formatTarget("desconhecido")).toBe("desconhecido");
    expect(formatTarget(null)).toBe("—");
  });

  it("formatType cobre labels conhecidos", () => {
    expect(formatType("single")).toBe("Escolha única");
    expect(formatType("multi")).toBe("Múltipla escolha");
    expect(formatType("text")).toBe("Texto livre");
    expect(formatType("date")).toBe("Data");
  });

  it("propertyLabel traduz cada propriedade", () => {
    expect(propertyLabel("name")).toBe("nome");
    expect(propertyLabel("description")).toBe("descrição");
    expect(propertyLabel("subfields")).toBe("subcampos");
    expect(propertyLabel("condition")).toBe("condição");
  });
});
