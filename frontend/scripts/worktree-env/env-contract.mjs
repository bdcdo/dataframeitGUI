import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
// parseEnv deixou de ser experimental exatamente em v24.10.0 ("This API is no
// longer experimental", historico de node:util) — e por isso, e nao por
// alinhamento com o Docker, que engines fixa >=24.10.0. Relaxar aquele piso
// reintroduz uma API instavel no gate de pre-push.
import { parseEnv } from "node:util";

export const environmentFiles = Object.freeze([".env.local", ".env.e2e"]);

/**
 * Variavel que sobrescreve o diretorio-fonte canonico (usada pelos testes e por
 * quem mantem os segredos noutro lugar).
 */
export const canonicalEnvironmentHomeVariable = "DATAFRAMEITGUI_ENV_HOME";

/**
 * Diretorio-fonte canonico dos arquivos de ambiente.
 *
 * Fica FORA de qualquer checkout ou worktree de proposito. Worktree e efemera
 * por construcao — `git worktree remove` apaga o diretorio — entao apontar o
 * symlink de uma worktree para outra transforma a remocao de uma em quebra
 * silenciosa da outra. O sintoma aparece longe da causa: o guard de pre-push
 * acusa "faltando 10 variaveis", e nao "o link aponta para um diretorio que
 * nao existe mais". Com a fonte fora da arvore, esse estado deixa de ser
 * construivel pelo caminho normal.
 *
 * @param {Readonly<Record<string, string | undefined>>} [environment]
 * @returns {string}
 */
export function canonicalEnvironmentDirectory(environment = process.env) {
  const explicit = environment[canonicalEnvironmentHomeVariable];
  if (hasConfiguredEnvironmentValue(explicit)) return resolve(explicit);

  const xdgConfigHome = environment.XDG_CONFIG_HOME;
  const configurationBase = hasConfiguredEnvironmentValue(xdgConfigHome)
    ? resolve(xdgConfigHome)
    : join(homedir(), ".config");

  return join(configurationBase, "dataframeitGUI", "frontend");
}

/** @param {string} path @returns {Record<string, string>} */
export function readEnvironmentFile(path) {
  return parseEnv(readFileSync(path, "utf8"));
}

/** @param {string} path @returns {Record<string, string>} */
export function readOptionalEnvironmentFile(path) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  return parseEnv(contents);
}

/**
 * @param {Record<string, string | undefined>} target
 * @param {Readonly<Record<string, string>>} environment
 * @param {{ override?: boolean }} [options]
 */
export function applyEnvironment(
  target,
  environment,
  { override = false } = {},
) {
  for (const [name, value] of Object.entries(environment)) {
    if (override || target[name] === undefined) target[name] = value;
  }
}

/** @param {string | undefined} value */
export function hasConfiguredEnvironmentValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {string} path @returns {string[]} */
export function requiredEnvironmentNamesForFile(path) {
  return Object.keys(readEnvironmentFile(path)).sort();
}

/** @param {string} frontendDirectory @returns {string[]} */
export function requiredEnvironmentNames(frontendDirectory) {
  return environmentFiles
    .flatMap((filename) =>
      requiredEnvironmentNamesForFile(
        join(frontendDirectory, `${filename}.example`),
      ),
    )
    .sort();
}
