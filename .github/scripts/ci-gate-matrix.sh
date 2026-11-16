#!/usr/bin/env bash
# Matriz de gates do ci.yml (#649), derivada do .pre-commit-config.yaml: uma
# célula por hook com `pre-push` nos stages, menos as exceções declaradas em
# .github/ci-exempt-gates.json. Hook novo de pre-push vira célula sozinho; não
# existe segunda lista em que esquecê-lo.
#
# Imprime `{"include":[{"id","name","shard"}]}` e falha, sem imprimir matriz,
# quando uma declaração deixou de valer:
#   - exceção sem motivo, ou cuja chave não é hook de pre-commit nem de
#     pre-push (órfã). As de pre-commit valem para o job `lint` do ci.yml, que
#     roda esse estágio inteiro com as exceções em `SKIP`;
#   - shard de hook que não é célula, ou com contagem menor que 2. O hook
#     recebe a fatia em GATE_SHARD (`n/total`) e é ele que precisa lê-la.
#
# O estágio de um hook é o `stages:` dele ou, na falta, o `default_stages` do
# arquivo. Hook de repositório remoto que só declare o estágio no manifesto do
# próprio repositório não é visto daqui: declare `stages:` neste repo.
#
# Uso: ci-gate-matrix.sh [config] [exceções] [shards]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config="${1:-$repo_root/.pre-commit-config.yaml}"
exempt="${2:-$repo_root/.github/ci-exempt-gates.json}"
shards="${3:-$repo_root/.github/ci-gate-shards.json}"

ruby -ryaml -rjson -e '
  config_path, exempt_path, shards_path = ARGV
  config = YAML.safe_load(File.read(config_path), aliases: true)
  exempt = JSON.parse(File.read(exempt_path))
  shards = JSON.parse(File.read(shards_path))

  default_stages = config["default_stages"]
  hooks = []
  light = []
  config.fetch("repos").each do |repo|
    repo.fetch("hooks").each do |hook|
      stages = hook["stages"] || default_stages
      # Sem `stages` e sem `default_stages`, o pre-commit roda o hook em todo
      # estágio, o pre-push inclusive.
      light << hook.fetch("id") if stages.nil? || stages.include?("pre-commit")
      next unless stages.nil? || stages.include?("pre-push")
      hooks << hook.fetch("id")
    end
  end

  problems = []
  exempt.each do |id, reason|
    problems << "exceção órfã em #{File.basename(exempt_path)}: `#{id}` não é hook de pre-commit nem de pre-push" unless hooks.include?(id) || light.include?(id)
    problems << "exceção `#{id}` sem motivo em #{File.basename(exempt_path)}" unless reason.is_a?(String) && !reason.strip.empty?
  end
  gates = hooks - exempt.keys
  shards.each do |id, count|
    unless gates.include?(id)
      problems << "shard órfão em #{File.basename(shards_path)}: `#{id}` não é célula da matriz"
      next
    end
    problems << "shard de `#{id}` precisa ser inteiro >= 2, veio #{count.inspect}" unless count.is_a?(Integer) && count >= 2
  end
  problems << "nenhum hook de pre-push fora das exceções: a matriz ficaria vazia" if gates.empty?
  abort(problems.join("\n")) unless problems.empty?

  include = gates.flat_map do |id|
    count = shards[id]
    next [{ "id" => id, "name" => id, "shard" => "" }] unless count
    (1..count).map { |n| { "id" => id, "name" => "#{id} (#{n}/#{count})", "shard" => "#{n}/#{count}" } }
  end
  puts JSON.generate("include" => include)
' "$config" "$exempt" "$shards"
