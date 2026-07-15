#!/usr/bin/env node

import {
  lstatSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  environmentFiles,
  hasConfiguredEnvironmentValue,
  readEnvironmentFile,
  requiredEnvironmentNamesForFile,
} from "./env-contract.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const frontendDirectory = resolve(scriptDirectory, "../..");

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

const [, , option, sourceArgument, ...extraArguments] = process.argv;
if (option !== "--source" || !sourceArgument || extraArguments.length > 0) {
  console.error(
    "Uso: ./frontend/scripts/worktree-env/bootstrap.sh --source <diretorio-frontend-fonte>",
  );
  process.exit(2);
}

let sourceDirectory;
try {
  sourceDirectory = realpathSync(sourceArgument);
  if (!statSync(sourceDirectory).isDirectory()) {
    fail(`fonte não é um diretório: ${sourceArgument}`);
  }
} catch (error) {
  if (isMissingPathError(error)) fail(`fonte inexistente: ${sourceArgument}`);
  fail(
    `não foi possível acessar a fonte (${filesystemErrorCode(error)}): ${sourceArgument}`,
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
    lstatSync(join(frontendDirectory, filename));
    fail(`destino já existe: frontend/${filename}`);
  } catch (error) {
    if (!isMissingPathError(error)) {
      fail(
        `não foi possível validar o destino frontend/${filename} (${filesystemErrorCode(error)})`,
      );
    }
  }
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
    const destination = join(frontendDirectory, filename);
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

console.log(
  "Worktree provisionada: frontend/.env.local e frontend/.env.e2e são symlinks para a fonte explícita.",
);
