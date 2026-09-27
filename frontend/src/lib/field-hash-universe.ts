// Universo de hashes de campo que um projeto de fato teve, reconstruído do
// schema_change_log. Serve à invariante `answer-field-hashes-do-universo-do-projeto`
// (scripts/invariants/check-invariants.ts), que fica aqui e não no script
// porque o script conecta ao banco no import e não é testável.

import { computeFieldHash } from "@/lib/schema-utils";

export type FieldChangeLogRow = {
  id: string;
  field_name: string;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
  created_at: string;
};

type FieldState = Record<string, unknown>;

// Um lado do log descreve o campo inteiro quando traz `name` e `type`: é o
// `snapshotOf` que `diffFields` grava ao adicionar ou remover campo (renomear
// também chega assim, como remoção do nome antigo e adição do novo). Edição de
// campo existente grava só os atributos que mudaram, e esse lado parcial não
// tem hash por si.
function hashOfComplete(state: FieldState): string | null {
  if (typeof state.name !== "string" || typeof state.type !== "string") return null;
  return computeFieldHash(
    state.name,
    state.type,
    (state.options as string[] | null | undefined) ?? null,
    (state.description as string | null | undefined) ?? "",
    state.question_revision as number | null | undefined,
  );
}

// Leva `state` do lado `from` para o lado `to` de uma entrada parcial. Chave
// presente em `from` e ausente em `to` é atributo que deixou de existir:
// `diffFields` grava `after.options = f.options`, e com `undefined` a chave
// some do jsonb. Por isso ela é apagada, e não mantida com o valor anterior.
function applyPartial(state: FieldState, from: FieldState, to: FieldState): FieldState {
  const next = { ...state };
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (Object.hasOwn(to, key)) next[key] = to[key];
    else delete next[key];
  }
  return next;
}

// Hashes de todas as versões de campo registradas no log de UM projeto: os
// lados completos, como sempre, e as versões intermediárias que só aparecem
// como entrada parcial, reconstruídas aplicando cada parcial, em ordem, sobre
// o estado do campo desde o último lado completo.
//
// A reconstrução só produz hash de versão que existiu, e para isso recusa dois
// casos em vez de adivinhar:
// - parcial sem base (campo anterior ao log): os atributos que a parcial não
//   traz são desconhecidos. Entradas de escopo de projeto, como `(ordem)` e
//   `(projeto)`, caem aqui, porque nunca têm lado completo. A conferência do
//   item seguinte também recusaria a parcial com `type` sobre uma base só com
//   o nome; o retorno antecipado deixa a regra explícita;
// - parcial cujo `before` não descreve a mesma versão (em termos de hash) que a
//   base reconstruída: o log pulou uma mudança, e seguir aplicando produziria
//   versões que nunca existiram. O campo perde a base até o próximo lado
//   completo.
export function fieldHashesFromChangeLog(log: readonly FieldChangeLogRow[]): Set<string> {
  // A mesma ordem (created_at, id) da auditoria da timeline em
  // schema-backfill.ts; quem lê o log pagina por id.
  const ordered = [...log].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const hashes = new Set<string>();
  const add = (hash: string | null) => {
    if (hash) hashes.add(hash);
  };
  const stateByField = new Map<string, FieldState>();

  for (const entry of ordered) {
    const before = entry.before_value ?? {};
    const after = entry.after_value ?? {};
    const beforeHash = hashOfComplete(before);
    const afterHash = hashOfComplete(after);
    add(beforeHash);
    add(afterHash);

    if (afterHash) {
      stateByField.set(entry.field_name, { ...after });
      continue;
    }
    // A remoção (`before` completo, `after` vazio) segue pelo mesmo caminho da
    // parcial e não precisa de ramo próprio: aplicá-la apaga todas as chaves do
    // `before`, `name` e `type` inclusive, e nenhuma parcial as devolve, porque
    // `diffFields` não grava `name` em parcial (renomear é remover e adicionar).
    // O campo fica sem hash até o próximo lado completo. Um ramo explícito que
    // apagasse a base seria inalcançável: medido por mutação em 26/09/2026.
    const base = stateByField.get(entry.field_name);
    if (!base) continue;
    if (hashOfComplete(applyPartial(base, after, before)) !== hashOfComplete(base)) {
      stateByField.delete(entry.field_name);
      continue;
    }
    const next = applyPartial(base, before, after);
    stateByField.set(entry.field_name, next);
    add(hashOfComplete(next));
  }
  return hashes;
}
