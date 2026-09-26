// Primitivas da relação entre uma resposta e o schema contra o qual ela foi
// codificada — ou seja, tudo que se apoia em `responses.answer_field_hashes`.
// Puro/client-safe: usado por server actions, componentes client e testes.
//
// Fonte única da relação entre uma resposta e o schema por campo. Uma chave
// com hash conhecido permite comparar versões; `null` prova apenas que o campo
// existia. Ausência em mapa não vazio significa que ele ainda não existia.
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

// Projeção `name -> hash` de um conjunto de campos. A chave sempre existe;
// `null` representa um campo cuja proveniência não pode ser provada.
export function buildFieldHashMap(
  fields: PydanticField[],
): Record<string, string | null> {
  return Object.fromEntries(fields.map((field) => [field.name, field.hash ?? null]));
}

// True a menos que a response comprovadamente não tivesse o campo no schema
// contra o qual foi codificada. `null`/`undefined`/`{}` são legacy (response
// pré-coluna, ou schema sem hashes populados): não dá para inferir, então
// assume que o campo existia — sem isso, um campo obrigatório adicionado DEPOIS
// tornaria toda codificação anterior falsamente incompleta, e toda comparação
// antiga geraria um falso "(vazio)" divergente.
export function fieldExistedWhenCoded(
  answerFieldHashes: AnswerFieldHashes | undefined,
  fieldName: string,
): boolean {
  if (!answerFieldHashes) return true;
  if (Object.keys(answerFieldHashes).length === 0) return true;
  return Object.hasOwn(answerFieldHashes, fieldName);
}

interface FieldStalenessInput {
  /** Snapshot per-campo da response. `null`/ausente cai no fallback legacy. */
  answerFieldHashes: AnswerFieldHashes | undefined;
  /** Hash do schema inteiro na response — só usado no fallback legacy. */
  pydanticHash: string | null;
  fieldName: string;
  /** `buildFieldHashMap` dos campos atuais do projeto. */
  currentFieldHashes: Record<string, string | null>;
  /** Hash do schema inteiro no projeto — só usado no fallback legacy. */
  projectPydanticHash: string | null;
}

// True quando o campo mudou entre o schema da codificação e o atual. Um dos
// lados faltando também conta como stale: não dá para provar que é o mesmo
// campo. Sem o snapshot per-campo (response legacy) resta comparar o hash do
// schema INTEIRO, que marca stale todo campo de uma response antiga mesmo que
// só um campo alheio tenha mudado — é grosseiro de propósito, é só o fallback.
export function isFieldStale({
  answerFieldHashes,
  pydanticHash,
  fieldName,
  currentFieldHashes,
  projectPydanticHash,
}: FieldStalenessInput): boolean {
  if (answerFieldHashes && Object.keys(answerFieldHashes).length > 0) {
    const saved = Object.hasOwn(answerFieldHashes, fieldName)
      ? answerFieldHashes[fieldName]
      : undefined;
    const current = Object.hasOwn(currentFieldHashes, fieldName)
      ? currentFieldHashes[fieldName]
      : undefined;
    return !saved || !current || saved !== current;
  }
  return !!projectPydanticHash && pydanticHash !== projectPydanticHash;
}

// Se a resposta ao campo foi dada à versão ATUAL da pergunta, para os
// julgamentos presos a respostas (o par "=" da Comparação). Só o hash gravado
// na resposta prova a versão: diferente do atual, ou campo que saiu do schema
// (removido ou renomeado), reprova. Sem hash do campo na resposta (mapa legado
// `null`/`{}`, chave ausente ou `null`) não há como provar, e a ausência não
// invalida sozinha, a mesma política de `reviews.field_hash` NULL em
// `review-validity.ts`. Campo atual sem hash com resposta carimbada reprova,
// como lá.
//
// Diferente de `isFieldStale`, que marca como desatualizada a resposta sem
// proveniência: aquela é a leitura da tela (avisar o revisor), esta decide se
// um julgamento já feito cai.
//
// A cópia SQL é `response_answers_current_question`, com a mesma matriz de
// casos nos testes: com ela o banco recusa gravar o par de outra versão
// (`record_response_equivalences`) e, no save do schema, leva ao reconciliador
// o documento cujo par deixou de valer. O banco não arquiva o par quando a
// pergunta muda (a resposta recodificada com outro valor já o arquiva pelo
// gatilho de resposta), e todo leitor de par passa por
// `filterCurrentEquivalencePairs`.
export function answersCurrentQuestion(
  answerFieldHashes: AnswerFieldHashes | undefined,
  field: Pick<PydanticField, "name" | "hash"> | undefined,
): boolean {
  if (!field) return false;
  // Sem `Object.hasOwn`: o que o protótipo devolve para um nome como
  // "constructor" não é string e cai no mesmo caso da chave ausente.
  const saved: unknown = answerFieldHashes?.[field.name];
  if (typeof saved !== "string") return true;
  return saved === field.hash;
}
