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
  readOnly: boolean;
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
  handleVerdict: (verdict: string, chosenResponseId?: string) => Promise<boolean>;
  handleConfirmEquivalent: (
    responseIds: string[],
    gabaritoId: string,
    verdictDisplay: string,
  ) => Promise<void>;
  handleMarkReviewed: () => Promise<void>;
  handleUnmarkPair: (pairId: string) => Promise<void>;
}

export const SAVE_TIMEOUT_MS = 15_000;
const TIMEOUT_MESSAGE =
  "O salvamento não respondeu. Verifique a conexão e tente novamente.";

/**
 * Resolve a promise de uma server action em "salvou?", exibindo o toast
 * adequado no caminho de erro. Ponto único para os três modos de falha:
 * rejeição da action (fora do try dela, que o `void` do call site
 * descartaria em silêncio) vira log + mensagem genérica; `{ error }`
 * retornado vira toast com a mensagem da própria action; e uma promise que
 * NUNCA settles (fetch dropado num redeploy — issue #430) é resolvida como
 * erro pelo timeout, senão o `await` do chamador ficaria pendurado para
 * sempre com a trava de in-flight presa. Após o timeout, o settle tardio da
 * promise original é ignorado por completo — nenhum efeito pós-save (escrita
 * otimista, toast de sucesso, avanço de campo) roda fora de hora; se o save
 * tardio tiver persistido no servidor, reconfirmar recai no upsert
 * idempotente de `submitVerdict`.
 */
async function actionSucceeded(
  promise: Promise<{ error?: string }>,
  logLabel: string,
  logContext: Record<string, unknown>,
  rejectionMessage: string,
): Promise<boolean> {
  const result = await new Promise<{ error?: string } | void>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ error: TIMEOUT_MESSAGE });
    }, SAVE_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // Rejeição tardia: o timeout já reportou o erro; um segundo toast
        // aqui chegaria fora de contexto.
        if (timedOut) return;
        console.error(logLabel, { error, ...logContext });
        toast.error(rejectionMessage);
        resolve({ error: "unexpected" });
      },
    );
  });
  if (result?.error) {
    if (result.error !== "unexpected") toast.error(result.error);
    return false;
  }
  return true;
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

function canSubmitCompareVerdict(
  readOnly: boolean,
  currentDoc: CompareDocument | undefined,
  currentFieldName: string,
  isCurrentFieldDivergent: boolean,
): currentDoc is CompareDocument {
  return (
    !readOnly &&
    currentDoc !== undefined &&
    currentFieldName.length > 0 &&
    isCurrentFieldDivergent
  );
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
  readOnly,
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
      if (
        !canSubmitCompareVerdict(
          readOnly,
          currentDoc,
          currentFieldName,
          isCurrentFieldDivergent,
        )
      ) {
        return false;
      }

      const verdictComment = comment || undefined;
      const info: VerdictInfo = {
        verdict,
        chosenResponseId: chosenResponseId ?? null,
        comment: verdictComment ?? null,
      };
      const saved = await actionSucceeded(
        submitVerdict(
          projectId,
          currentDoc.id,
          currentFieldName,
          verdict,
          chosenResponseId,
          verdictComment,
          buildSnapshot(fieldResponses),
          readOnly,
        ),
        "Failed to submit compare verdict",
        {
          projectId,
          documentId: currentDoc.id,
          fieldName: currentFieldName,
          verdict,
          chosenResponseId,
        },
        "Não foi possível salvar o veredito. Tente novamente antes de avançar.",
      );
      if (!saved) return false;

      // Escrita otimista só após o sucesso: `recordReview` grava em `overrides`
      // (estado da sessão, não auto-revertido). Gravar antes deixaria o campo
      // exibido como revisado mesmo quando o save falha, até um reload.
      recordReview(currentDoc.id, currentFieldName, info);

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
      return true;
    },
    [
      readOnly,
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
      if (
        !canSubmitCompareVerdict(
          readOnly,
          currentDoc,
          currentFieldName,
          isCurrentFieldDivergent,
        )
      ) {
        return;
      }

      const verdictComment = comment || undefined;
      const docId = currentDoc.id;
      const fieldName = currentFieldName;
      const info: VerdictInfo = {
        verdict: verdictDisplay,
        chosenResponseId: gabaritoId,
        comment: verdictComment ?? null,
      };
      const saved = await actionSucceeded(
        confirmEquivalentVerdict(
          projectId,
          docId,
          fieldName,
          responseIds,
          gabaritoId,
          verdictDisplay,
          verdictComment,
          buildSnapshot(fieldResponses),
          readOnly,
        ),
        "Failed to confirm equivalent verdict",
        { projectId, documentId: docId, fieldName },
        "Não foi possível salvar a equivalência. Tente novamente antes de avançar.",
      );
      if (!saved) return;

      // Escrita otimista só após o sucesso (ver handleVerdict): não deixar o
      // campo/doc exibido como revisado quando a marcação de equivalência falha.
      recordReview(docId, fieldName, info);

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
      readOnly,
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
    if (readOnly || !currentDoc) return;
    const saved = await actionSucceeded(
      markCompareDocReviewed(projectId, currentDoc.id, readOnly),
      "Failed to mark compare doc reviewed",
      { projectId, documentId: currentDoc.id },
      "Não foi possível marcar o documento como revisado. Tente novamente.",
    );
    if (!saved) return;
    toast.success("Documento marcado como revisado.");
  }, [readOnly, projectId, currentDoc]);

  const handleUnmarkPair = useCallback(
    async (pairId: string) => {
      if (readOnly) return;
      const saved = await actionSucceeded(
        unmarkEquivalencePair(projectId, pairId, readOnly),
        "Failed to unmark equivalence pair",
        { projectId, pairId },
        "Não foi possível remover a equivalência. Tente novamente.",
      );
      if (!saved) return;
      toast.success("Equivalência removida.");
    },
    [readOnly, projectId],
  );

  return {
    handleVerdict,
    handleConfirmEquivalent,
    handleMarkReviewed,
    handleUnmarkPair,
  };
}
