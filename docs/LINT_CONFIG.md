# Configuração do react-doctor

O [react-doctor](https://react.doctor) é tratado como um linter da toolchain do frontend, no mesmo espírito do eslint/mypy: é uma `devDependency` **pinada** (`react-doctor@0.5.6` em `frontend/package.json`), roda via script `npm run`, e o arquivo `frontend/doctor.config.json` cumpre o papel de um `mypy.ini`/`.eslintrc` — fonte única de configuração (o config na raiz do repo foi removido para evitar drift, já que os scripts npm e o hook de pre-commit rodam escopados a `frontend/`).

> **Nome do arquivo de config (0.5.x):** a partir da 0.5, o react-doctor procura `doctor.config.*` (ou a chave `reactDoctor` em `package.json`); o nome antigo `react-doctor.config.json` deixou de ser reconhecido. O arquivo foi renomeado para `doctor.config.json` no bump 0.2.11 → 0.5.6. O schema (`ignore.overrides` + `rules`) é o mesmo.

## Como rodar

```bash
cd frontend
npm run react-doctor          # scan completo do app (report)
npm run react-doctor:diff     # só os arquivos do branch atual vs main (check manual)
```

A config é lida do diretório de execução (o react-doctor resolve o projeto via `findNearestPackageDirectory`, e só `frontend/` tem `package.json`), por isso os comandos rodam de dentro de `frontend/`.

## Gate local de pre-commit — bloqueante para código novo, não para o legado

O gate roda **localmente, antes do commit** (estilo flake8/mypy), não no CI. `.pre-commit-config.yaml` define um hook `repo: local` que executa `react-doctor . --diff --blocking error` em commits que tocam arquivos `frontend/**/*.{ts,tsx}`. Como `--diff` analisa só os arquivos alterados — e, verificado na 0.5.6, é **hunk-scoped**: só acusa diagnósticos nas *linhas* efetivamente alteradas — e `--blocking error` só falha em diagnósticos *error*-level, o gate **bloqueia somente quando o commit toca uma linha que produz um error**. Todo o débito legado (os 17 errors e ~148 warnings da baseline 0.5.6 abaixo) fica grandfathered: editar uma linha qualquer de um arquivo que já tem um error em *outra* linha não barra o commit. Para endurecer o gate no futuro (ex.: `--blocking warning` depois de pagar o débito de State & Effects), basta ajustar a flag.

> **Mudança de flag (0.5.x):** a flag `--fail-on <level>` da 0.2.x foi removida; o substituto é `--blocking <level>` (`error` | `warning` | `none`; default já é `error`). O hook e os scripts foram migrados no bump.

Por ser **local e opt-in** — cada clone precisa rodar o setup abaixo, e `git commit --no-verify` o ignora —, este gate é uma rede de proteção para quem desenvolve, não um portão de merge no servidor: ele não protege a `main` de forma incondicional. A opção por pre-commit em vez de um job de CI é deliberada, para manter a toolchain leve enquanto a baseline de errors é zero; promover o gate a um check de CI bloqueante é o passo natural caso o enforcement no servidor passe a ser necessário.

### Setup (1x por clone)

```bash
cd frontend && npm install      # instala o react-doctor pinado (binário em node_modules/.bin)
uv tool install pre-commit      # ou: pipx install pre-commit — `pre-commit` é um utilitário Python externo
pre-commit install              # da raiz do repo: grava o hook em .git/hooks
```

### Detalhes de implementação

- **`--diff`, não `--staged`**: a 0.5.x tem um modo `--staged` próprio para pre-commit, mas mantemos `--diff` (vs HEAD), que está verificado resolvendo os paths corretamente neste monorepo (git root ≠ `frontend/`) na 0.5.6 e é hunk-scoped. Como o pre-commit faz auto-stash dos arquivos unstaged antes de rodar o hook, o working tree fica idêntico ao staged, então `--diff` enxerga exatamente o que vai ser commitado.
- O hook faz `cd frontend` (o react-doctor resolve config e escopo pelo diretório de execução) e invoca **diretamente** o binário pinado em `frontend/node_modules/.bin/react-doctor` — não via `npx`, que baixaria a versão mais recente do registry caso as deps não estivessem instaladas, furando o pin. Se o binário estiver ausente, o hook falha fechado pedindo `npm install`, em vez de prosseguir com uma versão não pinada.

## Baseline (react-doctor 0.5.6, medida em 2026-06-15)

Scan completo (`npm run react-doctor`) após o bump 0.2.11 → 0.5.6, já com os overrides aplicados:

- **Score: 39 / 100** (o algoritmo de score mudou entre 0.2 e 0.5 — não é comparável ao "75" da versão anterior).
- **17 errors / 148 warnings** (165 issues), distribuídos em: Security (6 errors), Bugs (11 errors + 90 warnings), Performance (19 warnings), Accessibility (5 warnings), Maintainability (34 warnings).

Os 17 errors vêm de **três regras novas** da 0.5.x, todas legítimas (não são FP) e por isso **não silenciadas** — ficam grandfathered pelo `--diff` hunk-scoped até que as linhas em questão sejam editadas:

- `react-doctor/no-adjust-state-on-prop-change` (11) — Bugs; ajustar state em effect/render conforme prop muda. Ex.: `DocumentPreview.tsx`, `CodingPage.tsx`, `MyVerdictsView.tsx`.
- `react-doctor/supabase-client-owned-authz-field` (4) — Security; campo de autorização escrito via client. Ex.: `lib/auto-review.ts`, `actions/{assignments,members,projects}.ts`.
- `react-doctor/supabase-table-missing-rls` (2) — Security; `CREATE TABLE` sem RLS em `migrations/{clerk_user_mapping,master_users}.sql`.

Pagar esse débito (corrigir os errors de verdade) é trabalho de PR(s) à parte, fora do escopo do bump. O gate de pre-commit não obriga a corrigi-los para commitar — só barra se a *linha* alterada produzir um error.

## Por que `server-auth-actions` está silenciada em `src/actions/**`

A regra `react-doctor/server-auth-actions` verifica se Server Actions chamam um helper de autenticação reconhecido (por padrão, `auth()` do Clerk). O projeto usa um wrapper próprio, `getAuthUser()` (definido em `frontend/src/lib/auth.ts`), que internamente chama `auth()` mas adiciona resolução do usuário no Supabase. A heurística do react-doctor não reconhece esse wrapper, o que gera dezenas de falsos positivos em actions que estão corretamente autenticadas.

A silenciagem está restrita a `src/actions/**` (escopo onde o padrão é universal e auditável por code review). Não silenciar globalmente.

Se o react-doctor passar a aceitar custom auth helpers (ou se o projeto adotar `auth()` direto), remover este override.

## `only-export-components` ignorada em `src/components/ui/**`

Os componentes shadcn/ui (`ui/button`, `ui/badge`, `ui/tabs`) exportam, além do componente, suas variantes CVA (`buttonVariants`, `badgeVariants` etc.) — convenção intencional do shadcn. A regra `react-doctor/only-export-components` (orientada a Fast Refresh) acusa isso como error. O override silencia a regra **apenas em `src/components/ui/**`** (onde o padrão é da própria biblioteca), mantendo-a ativa no resto do app. Na 0.2.x estes eram os únicos errors do codebase, junto com `server-auth-actions`; com os overrides, a baseline daquela versão era 0 errors. Na 0.5.6 o ruleset expandido introduziu novos errors (ver baseline abaixo), mas estes dois overrides continuam necessários e ativos.

## `js-combine-iterations` desligada globalmente

22 ocorrências de `.filter().map()` (e cadeias afins) sobre arrays pequenos — cosmético, sem impacto real de performance no domínio do projeto. Desligada via `rules` (severidade global `off`), não via ignore por caminho.

## Regras que deixaram de ser FP

`server-no-mutable-module-state` deixou de ser FP após o uso de `Object.freeze()` em `TAG_PROFILE` (ver `actions/documents.ts` e `actions/members.ts`).
