import { readFileSync } from "node:fs";
import { join } from "node:path";
// parseEnv deixou de ser experimental exatamente em v24.10.0 ("This API is no
// longer experimental", historico de node:util) — e por isso, e nao por
// alinhamento com o Docker, que engines fixa >=24.10.0. Relaxar aquele piso
// reintroduz uma API instavel no gate de pre-push.
import { parseEnv } from "node:util";

export const environmentFiles = Object.freeze([".env.local", ".env.e2e"]);

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
