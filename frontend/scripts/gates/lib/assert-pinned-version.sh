#!/usr/bin/env bash
# Guarda dos gates que invocam o binario PINADO de frontend/node_modules
# (react-doctor, fallow), e nao via npx, que baixaria a versao mais recente.
# Uso, de dentro de frontend/:
#   bash scripts/gates/lib/assert-pinned-version.sh <pacote>
#
# Falha fechado quando o binario falta ou quando o instalado
# (node_modules/<pacote>/package.json) diverge do pino do package.json. Sem
# isso, um node_modules stale mede com a ferramenta errada em silencio: um
# checkout preso na 0.5.8 do react-doctor rodou o gate por duas minors enquanto
# o pino ja era 0.7.8, e o fallow chegou a ter 2.102.0 instalado com 3.6.0
# pinado (#652).
set -euo pipefail

pkg=${1:?uso: assert-pinned-version.sh <pacote>}

if [ ! -x "./node_modules/.bin/$pkg" ]; then
  echo "$pkg ausente em frontend/node_modules; rode (cd frontend && npm install)" >&2
  exit 1
fi

# O pino pode estar em devDependencies ou dependencies, e tem de ser exato: com
# ^ ou ~ o pino nao diz qual versao deveria estar instalada, e o npm instala a
# mais nova da faixa.
read -r pinned installed < <(node -e '
  const name = process.argv[1];
  const p = require("./package.json");
  let installed = "ausente";
  try { installed = require(`./node_modules/${name}/package.json`).version; } catch {}
  console.log((p.devDependencies || {})[name] || (p.dependencies || {})[name] || "-", installed);
' "$pkg")
if [ "$pinned" = "-" ]; then
  echo "$pkg nao esta pinado em frontend/package.json" >&2
  exit 1
fi
if ! [[ "$pinned" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "$pkg pinado como \"$pinned\" em frontend/package.json; o gate exige versao exata" >&2
  exit 1
fi
if [ "$pinned" != "$installed" ]; then
  echo "$pkg instalado ($installed) != pinado ($pinned); rode (cd frontend && npm install)" >&2
  exit 1
fi
