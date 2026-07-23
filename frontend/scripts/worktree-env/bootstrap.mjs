#!/usr/bin/env node

import {
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDestination } from "./destination-state.mjs";
import {
  canonicalEnvironmentDirectory,
  canonicalEnvironmentHomeVariable,
  environmentFiles,
  hasConfiguredEnvironmentValue,
  readEnvironmentFile,
  requiredEnvironmentNamesForFile,
} from "./env-contract.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const frontendDirectory = resolve(scriptDirectory, "../..");

/**
 * Encerra o processo; nunca retorna. O @returns {never} e o que garante que
 * readContract/readSource nao tenham caminho de retorno `undefined`.
 *
 * @param {string} message
 * @param {number} [status]
 * @returns {never}
 */
function fail(message, status = 1) {
  console.error(`Erro: ${message}`);
  process.exit(status);
}

function filesystemErrorCode(error) {
  const code = Reflect.get(Object(error), "code");
  return typeof code === "string" ? code : "UNKNOWN";
}

function isMissingPathError(error) {
  return ["ENOENT", "ENOTDIR"].includes(filesystemErrorCode(error));
}

function readContract(path, filename) {
  try {
    return requiredEnvironmentNamesForFile(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      fail(`contrato inexistente: frontend/${filename}.example`);
    }
    fail(
      `não foi possível ler o contrato frontend/${filename}.example (${filesystemErrorCode(error)})`,
    );
  }
}

function readSource(path, filename) {
  try {
    return readEnvironmentFile(path);
  } catch (error) {
    fail(
      `não foi possível ler a fonte ${filename} (${filesystemErrorCode(error)})`,
    );
  }
}

/** @type {Map<string, "missing" | "linked" | "relink" | "occupied">} */
const destinationStates = new Map();

const [, , option, sourceArgument, ...extraArguments] = process.argv;
// `--source` continua aceito para quem mantem os segredos noutro lugar; sem ele
// a fonte e a canonica. O default existe porque escolher a fonte a cada
// invocacao era o que permitia apontar para uma worktree irma — que some no
// `git worktree remove` e leva junto o ambiente de quem apontava para ela.
const usesExplicitSource = option === "--source";
const missingSourceArgument = usesExplicitSource && !sourceArgument;
const unexpectedArguments =
  extraArguments.length > 0 || (!usesExplicitSource && option !== undefined);

if (missingSourceArgument || unexpectedArguments) {
  console.error(
    "Uso: ./frontend/scripts/worktree-env/bootstrap.sh [--source <diretorio-frontend-fonte>]",
  );
  console.error(
    `Sem --source, a fonte e ${canonicalEnvironmentDirectory()} (ajustavel por ${canonicalEnvironmentHomeVariable}).`,
  );
  process.exit(2);
}

const requestedSource = usesExplicitSource
  ? sourceArgument
  : canonicalEnvironmentDirectory();

let sourceDirectory;
try {
  sourceDirectory = realpathSync(requestedSource);
  if (!statSync(sourceDirectory).isDirectory()) {
    fail(`fonte não é um diretório: ${requestedSource}`);
  }
} catch (error) {
  if (isMissingPathError(error)) {
    if (usesExplicitSource) fail(`fonte inexistente: ${requestedSource}`);
    fail(
      [
        `fonte canônica inexistente: ${requestedSource}`,
        "Crie-a uma única vez com os arquivos reais (fora de qualquer worktree):",
        `  mkdir -p ${requestedSource}`,
        `  cp frontend/.env.local.example ${requestedSource}/.env.local  # e preencha`,
        `  cp frontend/.env.e2e.example ${requestedSource}/.env.e2e      # e preencha`,
      ].join("\n"),
    );
  }
  fail(
    `não foi possível acessar a fonte (${filesystemErrorCode(error)}): ${requestedSource}`,
  );
}

for (const filename of environmentFiles) {
  const source = join(sourceDirectory, filename);
  try {
    if (!statSync(source).isFile()) fail(`fonte não é um arquivo: ${filename}`);
  } catch (error) {
    if (isMissingPathError(error)) fail(`fonte sem ${filename}`);
    fail(
      `não foi possível validar a fonte ${filename} (${filesystemErrorCode(error)})`,
    );
  }

  try {
    destinationStates.set(
      filename,
      classifyDestination(join(frontendDirectory, filename), source),
    );
  } catch (error) {
    fail(
      `não foi possível validar o destino frontend/${filename} (${filesystemErrorCode(error)})`,
    );
  }
}

const occupied = environmentFiles.filter(
  (filename) => destinationStates.get(filename) === "occupied",
);
if (occupied.length > 0) {
  // Arquivo real no destino nunca e sobrescrito: pode ser a unica copia de um
  // segredo. O provisionamento e que cede, nao o dado.
  fail(
    [
      `destino é arquivo real, não symlink: ${occupied
        .map((filename) => `frontend/${filename}`)
        .join(", ")}`,
      "Mova-o para a fonte canônica (ou remova-o, se for cópia) antes de provisionar.",
    ].join("\n"),
  );
}

const missingNames = [];
for (const filename of environmentFiles) {
  const requiredNames = readContract(
    join(frontendDirectory, `${filename}.example`),
    filename,
  );
  const sourceEnvironment = readSource(
    join(sourceDirectory, filename),
    filename,
  );
  for (const name of requiredNames) {
    if (!hasConfiguredEnvironmentValue(sourceEnvironment[name])) {
      missingNames.push(name);
    }
  }
}

if (missingNames.length > 0) {
  fail(`variáveis obrigatórias ausentes: ${missingNames.join(",")}`);
}

const createdDestinations = [];
let pendingFilename;
try {
  for (const filename of environmentFiles) {
    pendingFilename = filename;
    const state = destinationStates.get(filename);
    if (state === "linked") continue;

    const destination = join(frontendDirectory, filename);
    // `relink` remove só um symlink — nunca um arquivo real, que o guard de
    // `occupied` já barrou acima.
    //
    // `unlinkSync`, e não `rmSync(..., { force: true })`: com `force`, o rm
    // decide pela existência do ALVO (via stat), então num symlink pendente —
    // exatamente o caso que estamos reparando — ele conclui "não existe" e vira
    // no-op silencioso; o erro só aparece depois, como EEXIST no symlinkSync.
    if (state === "relink") unlinkSync(destination);
    symlinkSync(join(sourceDirectory, filename), destination);
    createdDestinations.push(destination);
  }
} catch (error) {
  for (const destination of createdDestinations) {
    rmSync(destination, { force: true });
  }
  fail(
    `não foi possível criar frontend/${pendingFilename} (${filesystemErrorCode(error)}); nenhuma alteração foi mantida`,
  );
}

const repaired = environmentFiles.filter(
  (filename) => destinationStates.get(filename) === "relink",
);
if (repaired.length > 0) {
  console.log(
    `Ambiente reapontado para ${sourceDirectory}: ${repaired.join(", ")}`,
  );
}

console.log(
  "Worktree provisionada: frontend/.env.local e frontend/.env.e2e são symlinks para a fonte explícita.",
);
