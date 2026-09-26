// Quando o reconhecimento de um veredito ("Aceitar correção", "Comentar
// dúvida") ainda vale (#758).
//
// A rearbitragem de `submitVerdict` é um upsert que reaproveita o `reviews.id`,
// e `verdict_acknowledgments` aponta para a review por esse id. O
// reconhecimento guarda o texto do veredito reconhecido (`acknowledged_verdict`)
// e vale enquanto ele é o veredito atual da review: mudou, o pesquisador não
// reconheceu o veredito novo. A igualdade é a do texto cru, sem normalização,
// a mesma do gatilho `enforce_verdict_acknowledgment_current`
// (20260927141000_verdict_ack_pinned_verdict.sql), que só deixa gravar o
// reconhecimento com o veredito atual.
//
// Puro e client-safe.

export interface PinnedAcknowledgment {
  /** `verdict_acknowledgments.acknowledged_verdict`. */
  acknowledged_verdict?: string | null;
}

export function acknowledgmentIsCurrent(ack: PinnedAcknowledgment, currentVerdict: string): boolean {
  return typeof ack.acknowledged_verdict === "string" && ack.acknowledged_verdict === currentVerdict;
}
