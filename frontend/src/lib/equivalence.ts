import { normalizeForComparison } from "@/lib/utils";
import { answersCurrentQuestion } from "@/lib/answer-staleness";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

// Equivalência "=" por VALOR (`value_equivalences`, migration
// 20261112120000): "no campo X, na versão da pergunta com hash H, o valor A
// equivale ao valor B", no projeto inteiro. Não depende de resposta, então
// sobrevive a uma execução nova do LLM e a uma recodificação que reproduz os
// mesmos valores; cai quando a pergunta muda (o save do schema a leva ao
// histórico, e a leitura abaixo também a ignora com hash diferente).

export interface ValueEquivalence {
  id: string;
  field_name: string;
  field_hash: string;
  value_a: unknown;
  value_b: unknown;
  reviewer_id: string | null;
}

// Colunas que todo leitor de equivalência seleciona. Fonte única para que
// nenhum leitor esqueça `field_hash` e use uma equivalência de outra versão
// da pergunta.
export const VALUE_EQUIVALENCE_SELECT =
  "id, field_name, field_hash, value_a, value_b, reviewer_id";

// Equivalências do projeto agrupadas por campo. O escopo é o projeto: a
// mesma lista vale para todos os documentos.
export type ValueEquivalencesByField = ReadonlyMap<string, readonly ValueEquivalence[]>;

export function groupValueEquivalencesByField(
  rows: readonly ValueEquivalence[] | null | undefined,
): Map<string, ValueEquivalence[]> {
  const byField = new Map<string, ValueEquivalence[]>();
  for (const row of rows ?? []) {
    const list = byField.get(row.field_name);
    const equivalence: ValueEquivalence = {
      id: row.id,
      field_name: row.field_name,
      field_hash: row.field_hash,
      value_a: row.value_a,
      value_b: row.value_b,
      reviewer_id: row.reviewer_id ?? null,
    };
    if (list) list.push(equivalence);
    else byField.set(row.field_name, [equivalence]);
  }
  return byField;
}

// A identidade de um valor para a equivalência: a mesma de "mesma resposta"
// da Comparação (sem acento, caixa, espaços colapsados e aparados; listas
// elemento a elemento). O banco guarda o valor bruto; a chave só existe aqui.
export function equivalenceValueKey(value: unknown): string {
  return normalizeForComparison(value);
}

// As equivalências que valem para o campo na versão atual da pergunta. Campo
// fora do schema, ou sem hash, não tem como provar a versão: nenhuma vale.
export function currentValueEquivalences(
  equivalences: readonly ValueEquivalence[] | undefined,
  field: Pick<PydanticField, "name" | "hash"> | undefined,
): ValueEquivalence[] {
  if (!field || typeof field.hash !== "string") return [];
  return (equivalences ?? []).filter(
    (equivalence) =>
      equivalence.field_name === field.name && equivalence.field_hash === field.hash,
  );
}

// Classes de valores por union-find sobre as chaves normalizadas: A=B e B=C
// fundem A, B e C, mesmo que nenhum documento tenha os três. Devolve
// chave -> chave da classe (a menor chave, estável). Valores sem
// equivalência não entram no mapa.
export function valueClassKeys(
  equivalences: readonly ValueEquivalence[],
): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let current = key;
    while (parent.get(current) !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  for (const equivalence of equivalences) {
    const a = equivalenceValueKey(equivalence.value_a);
    const b = equivalenceValueKey(equivalence.value_b);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) continue;
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  }
  const result = new Map<string, string>();
  for (const key of parent.keys()) result.set(key, find(key));
  return result;
}

export interface EquivalenceEdge {
  response_a_id: string;
  response_b_id: string;
}

// As arestas entre RESPOSTAS de um documento que as equivalências de valor
// implicam: duas respostas dadas à versão atual da pergunta cujos valores
// caem na mesma classe. Resposta dada a outra versão da pergunta
// (`isCurrent` falso) ou sem resposta não é fundida por equivalência — só
// pelo valor idêntico, em `buildResponseGroupKeys`. `field` é obrigatório
// para que nenhum leitor esqueça a regra da versão.
export function valueEquivalenceEdges<T extends { id: string }>(
  items: readonly T[],
  equivalences: readonly ValueEquivalence[] | undefined,
  field: Pick<PydanticField, "name" | "hash"> | undefined,
  getAnswer: (item: T) => unknown,
  isCurrent: (item: T) => boolean,
): EquivalenceEdge[] {
  return responseEdgesForEquivalences(
    items,
    currentValueEquivalences(equivalences, field),
    getAnswer,
    isCurrent,
  );
}

// O mesmo, para quem já tem a lista recortada pela versão atual da pergunta
// (`currentValueEquivalences`), como os cards da Comparação.
function responseEdgesForEquivalences<T extends { id: string }>(
  items: readonly T[],
  currentEquivalences: readonly ValueEquivalence[],
  getAnswer: (item: T) => unknown,
  isCurrent: (item: T) => boolean,
): EquivalenceEdge[] {
  const classes = valueClassKeys(currentEquivalences);
  if (classes.size === 0) return [];
  const firstByClass = new Map<string, string>();
  const edges: EquivalenceEdge[] = [];
  for (const item of items) {
    const answer = getAnswer(item);
    if (answer === undefined || !isCurrent(item)) continue;
    const classKey = classes.get(equivalenceValueKey(answer));
    if (classKey === undefined) continue;
    const first = firstByClass.get(classKey);
    if (first === undefined) firstByClass.set(classKey, item.id);
    else edges.push({ response_a_id: first, response_b_id: item.id });
  }
  return edges;
}

// Unified grouping key via union-find: fuses responses connected via
// explicit edges OR sharing the same normalized answer. Two responses
// end up in the same group iff they're reachable via a chain of
// edges and same-answer edges. Returns id -> classKey (lex-smallest
// id in the class — stable and deterministic).
//
// Same-answer fusion is required so responses with the same literal text as
// a fused response don't end up in a separate group.
export function buildResponseGroupKeys<T extends { id: string }>(
  responses: readonly T[],
  edges: readonly EquivalenceEdge[],
  getAnswerKey: (r: T) => string,
): Map<string, string> {
  const parent = new Map<string, string>();
  for (const r of responses) parent.set(r.id, r.id);

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: string, b: string) {
    // Edges whose endpoints aren't in the current response set are silently
    // ignored.
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the lex-smaller id as the root for stable class keys.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  }

  for (const edge of edges) union(edge.response_a_id, edge.response_b_id);

  // Second pass: union responses sharing the same normalized answer.
  const firstByAnswer = new Map<string, string>();
  for (const r of responses) {
    const key = getAnswerKey(r);
    const seen = firstByAnswer.get(key);
    if (seen === undefined) firstByAnswer.set(key, r.id);
    else union(seen, r.id);
  }

  const result = new Map<string, string>();
  for (const r of responses) result.set(r.id, find(r.id));
  return result;
}

// As classes de equivalência das respostas de um documento para um campo:
// as equivalências de valor da versão atual da pergunta (aplicadas só às
// respostas dadas a ela) mais a resposta normalizada idêntica. Quais
// respostas entram é decisão do chamador.
export function answerGroupKeys(
  docResponses: readonly {
    id: string;
    answers: Record<string, unknown> | null;
    answer_field_hashes?: AnswerFieldHashes | null;
  }[],
  equivalences: readonly ValueEquivalence[] | undefined,
  field: PydanticField | undefined,
  fieldName: string,
): Map<string, string> {
  const items = docResponses.map((response) => ({
    id: response.id,
    answer: response.answers?.[fieldName],
    answerFieldHashes: response.answer_field_hashes ?? undefined,
  }));
  const edges = valueEquivalenceEdges(
    items,
    equivalences,
    field,
    (item) => item.answer,
    (item) => answersCurrentQuestion(item.answerFieldHashes, field),
  );
  return buildResponseGroupKeys(items, edges, (item) => normalizeForComparison(item.answer));
}

/**
 * As chaves de valor afetadas: as sementes mais todos os valores da classe de
 * cada uma, pelas equivalências da versão atual da pergunta. Para criar, passe
 * as equivalências já com a nova; para desfazer, as de ANTES da remoção — a
 * classe antiga é onde a divergência pode reaparecer.
 */
export function affectedValueKeys(
  equivalences: readonly ValueEquivalence[],
  field: Pick<PydanticField, "name" | "hash"> | undefined,
  seedValues: readonly unknown[],
): Set<string> {
  const classes = valueClassKeys(currentValueEquivalences(equivalences, field));
  const seeds = new Set(seedValues.map(equivalenceValueKey));
  const seedClasses = new Set<string>();
  for (const key of seeds) seedClasses.add(classes.get(key) ?? key);
  const keys = new Set(seeds);
  for (const [key, classKey] of classes) {
    if (seedClasses.has(classKey)) keys.add(key);
  }
  return keys;
}

// Os grupos de cards da Comparação: respostas presentes ao campo, fundidas
// pelas equivalências já recortadas pela versão atual da pergunta (só nas
// respostas dadas a ela) e pela resposta normalizada idêntica. Fonte única do
// agrupamento que os cards, a contagem do painel e o hook de dados exibem.
export function cardGroupKeys<
  T extends { id: string; answer: unknown; answersCurrentQuestion: boolean },
>(present: readonly T[], currentEquivalences: readonly ValueEquivalence[]): Map<string, string> {
  const edges = responseEdgesForEquivalences(
    present,
    currentEquivalences,
    (response) => response.answer,
    (response) => response.answersCurrentQuestion,
  );
  return buildResponseGroupKeys(present, edges, (response) =>
    normalizeForComparison(response.answer),
  );
}
