// Ordem A/B do par (humano, llm) na arbitragem cega. Determinada por hash
// do field_review.id para que re-renders nao reordenem e re-aberturas em
// outro dispositivo preservem a apresentacao.
//
// Determinismo e propriedade testavel — se mudar o algoritmo, qualquer
// arbitragem em andamento muda de A/B no meio.
export type ABOrder = "human_first" | "llm_first";

export function assignOrder(fieldReviewId: string): ABOrder {
  let h = 0;
  for (let i = 0; i < fieldReviewId.length; i++) {
    h = (h * 31 + fieldReviewId.charCodeAt(i)) >>> 0;
  }
  return h % 2 === 0 ? "human_first" : "llm_first";
}
