// Corpo do comentário kind='ambiguity' que o veredito "Ambíguo" da aba Comparar
// cria para a célula (`syncAmbiguityComment` em actions/reviews.ts). Fonte única
// do texto: a aba Comentários também o usa para reconhecer o card da revisão
// que ele repete (`buildOrderedComments`).
export function ambiguityCommentBody(comment: string | null | undefined): string {
  const note = comment?.trim();
  return note
    ? `Campo marcado como ambíguo na revisão (aba Comparar): ${note}`
    : "Campo marcado como ambíguo na revisão (aba Comparar).";
}
