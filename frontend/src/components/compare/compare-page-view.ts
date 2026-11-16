// Derivações puras que `ComparePage` fazia inline no render. Extraídas na
// decomposição do container (#564) para tirar ramos do componente e para que
// cada uma seja testável por tabela, sem montar a árvore da Comparação.

import type { ReviewsByDoc } from "@/lib/compare-reviews";
import type { DocCoverage } from "@/lib/compare-queue";
import type { PydanticField } from "@/lib/types";
import type { DocListEntry } from "./CompareDocList";
import type { CompareDocument } from "./compare-types";

// Documento sem linha de cobertura (não deveria acontecer, mas a fila não
// garante) aparece zerado na lista, e não some.
const EMPTY_COVERAGE: Omit<DocCoverage, "docId"> = {
  humanCount: 0,
  totalCount: 0,
  assignedCodingCount: 0,
  humansFromAssigned: 0,
  divergentCount: 0,
  reviewedCount: 0,
  assignmentStatus: null,
};

// Revisados do documento: o servidor conta na carga, mas os vereditos desta
// sessão (`localReviews`) ainda não voltaram dele. Quando o documento já tem
// veredito local, a contagem sai dos campos divergentes revisados aqui.
function reviewedCountOf(
  docId: string,
  serverCount: number,
  divergentFields: Record<string, string[]>,
  localReviews: ReviewsByDoc,
): number {
  const local = localReviews[docId];
  if (!local) return serverCount;
  return (divergentFields[docId] ?? []).filter((fn) => !!local[fn]).length;
}

export function buildDocListEntries(
  documents: CompareDocument[],
  coverageByDoc: Record<string, DocCoverage>,
  divergentFields: Record<string, string[]>,
  localReviews: ReviewsByDoc,
): DocListEntry[] {
  return documents.map((d) => {
    const c = coverageByDoc[d.id] ?? EMPTY_COVERAGE;
    return {
      id: d.id,
      title: d.title,
      external_id: d.external_id,
      humanCount: c.humanCount,
      totalCount: c.totalCount,
      assignedCodingCount: c.assignedCodingCount,
      humansFromAssigned: c.humansFromAssigned,
      divergentCount: c.divergentCount,
      reviewedCount: reviewedCountOf(
        d.id,
        c.reviewedCount,
        divergentFields,
        localReviews,
      ),
      assignmentStatus: c.assignmentStatus,
    };
  });
}

// O `queueContext` do `ComparePage` mais o que a mensagem precisa além dele.
export interface EmptyQueueContext {
  showingAll: boolean;
  hasAssignedDocs: boolean;
  isImpersonating: boolean;
  hasDocuments: boolean;
  isCoordinator: boolean;
}

// Fila pessoal vazia de coordenador tem duas causas bem diferentes:
// (a) nenhum documento atribuído — trocar para "Todos" resolve; (b) há
// atribuídos, mas nenhum passou nos filtros de cobertura/divergência
// (minHumans/minTotal/versão/etc.) — trocar de aba não muda nada, o filtro de
// cobertura é ortogonal ao de assignment. `hasAssignedDocs` (calculado em
// page.tsx a partir do mesmo Set que já filtra a fila) diferencia os dois. Na
// impersonação a fila exibida é a do membro, então o sujeito da copy muda para
// a 3ª pessoa — "você" aqui já foi lido como sendo sobre o membro quando
// descrevia a fila (vazia) do próprio master.
function personalQueueEmptyMessage(
  hasAssignedDocs: boolean,
  isImpersonating: boolean,
): string {
  if (hasAssignedDocs) {
    return isImpersonating
      ? "Os documentos atribuídos a este membro não atendem aos filtros atuais (respostas mínimas, versão, etc.). Ajuste os filtros ou use a aba \"Todos\" para ver a fila completa."
      : "Seus documentos atribuídos não atendem aos filtros atuais (respostas mínimas, versão, etc.). Ajuste os filtros ou use a aba \"Todos\" para ver a fila completa.";
  }
  return isImpersonating
    ? 'Este membro não tem documentos atribuídos para comparação. Use a aba "Todos" acima para ver a fila completa do projeto.'
    : 'Você não tem documentos atribuídos para comparação. Use a aba "Todos" acima para ver a fila completa do projeto.';
}

export function resolveEmptyMessage(ctx: EmptyQueueContext): string {
  if (ctx.hasDocuments) return "Nenhuma divergência neste documento.";
  if (ctx.isCoordinator && !ctx.showingAll) {
    return personalQueueEmptyMessage(ctx.hasAssignedDocs, ctx.isImpersonating);
  }
  return "Nenhum documento na fila com os filtros atuais.";
}

// Comentários do campo exibido: os do par (doc, campo) mais os do documento
// inteiro (chave com campo vazio).
export function fieldCommentCountOf(
  commentCountsByKey: Record<string, number>,
  documentId: string,
  fieldName: string,
): number {
  return (
    (commentCountsByKey[`${documentId}|${fieldName}`] ?? 0) +
    (commentCountsByKey[`${documentId}|`] ?? 0)
  );
}

// Props do painel que descrevem o campo exibido. O rótulo é a descrição, ou o
// nome quando não há.
export function fieldPanelPropsOf(
  field: PydanticField | undefined,
  fieldName: string,
) {
  return {
    fieldName,
    fieldDescription: field?.description || fieldName,
    fieldHelpText: field?.help_text,
    fieldType: field?.type,
    fieldOptions: field?.options,
  };
}

// URL absoluta do parecer (a tela de Codificação no documento). No servidor
// não há origem, e o link sai relativo à raiz.
export function parecerUrlOf(projectId: string, documentId: string): string {
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  return `${baseUrl}/projects/${projectId}/analyze/code?doc=${documentId}`;
}

export function docTitleOf(doc: CompareDocument): string {
  return doc.title || doc.external_id || "Documento";
}
