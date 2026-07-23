import { describe, it, expect, vi } from "vitest";

import {
  buildCompareMeta,
  buildComparisonPanel,
  buildDocListEntries,
  resolveEmptyMessage,
} from "@/components/compare/compare-view";
import type { DocCoverage } from "@/lib/compare-queue";
import type { ReviewsByDoc, VerdictInfo } from "@/lib/compare-reviews";
import { doc } from "./compare-test-helpers";

type PanelInput = Parameters<typeof buildComparisonPanel>[0];

function coverage(over: Partial<DocCoverage> = {}): DocCoverage {
  return {
    docId: "d1",
    humanCount: 2,
    totalCount: 3,
    assignedCodingCount: 1,
    humansFromAssigned: 1,
    divergentCount: 4,
    reviewedCount: 1,
    assignmentStatus: "em_andamento",
    ...over,
  };
}

describe("buildDocListEntries", () => {
  it("usa a cobertura do servidor quando não há reviews locais", () => {
    const d = doc("d1");
    const [entry] = buildDocListEntries(
      [d],
      { d1: coverage({ docId: "d1", reviewedCount: 3 }) },
      { d1: ["a", "b"] },
      {},
    );
    expect(entry.reviewedCount).toBe(3);
    expect(entry.divergentCount).toBe(4);
  });

  it("override local conta os campos divergentes já com veredito da sessão", () => {
    const d = doc("d1");
    const localReviews: ReviewsByDoc = {
      d1: {
        a: { verdict: "x", chosenResponseId: null, comment: null },
        // 'b' ainda sem veredito local
      },
    };
    const [entry] = buildDocListEntries(
      [d],
      { d1: coverage({ docId: "d1", reviewedCount: 99 }) },
      { d1: ["a", "b"] },
      localReviews,
    );
    // 1 dos 2 campos divergentes tem veredito local → 1, não o 99 do servidor.
    expect(entry.reviewedCount).toBe(1);
  });

  it("documento sem linha de cobertura cai para zeros, não quebra", () => {
    const d = doc("d1");
    const [entry] = buildDocListEntries([d], {}, {}, {});
    expect(entry).toMatchObject({
      humanCount: 0,
      totalCount: 0,
      divergentCount: 0,
      reviewedCount: 0,
      assignmentStatus: null,
    });
  });
});

describe("resolveEmptyMessage", () => {
  const base = {
    documentsLength: 0,
    isCoordinator: false,
    showingAllQueue: false,
    hasAssignedDocs: false,
    isImpersonating: false,
  };

  it("documentos presentes → 'nenhuma divergência'", () => {
    expect(resolveEmptyMessage({ ...base, documentsLength: 5 })).toMatch(
      /Nenhuma divergência/,
    );
  });

  it("não-coordenador com fila vazia → mensagem de fila", () => {
    expect(resolveEmptyMessage(base)).toMatch(/Nenhum documento na fila/);
  });

  it("coordenador na aba Meus, com atribuídos filtrados → 'não atendem aos filtros'", () => {
    const msg = resolveEmptyMessage({
      ...base,
      isCoordinator: true,
      hasAssignedDocs: true,
    });
    expect(msg).toMatch(/não atendem aos filtros/);
    expect(msg).toMatch(/^Seus/); // 1ª pessoa fora da impersonação
  });

  it("coordenador sem nada atribuído → 'não tem documentos atribuídos'", () => {
    const msg = resolveEmptyMessage({ ...base, isCoordinator: true });
    expect(msg).toMatch(/não tem documentos atribuídos/);
    expect(msg).toMatch(/^Você/);
  });

  it("impersonação muda para 3ª pessoa", () => {
    const filtered = resolveEmptyMessage({
      ...base,
      isCoordinator: true,
      hasAssignedDocs: true,
      isImpersonating: true,
    });
    expect(filtered).toMatch(/^Os documentos atribuídos a este membro/);
    const none = resolveEmptyMessage({
      ...base,
      isCoordinator: true,
      isImpersonating: true,
    });
    expect(none).toMatch(/^Este membro não tem/);
  });

  it("coordenador na aba Todos cai na mensagem genérica de fila", () => {
    expect(
      resolveEmptyMessage({
        ...base,
        isCoordinator: true,
        showingAllQueue: true,
        hasAssignedDocs: true,
      }),
    ).toMatch(/Nenhum documento na fila/);
  });
});

describe("buildCompareMeta", () => {
  const commentCounts = { "d1|campo": 2, "d1|": 3, "d1|outro": 9 };

  it("docTitle cai para external_id e depois 'Documento'", () => {
    const withTitle = buildCompareMeta({
      currentDoc: { id: "d1", title: "Título", external_id: "X", text: "" },
      projectId: "p",
      currentFieldName: "campo",
      commentCountsByKey: {},
      suggestionCountsByField: {},
    });
    expect(withTitle.docTitle).toBe("Título");
    const noTitle = buildCompareMeta({
      currentDoc: { id: "d1", title: null, external_id: "EXT", text: "" },
      projectId: "p",
      currentFieldName: "campo",
      commentCountsByKey: {},
      suggestionCountsByField: {},
    });
    expect(noTitle.docTitle).toBe("EXT");
    const nothing = buildCompareMeta({
      currentDoc: { id: "d1", title: null, external_id: null, text: "" },
      projectId: "p",
      currentFieldName: "campo",
      commentCountsByKey: {},
      suggestionCountsByField: {},
    });
    expect(nothing.docTitle).toBe("Documento");
  });

  it("fieldCommentCount soma comentários do campo e do documento inteiro", () => {
    const meta = buildCompareMeta({
      currentDoc: { id: "d1", title: null, external_id: null, text: "" },
      projectId: "p",
      currentFieldName: "campo",
      commentCountsByKey: commentCounts,
      suggestionCountsByField: { campo: 7 },
    });
    expect(meta.fieldCommentCount).toBe(5); // 2 (campo) + 3 (doc)
    expect(meta.fieldSuggestionCount).toBe(7);
    expect(meta.parecerUrl).toContain("/projects/p/analyze/code?doc=d1");
  });
});

describe("buildComparisonPanel", () => {
  const verdictInfo: VerdictInfo = {
    verdict: "v",
    chosenResponseId: null,
    comment: "c",
  };

  function inputs(over: Record<string, unknown> = {}) {
    const submission = {
      pendingVerdict: null,
      isSavingVerdict: false,
      isSaveInFlight: () => false,
      preparePendingVerdict: vi.fn(),
      submitVerdictSingleFlight: vi.fn(async () => true),
      confirmPendingVerdict: vi.fn(async () => {}),
      discardPendingVerdict: vi.fn(),
    };
    const verdicts = {
      handleVerdict: vi.fn(async () => true),
      handleConfirmEquivalent: vi.fn(async () => {}),
      handleMarkReviewed: vi.fn(async () => {}),
      handleUnmarkPair: vi.fn(async () => {}),
    };
    const fieldData = {
      fieldResponses: [],
      answerGroups: [],
      currentFieldEquivalences: [],
      allowEquivalence: true,
    };
    return {
      submission,
      verdicts,
      fieldData,
      meta: {
        docTitle: "T",
        parecerUrl: "u",
        fieldCommentCount: 1,
        fieldSuggestionCount: 2,
      },
      currentDoc: { id: "d1", title: "T", external_id: null, text: "" },
      currentField: { name: "campo", type: "str", description: "Desc" },
      readOnly: false,
      projectId: "p",
      currentFieldName: "campo",
      fields: [],
      fieldIndex: 0,
      totalFields: 1,
      currentVerdict: verdictInfo,
      reviewed: [true],
      isDivergent: true,
      docStatus: { complete: false } as const,
      comment: "c",
      canManageAnyPair: true,
      currentUserId: "u1",
      onFieldNavigate: vi.fn(),
      onConfirmPendingVerdict: vi.fn(),
      onCommentChange: vi.fn(),
      ...over,
    };
  }

  it("mapeia docStatus, equivalence e wrappers de submit/verdict", () => {
    const inp = inputs();
    const panel = buildComparisonPanel(inp as unknown as PanelInput);
    expect(panel.docStatus).toEqual({ complete: false });
    expect(panel.equivalence).toEqual({ allow: true, canManageAnyPair: true });
    expect(panel.existingVerdict).toBe(verdictInfo);
    expect(panel.commentCount).toBe(1);

    panel.onVerdict("x", "r1");
    expect(inp.submission.submitVerdictSingleFlight).toHaveBeenCalledWith(
      "x",
      "r1",
    );
    panel.onMarkReviewed();
    expect(inp.verdicts.handleMarkReviewed).toHaveBeenCalled();
  });

  it("fieldDescription cai para o nome do campo quando sem description", () => {
    const panel = buildComparisonPanel(
      inputs({
        currentField: { name: "campo", type: "str" },
      }) as unknown as PanelInput,
    );
    expect(panel.fieldDescription).toBe("campo");
  });
});
