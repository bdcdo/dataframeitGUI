"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import {
  submitVerdict,
  markCompareDocReviewed,
  type ResponseSnapshotEntry,
} from "@/actions/reviews";
import {
  confirmEquivalentVerdict,
  unmarkEquivalencePair,
} from "@/actions/equivalences";
import type { ReviewsByDoc, VerdictInfo } from "@/lib/compare-reviews";
import type { CompareDocument, FieldResponse } from "./compare-types";

interface UseCompareVerdictsParams {
  projectId: string;
  currentDoc: CompareDocument | undefined;
  currentFieldName: string;
  isCurrentFieldDivergent: boolean;
  allDocDivergent: string[];
  localReviews: ReviewsByDoc;
  fieldResponses: FieldResponse[];
  comment: string;
  recordReview: (docId: string, fieldName: string, info: VerdictInfo) => void;
  goNextField: () => void;
}

export interface CompareVerdicts {
  handleVerdict: (verdict: string, chosenResponseId?: string) => Promise<void>;
  handleConfirmEquivalent: (
    responseIds: string[],
    gabaritoId: string,
    verdictDisplay: string,
  ) => Promise<void>;
  handleMarkReviewed: () => Promise<void>;
  handleUnmarkPair: (pairId: string) => Promise<void>;
}

/** Snapshot das respostas presentes no momento do veredito (auditoria). */
function buildSnapshot(fieldResponses: FieldResponse[]): ResponseSnapshotEntry[] {
  return fieldResponses
    .filter((r) => r.answer !== undefined)
    .map((r) => ({
      id: r.id,
      respondent_name: r.respondent_name,
      respondent_type: r.respondent_type,
      answer: r.answer,
      ...(r.justification ? { justification: r.justification } : {}),
    }));
}

/**
 * Handlers de submissão de veredito (regular e por equivalência) + marcar
 * revisado / desfazer equivalência. Extraído de `ComparePage` para tirar ~140
 * linhas do container (`no-giant-component`). A escrita otimista vai por
 * `recordReview` (overrides); o avanço de campo por `goNextField` (que já faz
 * o clamp de limite).
 *
 * O comentário NÃO é limpo aqui após o sucesso: quando há avanço, o guard de
 * render de `ComparePage` re-semeia a caixa do veredito do novo campo (""); se
 * o campo permanece (filtro de campo único ou último campo divergente), o
 * comentário recém-salvo continua visível na caixa, em vez de sumir.
 */
export function useCompareVerdicts({
  projectId,
  currentDoc,
  currentFieldName,
  isCurrentFieldDivergent,
  allDocDivergent,
  localReviews,
  fieldResponses,
  comment,
  recordReview,
  goNextField,
}: UseCompareVerdictsParams): CompareVerdicts {
  const handleVerdict = useCallback(
    async (verdict: string, chosenResponseId?: string) => {
      if (!currentDoc || !currentFieldName || !isCurrentFieldDivergent) return;

      const verdictComment = comment || undefined;
      const info: VerdictInfo = {
        verdict,
        chosenResponseId: chosenResponseId ?? null,
        comment: verdictComment ?? null,
      };
      recordReview(currentDoc.id, currentFieldName, info);

      const result = await submitVerdict(
        projectId,
        currentDoc.id,
        currentFieldName,
        verdict,
        chosenResponseId,
        verdictComment,
        buildSnapshot(fieldResponses),
      );
      if (result?.error) {
        toast.error(result.error);
        return;
      }

      toast.success("Veredito salvo!");

      // Usa `info` recém-emitido sobre o estado atual (que o setState ainda não
      // refletiu neste closure) para decidir se o documento fechou.
      const nextDocReviews = {
        ...localReviews[currentDoc.id],
        [currentFieldName]: info,
      };
      const allFieldsReviewed = allDocDivergent.every(
        (fn) => !!nextDocReviews[fn],
      );
      if (allFieldsReviewed) {
        toast.success("Revisão do documento concluída!");
      } else {
        goNextField();
      }
    },
    [
      projectId,
      currentDoc,
      currentFieldName,
      isCurrentFieldDivergent,
      allDocDivergent,
      localReviews,
      comment,
      fieldResponses,
      recordReview,
      goNextField,
    ],
  );

  const handleConfirmEquivalent = useCallback(
    async (
      responseIds: string[],
      gabaritoId: string,
      verdictDisplay: string,
    ) => {
      if (!currentDoc || !currentFieldName || !isCurrentFieldDivergent) return;

      const verdictComment = comment || undefined;
      const docId = currentDoc.id;
      const fieldName = currentFieldName;
      const info: VerdictInfo = {
        verdict: verdictDisplay,
        chosenResponseId: gabaritoId,
        comment: verdictComment ?? null,
      };
      recordReview(docId, fieldName, info);

      const result = await confirmEquivalentVerdict(
        projectId,
        docId,
        fieldName,
        responseIds,
        gabaritoId,
        verdictDisplay,
        verdictComment,
        buildSnapshot(fieldResponses),
      );
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `${responseIds.length} respostas marcadas como equivalentes.`,
      );

      const nextDocReviews = { ...localReviews[docId], [fieldName]: info };
      const allFieldsReviewed = allDocDivergent.every(
        (fn) => !!nextDocReviews[fn],
      );
      if (allFieldsReviewed) {
        toast.success("Revisão do documento concluída!");
      } else {
        goNextField();
      }
    },
    [
      projectId,
      currentDoc,
      currentFieldName,
      isCurrentFieldDivergent,
      allDocDivergent,
      localReviews,
      comment,
      fieldResponses,
      recordReview,
      goNextField,
    ],
  );

  const handleMarkReviewed = useCallback(async () => {
    if (!currentDoc) return;
    const result = await markCompareDocReviewed(projectId, currentDoc.id);
    if (result?.error) {
      toast.error(result.error);
      return;
    }
    toast.success("Documento marcado como revisado.");
  }, [projectId, currentDoc]);

  const handleUnmarkPair = useCallback(
    async (pairId: string) => {
      const result = await unmarkEquivalencePair(projectId, pairId);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Equivalência removida.");
    },
    [projectId],
  );

  return {
    handleVerdict,
    handleConfirmEquivalent,
    handleMarkReviewed,
    handleUnmarkPair,
  };
}
