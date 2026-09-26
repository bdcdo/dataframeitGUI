// Quando um veredito da Comparação (`reviews`) ainda vale como gabarito.
//
// O veredito é sobre a resposta certa de um documento para uma pergunta. Ele
// vale enquanto (1) o campo existe no schema atual, (2) `field_hash`, o hash do
// campo carimbado no veredito pelo banco, é o hash atual do campo, ou é NULL
// (legado, sem como provar a pergunta) e (3) o valor do veredito está no
// domínio atual do campo, conferido só quando o hash é NULL ou o veredito foi
// copiado de uma resposta (`chosen_response_id`). O veredito digitado pelo
// revisor ("Nenhuma correta") com o hash atual vale mesmo fora das opções: as
// opções entram no hash, então o hash igual prova que o texto foi digitado sob
// as opções atuais. O copiado fora das opções é resposta recodificada depois
// sob outra versão, que o backfill pode ter carimbado com o hash novo. A
// rodada não entra na regra, e editar a resposta escolhida depois da
// arbitragem não invalida o veredito.
//
// Todo leitor de `reviews` que trata veredito como gabarito passa por aqui:
// Gabarito, export, métrica e fila do LLM Insights, Comparação, fecho do
// parecer, Meus vereditos, Comentários e a checagem de ambíguo de
// `submitVerdict`. A cópia SQL da regra é `review_verdict_valid` (migration
// 20260926120000_reviews_field_hash.sql), usada por `llm_error_context` e pelas
// invariantes; a matriz de casos do teste SQL é a mesma do teste unitário
// deste módulo.
//
// Puro e client-safe.
import { resolveAllowOther } from "@/lib/pydantic-field";
import type { PydanticField } from "@/lib/types";

/** As colunas de `reviews` de que a regra precisa. */
export interface ValidatableReview {
  field_name: string;
  verdict: string;
  /** `reviews.field_hash`; `null` é veredito legado, anterior ao carimbo. */
  field_hash: string | null;
  /** Presente quando o veredito foi copiado de uma resposta (voto em card). */
  chosen_response_id: string | null;
}

export type ReviewInvalidReason =
  | "campo_removido"
  | "pergunta_alterada"
  | "fora_do_dominio";

export type ReviewValidity =
  | { valid: true }
  | { valid: false; reason: ReviewInvalidReason };

/**
 * Como a tela nomeia o veredito que não vale, por motivo. Fonte única dos
 * rótulos da Comparação, do Gabarito e do LLM Insights: cada tela diz o
 * motivo real, e não "mudança da pergunta" para todos.
 */
export const INVALID_VERDICT_LABELS: Record<ReviewInvalidReason, string> = {
  pergunta_alterada: "Veredito anterior à mudança da pergunta",
  fora_do_dominio: "Veredito fora das opções atuais da pergunta",
  campo_removido: "Veredito de pergunta removida do formulário",
};

type DomainField = Pick<PydanticField, "type" | "options" | "allow_other">;

// Marcadores da Comparação que nunca são resposta (ver compare-types.ts). O
// branco é o voto no grupo de respostas vazias: diz que o documento não traz o
// dado, e não depende das opções.
const DOMAIN_FREE_VERDICTS = new Set(["", "ambiguo", "pular"]);

// Só o espaço comum, como o `btrim` da cópia SQL: `String.prototype.trim` tira
// também tabulação, quebra de linha e NBSP, e as duas cópias divergiriam no
// mesmo veredito.
function trimSpaces(text: string): string {
  return text.replace(/^ +| +$/g, "");
}

/**
 * Se o valor do veredito está no domínio atual do campo. Opção de formulário
 * carrega espaço final e o valor gravado nem sempre, então os dois lados são
 * comparados sem espaço nas pontas.
 */
export function verdictInDomain(verdict: string, field: DomainField): boolean {
  const text = trimSpaces(verdict);
  if (DOMAIN_FREE_VERDICTS.has(text)) return true;
  if (resolveAllowOther(field.allow_other)) return true;
  const options = new Set((field.options ?? []).map(trimSpaces));
  if (options.size === 0) return true;
  if (field.type === "single") return options.has(text);
  if (field.type === "multi") return multiVerdictInDomain(text, options);
  return true;
}

// O veredito de `multi` votado na grade é o JSON `{opção: bool}`, e só as
// opções marcadas `true` precisam existir. O votado em card (pergunta que era
// `single` quando foi arbitrada) é o texto "A, B": vale se o texto inteiro é
// uma opção ou se cada parte separada por ", " é. Opção que contém ", " num
// veredito em texto cai como fora do domínio; é o único falso negativo, e só
// alcança veredito legado, sem hash, de campo que virou `multi`.
function multiVerdictInDomain(text: string, options: ReadonlySet<string>): boolean {
  if (text.startsWith("{")) {
    const selection = parseSelection(text);
    if (selection) {
      return Object.entries(selection).every(
        ([option, marked]) => marked !== true || options.has(trimSpaces(option)),
      );
    }
  }
  return options.has(text) || text.split(", ").every((part) => options.has(trimSpaces(part)));
}

function parseSelection(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A regra inteira, com o motivo quando o veredito não vale. */
export function reviewValidity(
  review: ValidatableReview,
  field: (DomainField & Pick<PydanticField, "hash">) | undefined,
): ReviewValidity {
  if (!field) return { valid: false, reason: "campo_removido" };
  // `field.hash` ausente com veredito carimbado não prova a pergunta: é a
  // mesma leitura de `p_field_hash = p_field->>'hash'` na cópia SQL, que dá
  // NULL e reprova.
  if (review.field_hash !== null && review.field_hash !== field.hash) {
    return { valid: false, reason: "pergunta_alterada" };
  }
  const domainApplies = review.field_hash === null || review.chosen_response_id !== null;
  if (domainApplies && !verdictInDomain(review.verdict, field)) {
    return { valid: false, reason: "fora_do_dominio" };
  }
  return { valid: true };
}

export function reviewIsValid(
  review: ValidatableReview,
  field: (DomainField & Pick<PydanticField, "hash">) | undefined,
): boolean {
  return reviewValidity(review, field).valid;
}

/** O que `pickCellReview` precisa para desempatar. */
export interface OrderableReview {
  id: string;
  created_at: string;
}

/**
 * A review que vale por (documento, campo) quando há mais de uma: a mais
 * recente por `created_at`, e entre iguais a de maior `id`. Recebe só reviews
 * válidas de UMA célula; filtrar é trabalho do chamador (ou de
 * `pickValidCellReviews`).
 *
 * `created_at` é a data da primeira gravação do revisor na célula: o upsert de
 * rearbitragem de `submitVerdict` não a move. Entre dois revisores, vence quem
 * arbitrou a célula pela primeira vez mais tarde, e não quem a rearbitrou por
 * último; `reviews` não tem coluna que registre a rearbitragem.
 */
export function pickCellReview<R extends OrderableReview>(reviews: readonly R[]): R | undefined {
  let winner: R | undefined;
  for (const review of reviews) {
    if (!winner || isNewer(review, winner)) winner = review;
  }
  return winner;
}

function isNewer(candidate: OrderableReview, incumbent: OrderableReview): boolean {
  // Por instante, não pelo texto: o PostgREST e as fixtures não serializam o
  // timestamptz sempre com o mesmo fuso e a mesma precisão.
  const byTime = Date.parse(candidate.created_at) - Date.parse(incumbent.created_at);
  if (byTime !== 0) return byTime > 0;
  return candidate.id > incumbent.id;
}

export function cellKey(documentId: string, fieldName: string): string {
  return `${documentId}:${fieldName}`;
}

/**
 * Uma review válida por (documento, campo), escolhida por `pickCellReview`,
 * indexada por `cellKey`. Célula cujas reviews são todas inválidas fica de
 * fora: ela volta ao consenso ou à Comparação.
 */
export function pickValidCellReviews<
  R extends ValidatableReview & OrderableReview & { document_id: string },
>(
  reviews: readonly R[] | null | undefined,
  fieldByName: ReadonlyMap<string, PydanticField>,
): Map<string, R> {
  const validByCell = new Map<string, R[]>();
  for (const review of reviews ?? []) {
    if (!reviewIsValid(review, fieldByName.get(review.field_name))) continue;
    const key = cellKey(review.document_id, review.field_name);
    const bucket = validByCell.get(key);
    if (bucket) bucket.push(review);
    else validByCell.set(key, [review]);
  }
  const picked = new Map<string, R>();
  for (const [key, bucket] of validByCell) picked.set(key, pickCellReview(bucket)!);
  return picked;
}
