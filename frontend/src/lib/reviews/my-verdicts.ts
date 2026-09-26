// Montagem pura da aba "Meus vereditos" (reviews/my-verdicts/page.tsx): os
// vereditos que valem como gabarito sobre as respostas de um respondente.
import { isAnswerCorrect } from "@/lib/reviews/queries";
import { pickValidCellReviews } from "@/lib/review-validity";
import { acknowledgmentIsCurrent, type PinnedAcknowledgment } from "@/lib/reviews/verdict-acknowledgment";
import type { PydanticField } from "@/lib/types";

export interface VerdictItem {
  reviewId: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  fieldType: "single" | "multi" | "text" | "date";
  verdict: string;
  coordinatorComment: string | null;
  myAnswer: unknown;
  isCorrect: boolean;
  responseSnapshot: Array<{
    id: string;
    respondent_name: string;
    respondent_type: "humano" | "llm";
    answer: unknown;
    justification?: string;
  }> | null;
  acknowledgmentStatus: "pending" | "accepted" | "questioned" | null;
  acknowledgmentComment: string | null;
  /**
   * O respondente reconheceu um veredito anterior desta review, que foi
   * rearbitrada depois (#758). O reconhecimento antigo não vale, e o item
   * volta a pedir resposta.
   */
  acknowledgmentOutdated: boolean;
}

export interface MyVerdictReviewRow {
  id: string;
  document_id: string;
  field_name: string;
  verdict: string;
  comment: string | null;
  response_snapshot: unknown;
  created_at: string;
  /** `reviews.field_hash`: o hash do campo quando a arbitragem foi feita. */
  field_hash: string | null;
  chosen_response_id: string | null;
}

interface BuildMyVerdictItemsInput {
  reviews: readonly MyVerdictReviewRow[];
  fields: readonly PydanticField[];
  /** Respostas do respondente, por documento. */
  myAnswersByDoc: ReadonlyMap<string, Record<string, unknown>>;
  docTitles: ReadonlyMap<string, string>;
  acknowledgments: ReadonlyMap<string, StoredAcknowledgment>;
}

type StoredAcknowledgment = { status: string; comment: string | null } & PinnedAcknowledgment;

/**
 * Um item por (documento, campo) em que o respondente respondeu e há veredito
 * que vale, pela regra única de `review-validity.ts`: a mesma review que o
 * Gabarito mostra para a célula. Veredito dado sobre outra versão da pergunta
 * não entra: dizer ao pesquisador que ele errou contra uma pergunta que não
 * existe mais seria falso, e a célula volta à Comparação.
 */
export function buildMyVerdictItems({
  reviews, fields, myAnswersByDoc, docTitles, acknowledgments,
}: BuildMyVerdictItemsInput): VerdictItem[] {
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  return [...pickValidCellReviews(reviews, fieldByName).values()].flatMap((r) => {
    const myAnswer = myAnswersByDoc.get(r.document_id)?.[r.field_name];
    if (myAnswer === undefined) return [];
    return [toVerdictItem(r, myAnswer, fieldByName.get(r.field_name), docTitles, acknowledgments.get(r.id))];
  });
}

function toVerdictItem(
  r: MyVerdictReviewRow,
  myAnswer: unknown,
  field: PydanticField | undefined,
  docTitles: ReadonlyMap<string, string>,
  stored: StoredAcknowledgment | undefined,
): VerdictItem {
  const fieldType = (field?.type || "text") as VerdictItem["fieldType"];
  return {
    reviewId: r.id,
    documentId: r.document_id,
    documentTitle: docTitles.get(r.document_id) || r.document_id,
    fieldName: r.field_name,
    fieldDescription: field?.description || r.field_name,
    fieldType,
    verdict: r.verdict,
    coordinatorComment: r.comment,
    myAnswer,
    isCorrect: isAnswerCorrect(myAnswer, r.verdict, fieldType),
    responseSnapshot: r.response_snapshot as VerdictItem["responseSnapshot"],
    ...acknowledgmentOf(stored, r.verdict),
  };
}

// O reconhecimento só vale enquanto o veredito reconhecido é o atual da
// review; o de um veredito anterior não conta e marca o item como desatualizado.
function acknowledgmentOf(
  stored: StoredAcknowledgment | undefined,
  currentVerdict: string,
): Pick<VerdictItem, "acknowledgmentStatus" | "acknowledgmentComment" | "acknowledgmentOutdated"> {
  const ack = stored && acknowledgmentIsCurrent(stored, currentVerdict) ? stored : undefined;
  return {
    acknowledgmentStatus: (ack?.status as VerdictItem["acknowledgmentStatus"]) ?? null,
    acknowledgmentComment: ack?.comment ?? null,
    acknowledgmentOutdated: stored !== undefined && ack === undefined,
  };
}
