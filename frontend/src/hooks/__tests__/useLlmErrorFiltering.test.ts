// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLlmErrorFiltering } from "@/hooks/useLlmErrorFiltering";
import { resolutionFixture } from "@/lib/__tests__/error-resolution-fixture";

const scope = { fieldName: "x", documentTitle: "Documento", reviewedAt: "2026-09-14T12:00:00Z", schemaVersion: "1.0.0" };

describe("filtros de triagem e taxa", () => {
  it("a taxa continua 2/5 ao alternar abertos, decididos e discussão", () => {
    const errors = [
      { ...scope, fieldDescription: "Pergunta", resolution: undefined },
      { ...scope, fieldDescription: "Pergunta", resolution: resolutionFixture("llm_correct") },
      { ...scope, fieldDescription: "Pergunta", resolution: resolutionFixture("researchers_correct") },
      { ...scope, fieldDescription: "Pergunta", resolution: resolutionFixture("discussion") },
    ];
    const reviewed = [false, true, true, true, false, false].map((isError, i) => ({ ...scope, isError, isPending: i === 2 }));
    const { result } = renderHook(() => useLlmErrorFiltering(errors, reviewed));
    expect(result.current.filteredErrors).toHaveLength(1);
    expect(result.current.measuredErrorCount).toBe(2);
    expect(result.current.filteredErrorRate).toBe(40);
    act(() => result.current.setErrorStatusFilter("resolved"));
    expect(result.current.filteredErrors).toHaveLength(2);
    expect(result.current.filteredErrorRate).toBe(40);
    act(() => result.current.setErrorStatusFilter("discussion"));
    expect(result.current.filteredErrors).toHaveLength(1);
    expect(result.current.filteredErrorRate).toBe(40);
    act(() => result.current.setErrorStatusFilter("all"));
    expect(result.current.filteredErrors).toHaveLength(4);
    expect(result.current.filteredErrorRate).toBe(40);
  });
  it("Ambos corretos e Todos errados saem de abertos e entram em decididos", () => {
    const errors = (["both_correct", "all_wrong"] as const)
      .map((decision) => ({ ...scope, fieldDescription: "Pergunta", resolution: resolutionFixture(decision) }));
    const { result } = renderHook(() => useLlmErrorFiltering(errors, []));
    expect(result.current.filteredErrors).toHaveLength(0);
    act(() => result.current.setErrorStatusFilter("resolved"));
    expect(result.current.filteredErrors).toHaveLength(2);
  });
  it("sem casos decididos não fabrica taxa zero", () => {
    const { result } = renderHook(() => useLlmErrorFiltering([], [{ ...scope, isError: true, isPending: true }]));
    expect(result.current.filteredErrorRate).toBeNull();
  });
  it("um filtro de população recorta numerador e denominador juntos", () => {
    const { result } = renderHook(() => useLlmErrorFiltering([], [
      { ...scope, isError: true }, { ...scope, fieldName: "y", isError: false },
    ]));
    expect(result.current.filteredErrorRate).toBe(50);
    act(() => result.current.setErrorFieldFilter("x"));
    expect(result.current.filteredErrorRate).toBe(100);
  });
});
