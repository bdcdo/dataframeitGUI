#!/usr/bin/env bash
# Teste do fly-toml-contract.py sobre um fly.toml mínimo: as regras que não
# dependem do arquivo de cada app (tipo, bloco, [[vm]] único e seus aliases,
# scale-to-zero em qualquer bloco, TOML inválido, `#` dentro de string). Os
# contratos de cada app (test-{backend,frontend}-fly-machine-contract.sh)
# conferem as próprias diretivas no fly.toml de verdade.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fixture="$tmp_dir/base.toml"
config="$tmp_dir/fly.toml"
cat >"$fixture" <<'EOF'
app = "exemplo"

[http_service]
  auto_stop_machines = "off" # comentário de fim de linha
  min_machines_running = 1

[[vm]]
  size = "shared-cpu-1x"
EOF

check() {
  python3 "$repo_root/.github/scripts/fly-toml-contract.py" "$1" \
    '[http_service] auto_stop_machines = "off"' \
    '[http_service] min_machines_running = 1' \
    '[[vm]] size = "shared-cpu-1x"'
}

# Reprova, e pela mensagem do contrato ("<arquivo>: ..."), para que um
# traceback do script não passe por recusa.
expect_rejected() {
  local output
  if output="$(check "$config" 2>&1)"; then
    printf 'o contrato deveria reprovar (%s):\n' "$1" >&2
    cat "$config" >&2
    exit 1
  fi
  [[ $output == "$config: "* ]] || { printf 'o contrato reprovou (%s) sem a própria mensagem:\n%s\n' "$1" "$output" >&2; exit 1; }
}

with_appended() {
  { cat "$fixture"; printf '\n%s\n' "$1"; } >"$config"
}

check "$fixture"

# Tipo conta: `true` não casa com `1`.
sed 's/min_machines_running = 1/min_machines_running = true/' "$fixture" >"$config"
expect_rejected "tipo trocado"
# Sem a tabela nomeada.
sed '/^\[http_service\]/,/^$/d' "$fixture" >"$config"
expect_rejected "sem [http_service]"

# Uma Machine a mais, ou CPU fora do contrato dentro do único [[vm]].
with_appended $'[[vm]]\n  size = "shared-cpu-1x"'
expect_rejected "[[vm]] a mais"
for vm_override in 'cpus = 2' 'cpu_kind = "performance"' 'memory_mb = 1024'; do
  with_appended "  $vm_override"
  expect_rejected "$vm_override no [[vm]]"
done
# O flyctl junta [[compute]] e [[computes]] ao [[vm]] (patchCompute em
# internal/appconfig/patches.go): CPU ou Machine a mais por ali também conta, e
# um elemento que não é tabela reprova pelo contrato.
for alias in compute computes; do
  with_appended "[[$alias]]"$'\n  cpus = 4'
  expect_rejected "[[$alias]]"
done
{ printf 'compute = ["shared-cpu-1x"]\n'; cat "$fixture"; } >"$config"
expect_rejected "compute que não é tabela"

# Todo auto_stop_machines, em qualquer bloco, é "off" ou false. O flyctl também
# lê 'stop' (string literal do TOML) e true (o stop legado).
for scale_to_zero in '"stop"' "'stop'" '"suspend"' true; do
  with_appended "[[services]]"$'\n'"  auto_stop_machines = $scale_to_zero"
  expect_rejected "auto_stop_machines = $scale_to_zero em [[services]]"
done
# TOML inválido (o marcador de conflito de 2026-08-10).
with_appended '======='
expect_rejected "TOML inválido"

# Casos verdes: `#` dentro de string não é comentário (o `sed 's/#.*//'` de
# antes lia a linha abaixo da string como `auto_stop_machines = "stop"` e
# reprovava a config), e false é aceito em outro bloco.
{ printf 'nota = """\nauto_stop_machines = "stop" # derrubou o site em 2026-08-10\n"""\n'; cat "$fixture"; } >"$config"
check "$config"
with_appended $'[[services]]\n  auto_stop_machines = false'
check "$config"

echo "Contrato do fly.toml validado."
