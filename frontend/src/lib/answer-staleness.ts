// Primitivas da relação entre uma resposta e o schema contra o qual ela foi
// codificada — ou seja, tudo que se apoia em `responses.answer_field_hashes`.
// Puro/client-safe: usado por server actions, componentes client e testes.
//
// O contrato da coluna está declarado em `types.ts` (ver `AnswerFieldHashes`):
// snapshot POR CAMPO do schema contra o qual a response foi codificada, com uma
// chave por campo existente na época e valor = `field.hash`. Daí saem as duas
// perguntas que este módulo responde, e que são as duas caras do mesmo dado:
//   - chave ausente  → o campo não existia na época   (fieldExistedWhenCoded)
//   - chave presente com hash diferente → o campo mudou desde então (isFieldStale)
//
// Antes desta extração cada uma vivia duplicada: `fieldExistedWhenCoded` era
// idêntica a `responseHadField` de compare-divergence, e `isFieldStale` existia
// em duas cópias (reviews/queries e useCompareFieldData) — as duas sem teste.
// Como `field.hash` cobre name|type|options|description (ver `computeFieldHash`
// em schema-utils), mudar as OPÇÕES de um campo muda seu hash; é o que faz o
// sinal de staleness existir no cenário da #484.
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

// Projeção `name -> hash` de um conjunto de campos. Campos sem `.hash` são
// omitidos: `hash` só é populado por `planSchemaChange`, então um schema que
// nunca passou por lá produz `{}` — que os leitores abaixo tratam como legacy.
export function buildFieldHashMap(
  fields: PydanticField[],
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const f of fields) {
    if (f.hash) hashes[f.name] = f.hash;
  }
  return hashes;
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
  return Object.prototype.hasOwnProperty.call(answerFieldHashes, fieldName);
}

export interface FieldStalenessInput {
  /** Snapshot per-campo da response. `null`/ausente cai no fallback legacy. */
  answerFieldHashes: AnswerFieldHashes | undefined;
  /** Hash do schema inteiro na response — só usado no fallback legacy. */
  pydanticHash: string | null;
  fieldName: string;
  /** `buildFieldHashMap` dos campos atuais do projeto. */
  currentFieldHashes: Record<string, string>;
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
  if (answerFieldHashes) {
    const saved = answerFieldHashes[fieldName];
    const current = currentFieldHashes[fieldName];
    return !saved || !current || saved !== current;
  }
  return !!projectPydanticHash && pydanticHash !== projectPydanticHash;
}

// Snapshot a gravar num save que preservou valores que ele não coletou.
//
// `saveResponse` grava a coluna inteira a partir dos campos ATUAIS, o que só é
// correto enquanto todo valor persistido tiver acabado de passar pelo
// formulário atual. Desde a #484 isso deixou de valer: o save herda de `stored`
// os valores que a leitura descartou por estarem fora das opções atuais, e
// carimbá-los com o hash novo os faria passar por respostas ao schema vigente —
// apagando o único sinal de staleness do produto (`isFieldStale`) justamente
// nos campos que mais precisam dele, e que a #216 usa para saber o que pedir ao
// pesquisador.
//
// `inheritedFieldNames` são os campos cujo valor veio de `stored` sem passar
// pelo submit; para eles o hash da época é preservado. O resto do mapa segue
// sendo o schema atual, então campo novo continua entrando (e sendo exigido por
// `fieldExistedWhenCoded`) exatamente como antes.
export function mergeFieldHashes(
  storedHashes: AnswerFieldHashes,
  currentHashes: Record<string, string>,
  inheritedFieldNames: Iterable<string>,
): Record<string, string> {
  if (!storedHashes) return currentHashes;
  const merged = { ...currentHashes };
  for (const name of inheritedFieldNames) {
    const saved = storedHashes[name];
    if (saved) merged[name] = saved;
  }
  return merged;
}
