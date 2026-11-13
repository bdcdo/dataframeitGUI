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

export function groupValueEquivalencesByField<T extends ValueEquivalence>(
  rows: readonly T[] | null | undefined,
): Map<string, T[]> {
  const byField = new Map<string, T[]>();
  for (const row of rows ?? []) {
    const list = byField.get(row.field_name);
    if (list) list.push(row);
    else byField.set(row.field_name, [row]);
  }
  return byField;
}

// A identidade de um valor para a equivalência: a mesma de "mesma resposta"
// da Comparação (sem acento, caixa, espaços colapsados e aparados; listas
// elemento a elemento). O banco guarda o valor bruto; a chave só existe aqui.
export function equivalenceValueKey(value: unknown): string {
  return normalizeForComparison(value);
}

// Union-find com a menor chave como raiz: a chave da classe é estável e
// determinística. Usado sobre chaves de valor e sobre ids de resposta.
function unionFind() {
  const parent = new Map<string, string>();
  const add = (key: string) => {
    if (!parent.has(key)) parent.set(key, key);
  };
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
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  };
  return { add, find, union, keys: () => parent.keys() };
}

// As listas por campo chegam com a mesma identidade a todo documento de uma
// leitura (fila da Comparação, export, métricas, reconciliador). Os dois
// caches abaixo, presos à identidade da lista, fazem o recorte pela versão e
// o union-find rodarem uma vez por lista, e não uma vez por documento.
const currentCache = new WeakMap<readonly ValueEquivalence[], Map<string, ValueEquivalence[]>>();
const classCache = new WeakMap<readonly ValueEquivalence[], Map<string, string>>();

// As equivalências que valem para o campo na versão atual da pergunta. Campo
// fora do schema, ou sem hash, não tem como provar a versão: nenhuma vale.
export function currentValueEquivalences(
  equivalences: readonly ValueEquivalence[] | undefined,
  field: Pick<PydanticField, "name" | "hash"> | undefined,
): ValueEquivalence[] {
  if (!equivalences || !field || typeof field.hash !== "string") return [];
  let byVersion = currentCache.get(equivalences);
  if (!byVersion) {
    byVersion = new Map();
    currentCache.set(equivalences, byVersion);
  }
  const versionKey = `${field.name}\u0000${field.hash}`;
  let current = byVersion.get(versionKey);
  if (!current) {
    current = equivalences.filter(
      (equivalence) =>
        equivalence.field_name === field.name && equivalence.field_hash === field.hash,
    );
    byVersion.set(versionKey, current);
  }
  return current;
}

// Classes de valores por union-find sobre as chaves normalizadas: A=B e B=C
// fundem A, B e C, mesmo que nenhum documento tenha os três. Devolve
// chave -> chave da classe (a menor chave, estável). Valores sem
// equivalência não entram no mapa.
export function valueClassKeys(equivalences: readonly ValueEquivalence[]): Map<string, string> {
  const cached = classCache.get(equivalences);
  if (cached) return cached;
  const classes = unionFind();
  for (const equivalence of equivalences) {
    const a = equivalenceValueKey(equivalence.value_a);
    const b = equivalenceValueKey(equivalence.value_b);
    classes.add(a);
    classes.add(b);
    classes.union(a, b);
  }
  const result = new Map<string, string>();
  for (const key of classes.keys()) result.set(key, classes.find(key));
  classCache.set(equivalences, result);
  return result;
}

export interface EquivalenceEdge {
  response_a_id: string;
  response_b_id: string;
}

// As arestas entre RESPOSTAS de um documento que as equivalências (já
// recortadas pela versão atual) implicam: duas respostas dadas à versão atual
// da pergunta cujos valores caem na mesma classe. Resposta dada a outra
// versão (`isCurrent` falso) ou sem resposta não é fundida por equivalência —
// só pelo valor idêntico, em `buildResponseGroupKeys`.
function edgesForCurrent<T extends { id: string }>(
  items: readonly T[],
  current: readonly ValueEquivalence[],
  getAnswer: (item: T) => unknown,
  isCurrent: (item: T) => boolean,
): EquivalenceEdge[] {
  if (current.length === 0) return [];
  const classes = valueClassKeys(current);
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

// O mesmo a partir da lista do campo, aplicando a regra da versão. `field` é
// obrigatório para que nenhum leitor esqueça a regra.
export function valueEquivalenceEdges<T extends { id: string }>(
  items: readonly T[],
  equivalences: readonly ValueEquivalence[] | undefined,
  field: Pick<PydanticField, "name" | "hash"> | undefined,
  getAnswer: (item: T) => unknown,
  isCurrent: (item: T) => boolean,
): EquivalenceEdge[] {
  return edgesForCurrent(items, currentValueEquivalences(equivalences, field), getAnswer, isCurrent);
}

// Classes de RESPOSTAS: funde as ligadas por aresta OU com a mesma resposta
// normalizada. Duas respostas caem no mesmo grupo sse há uma cadeia de
// arestas e de respostas iguais entre elas. Devolve id -> chave do grupo (o
// menor id, estável).
export function buildResponseGroupKeys<T extends { id: string }>(
  responses: readonly T[],
  edges: readonly EquivalenceEdge[],
  getAnswerKey: (r: T) => string,
): Map<string, string> {
  const groups = unionFind();
  for (const response of responses) groups.add(response.id);
  for (const edge of edges) groups.union(edge.response_a_id, edge.response_b_id);

  const firstByAnswer = new Map<string, string>();
  for (const response of responses) {
    const key = getAnswerKey(response);
    const seen = firstByAnswer.get(key);
    if (seen === undefined) firstByAnswer.set(key, response.id);
    else groups.union(seen, response.id);
  }

  const result = new Map<string, string>();
  for (const response of responses) result.set(response.id, groups.find(response.id));
  return result;
}

// As classes de equivalência das respostas de um documento para um campo:
// as equivalências de valor da versão atual da pergunta (aplicadas só às
// respostas dadas a ela) mais a resposta normalizada idêntica. Quais
// respostas entram é decisão do chamador.
export function answerGroupKeys(
  docResponses: readonly {
    id: string;
    answers: Record<string, unknown> | null | undefined;
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
  return buildResponseGroupKeys(items, edges, (item) => equivalenceValueKey(item.answer));
}

// Os grupos de cards da Comparação: respostas presentes ao campo, fundidas
// pelas equivalências já recortadas pela versão atual da pergunta (só nas
// respostas dadas a ela) e pela resposta normalizada idêntica. Fonte única do
// agrupamento que os cards, a contagem do painel e o hook de dados exibem.
export function cardGroupKeys<
  T extends { id: string; answer: unknown; answersCurrentQuestion: boolean },
>(present: readonly T[], currentEquivalences: readonly ValueEquivalence[]): Map<string, string> {
  const edges = edgesForCurrent(
    present,
    currentEquivalences,
    (response) => response.answer,
    (response) => response.answersCurrentQuestion,
  );
  return buildResponseGroupKeys(present, edges, (response) => equivalenceValueKey(response.answer));
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

/**
 * As equivalências (já da versão atual) que formam as classes dos valores
 * dados, inclusive os elos do meio de uma cadeia: em A=B=C=D com os valores A
 * e D, entra também B=C. São as que fundem esses valores — as variantes de um
 * card e a versão que o reconciliador confere.
 */
export function equivalencesInClassesOf(
  current: readonly ValueEquivalence[],
  values: readonly unknown[],
): ValueEquivalence[] {
  if (current.length === 0) return [];
  const classes = valueClassKeys(current);
  const valueClasses = new Set(
    values.flatMap((value) => {
      const classKey = classes.get(equivalenceValueKey(value));
      return classKey === undefined ? [] : [classKey];
    }),
  );
  return current.filter((equivalence) =>
    valueClasses.has(classes.get(equivalenceValueKey(equivalence.value_a))!),
  );
}
