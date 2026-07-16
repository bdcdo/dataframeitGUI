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
