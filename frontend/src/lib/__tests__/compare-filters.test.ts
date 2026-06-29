import { describe, it, expect } from "vitest";
import {
  DEFAULT_COMPARE_FILTERS,
  readCompareFilters,
  compareDefaultsForMode,
  assignedCompareDocIds,
} from "@/lib/compare-filters";

// Estes testes cobrem a peça que liga a Comparação de "1 humano + 1 LLM": o
// piso de "mín. humanos" passa a ser derivado do automation_mode do projeto
// (compareDefaultsForMode), espelhando o gatilho createAutoComparisonIfDiverges
// (lib/auto-comparison.ts). Sem isto, compare_llm (1 codificador) nunca
// alcançaria o piso fixo de 2 e a aba ficaria vazia.

describe("compareDefaultsForMode", () => {
  it("compare_llm baixa o piso de humanos para 1 (a 2ª resposta é o LLM)", () => {
    expect(compareDefaultsForMode("compare_llm", 2).minHumans).toBe(1);
    // independe de min_responses_for_comparison
    expect(compareDefaultsForMode("compare_llm", 5).minHumans).toBe(1);
  });

  it("compare_humans usa min_responses_for_comparison", () => {
    expect(compareDefaultsForMode("compare_humans", 2).minHumans).toBe(2);
    expect(compareDefaultsForMode("compare_humans", 3).minHumans).toBe(3);
    // nunca abaixo de 1, mesmo com config inválida
    expect(compareDefaultsForMode("compare_humans", 0).minHumans).toBe(1);
  });

  it("auto_review_llm / none / null / undefined / desconhecido mantêm o piso base (2)", () => {
    expect(compareDefaultsForMode("auto_review_llm", 2).minHumans).toBe(
      DEFAULT_COMPARE_FILTERS.minHumans,
    );
    expect(compareDefaultsForMode("none", 2).minHumans).toBe(2);
    expect(compareDefaultsForMode(null, 2).minHumans).toBe(2);
    expect(compareDefaultsForMode(undefined, 2).minHumans).toBe(2);
    expect(compareDefaultsForMode("valor_legado", 2).minHumans).toBe(2);
  });

  it("default vivo de versão é latest_major, não o 'all' da constante base (#247)", () => {
    // A página foca na versão corrente por padrão; o seletor ainda oferece
    // "all" para revisar rodadas antigas. DEFAULT_COMPARE_FILTERS.version segue
    // "all" para os callers/testes que não passam por compareDefaultsForMode.
    expect(compareDefaultsForMode("compare_llm", 2).version).toBe("latest_major");
    expect(compareDefaultsForMode("compare_humans", 2).version).toBe("latest_major");
    expect(compareDefaultsForMode(null, 2).version).toBe("latest_major");
    expect(DEFAULT_COMPARE_FILTERS.version).toBe("all");
  });

  it("preserva os demais defaults globais (só mexe em minHumans e version)", () => {
    const d = compareDefaultsForMode("compare_llm", 2);
    expect(d.minTotal).toBe(DEFAULT_COMPARE_FILTERS.minTotal);
    expect(d.minAssignedPct).toBe(DEFAULT_COMPARE_FILTERS.minAssignedPct);
    expect(d.since).toBe(DEFAULT_COMPARE_FILTERS.since);
    expect(d.respondent).toBe(DEFAULT_COMPARE_FILTERS.respondent);
  });
});

describe("readCompareFilters com defaults por modo", () => {
  it("sem param na URL, usa o piso do modo (compare_llm => 1)", () => {
    const defaults = compareDefaultsForMode("compare_llm", 2);
    expect(readCompareFilters({}, defaults).minHumans).toBe(1);
  });

  it("param min_humans na URL sobrepõe o default do modo (a revisora pode estreitar)", () => {
    const defaults = compareDefaultsForMode("compare_llm", 2);
    expect(readCompareFilters({ min_humans: "3" }, defaults).minHumans).toBe(3);
  });

  it("sem defaults explícitos, mantém o comportamento legado (piso 2)", () => {
    expect(readCompareFilters({}).minHumans).toBe(2);
  });

  it("aceita URLSearchParams além de Record, misturando default-de-modo com URL", () => {
    const defaults = compareDefaultsForMode("compare_llm", 2);
    const sp = new URLSearchParams("min_total=3");
    const f = readCompareFilters(sp, defaults);
    expect(f.minHumans).toBe(1); // veio do modo
    expect(f.minTotal).toBe(3); // veio da URL
  });
});

// Invariante de segurança: na fila de Comparação, um não-coordenador só pode
// ver os documentos atribuídos a ele. A policy RLS "Members view responses" não
// restringe por linha, então este recorte é a única barreira — por isso o
// `isCoordinator` que o alimenta é fail-closed.
describe("assignedCompareDocIds — não-coordenador vê só os docs atribuídos", () => {
  const userId = "user-self";
  const assignments = [
    { document_id: "doc-meu", user_id: userId, type: "comparacao" },
    { document_id: "doc-de-outro", user_id: "user-other", type: "comparacao" },
    { document_id: "doc-codificacao", user_id: userId, type: "codificacao" },
  ];

  it("coordenador → null (sem restrição: vê todos os documentos)", () => {
    expect(assignedCompareDocIds(true, assignments, userId)).toBeNull();
  });

  it("não-coordenador → só os docs de comparação atribuídos a ele", () => {
    const visible = assignedCompareDocIds(false, assignments, userId);
    expect(visible).toEqual(new Set(["doc-meu"]));
    // não vaza o doc de comparação atribuído a outro respondente...
    expect(visible!.has("doc-de-outro")).toBe(false);
    // ...nem um assignment de outro tipo (codificação) do próprio usuário
    expect(visible!.has("doc-codificacao")).toBe(false);
  });

  it("não-coordenador sem assignments → conjunto vazio (não vê nada)", () => {
    expect(assignedCompareDocIds(false, [], userId)).toEqual(new Set());
    expect(assignedCompareDocIds(false, null, userId)).toEqual(new Set());
  });
});
