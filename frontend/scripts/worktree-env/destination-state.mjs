import { lstatSync, realpathSync } from "node:fs";

/**
 * Estado de um destino de provisionamento, que decide a acao do bootstrap:
 *
 * - `missing`  — nao existe: criar o symlink;
 * - `linked`   — ja aponta para o arquivo da fonte: no-op (idempotencia, de que
 *                o hook de post-checkout depende para poder rodar sempre);
 * - `relink`   — symlink para outro alvo, ou pendente: refazer. Substituir um
 *                symlink nunca destroi conteudo, e e o unico jeito de REPARAR
 *                uma worktree cujo alvo foi removido;
 * - `occupied` — arquivo ou diretorio real: recusar, pode ser a unica copia do
 *                segredo.
 *
 * Vive separado do bootstrap por ser logica pura: aqui ela e testada nos quatro
 * estados diretamente, sem subprocesso.
 *
 * @typedef {"missing" | "linked" | "relink" | "occupied"} DestinationState
 */

function isMissingPathError(error) {
  const code = Reflect.get(Object(error), "code");
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * `null` quando o caminho nao existe. Erro de outra natureza (permissao, por
 * exemplo) sobe: nao pode ser confundido com ausencia, sob pena de o bootstrap
 * "reparar" o que na verdade nao conseguiu ler.
 *
 * @param {() => T} read @returns {T | null}
 * @template T
 */
function missingAsNull(read) {
  try {
    return read();
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

/**
 * @param {string} destination @param {string} source
 * @returns {DestinationState}
 */
export function classifyDestination(destination, source) {
  const entry = missingAsNull(() => lstatSync(destination));
  if (entry === null) return "missing";
  if (!entry.isSymbolicLink()) return "occupied";

  // Link pendente (o alvo sumiu) resolve para `null` — exatamente o caso que
  // refazemos. Fora dele, comparamos o realpath dos DOIS lados: um link que
  // chega ao mesmo arquivo por outro caminho (relativo, ou via diretorio
  // symlinkado) ja esta provisionado.
  const resolved = missingAsNull(() => realpathSync(destination));
  if (resolved === null) return "relink";
  return resolved === realpathSync(source) ? "linked" : "relink";
}
