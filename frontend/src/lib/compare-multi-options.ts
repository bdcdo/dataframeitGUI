// Regra das "opções comparáveis" de um campo `multi`.
//
// Um multi não é comparado pelo array cru: duas respostas com o mesmo conjunto
// em ordens diferentes concordam. A comparação é feita opção a opção — e o
// conjunto de opções a considerar é a UNIÃO das opções atuais do schema com
// tudo que as respostas efetivamente marcaram. A união é o que faz uma opção
// removida do schema (mas ainda marcada por alguém) continuar sendo comparada,
// em vez de sumir e fabricar uma concordância que não existe.
//
// Vive aqui porque a mesma regra era reimplementada em `compare-divergence`
// (polaridade "diverge") e em `export/assemble` (polaridade "concorda"), sem
// teste em nenhum dos dois — e porque o `MultiOptionReview` precisa dela para
// renderizar as opções que a comparação de fato considera (#484). O filtro de
// aplicabilidade (staleness, condicional, aridade mínima) fica nos chamadores,
// que divergem legitimamente.

// Conjuntos de seleção por resposta. Valor não-array (ou ausente) vira conjunto
// vazio: é "não marcou nada", não um erro.
export function multiSelectionSets(answers: unknown[]): Set<string>[] {
  return answers.map(
    (arr) =>
      new Set(
        Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [],
      ),
  );
}

// União das opções do schema com as efetivamente marcadas. Preserva a ordem do
// schema e acrescenta as demais na ordem em que aparecem — assim as opções
// atuais mantêm a posição (e, na UI, o atalho numérico) e as fora do schema
// entram no fim.
//
// O resultado é sem repetição mesmo quando o schema traz uma opção duplicada:
// a UI usa a opção como `key` de lista, e duas linhas com a mesma key seriam
// um erro de render por causa de um schema mal montado.
export function comparableMultiOptions(
  options: string[],
  selectionSets: Set<string>[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (v: string) => {
    if (seen.has(v)) return;
    seen.add(v);
    result.push(v);
  };
  for (const opt of options) push(opt);
  for (const set of selectionSets) for (const v of set) push(v);
  return result;
}

// True quando toda opção comparável tem seleção uniforme entre as respostas.
// Sem respostas, concorda vacuamente — os chamadores é que aplicam o mínimo de
// respondentes.
export function multiSelectionsAgree(
  options: string[],
  selectionSets: Set<string>[],
): boolean {
  for (const opt of comparableMultiOptions(options, selectionSets)) {
    const selections = selectionSets.map((s) => s.has(opt));
    if (!selections.every((s) => s === selections[0])) return false;
  }
  return true;
}
