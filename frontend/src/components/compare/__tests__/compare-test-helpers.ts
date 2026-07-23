import { vi } from "vitest";
import type { CompareDocument } from "@/components/compare/compare-types";
import type { ComparisonPanel } from "@/components/compare/ComparisonPanel";
import type { PydanticField } from "@/lib/types";

/**
 * Fixture de `CompareDocument` compartilhada entre os testes de hooks de
 * compare/ — evita reimplementar a mesma forma em cada arquivo (useStableDocOrder,
 * useCompareNavigation, useCompareVerdicts).
 */
export function doc(id: string, title?: string, text = ""): CompareDocument {
  return {
    id,
    title: title ?? `Doc ${id}`,
    external_id: null,
    text,
  };
}

export type PanelProps = Parameters<typeof ComparisonPanel>[0];
export type PanelResponse = PanelProps["responses"][number];

/**
 * Resposta de comparação com os campos obrigatórios preenchidos. `answer`
 * default é `undefined` — "a resposta não tem este campo" —, que é justamente
 * o caso que o painel trata de forma especial.
 */
export function panelResponse(
  over: Partial<PanelResponse> & { id: string },
): PanelResponse {
  return {
    respondent_type: "humano",
    respondent_name: "Anon",
    respondent_id: null,
    answer: undefined,
    is_latest: true,
    isFieldStale: false,
    ...over,
  };
}

/**
 * Props completas do `ComparisonPanel`, com os ~30 callbacks e flags que o
 * componente exige preenchidos por default. Cada arquivo de teste sobrescreve
 * só o que o caso exercita.
 *
 * Existe porque a interface do painel é larga: sem uma base compartilhada, cada
 * arquivo reimplementava o objeto inteiro e um prop novo obrigava a editar
 * todos eles. Note que `pendingVerdict` costuma ser estado do harness do
 * chamador — passar o valor inicial aqui e deixar o componente sob teste
 * receber o valor stateful continua sendo responsabilidade de quem renderiza.
 */
export function panelProps(over: Partial<PanelProps> = {}): PanelProps {
  const field = {
    name: "campo",
    type: "text",
    description: "Campo",
  } as PydanticField;
  return {
    readOnly: false,
    projectId: "p1",
    documentId: "d1",
    documentTitle: "Doc 1",
    fieldName: field.name,
    fieldDescription: field.description ?? "",
    fieldType: "text",
    fieldOptions: null,
    fields: [field],
    fieldIndex: 0,
    totalFields: 1,
    responses: [],
    existingVerdict: null,
    reviewed: [false],
    isDivergent: true,
    docStatus: { complete: false },
    onFieldNavigate: vi.fn(),
    onVerdict: vi.fn(),
    pendingVerdict: null,
    onPrepareVerdict: vi.fn(),
    onConfirmPendingVerdict: vi.fn(),
    onDiscardPendingVerdict: vi.fn(),
    isSavingVerdict: false,
    onMarkReviewed: vi.fn(),
    comment: "",
    onCommentChange: vi.fn(),
    commentCount: 0,
    suggestionCount: 0,
    equivalence: { allow: false, canManageAnyPair: false },
    equivalences: [],
    onConfirmEquivalent: vi.fn(async () => {}),
    onUnmarkEquivalencePair: vi.fn(async () => {}),
    currentUserId: "u1",
    ...over,
  };
}
