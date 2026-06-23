# Configuração do react-doctor

O [react-doctor](https://react.doctor) é tratado como um linter da toolchain do frontend, no mesmo espírito do eslint/mypy: é uma `devDependency` **pinada** (`react-doctor@0.5.8` em `frontend/package.json`), roda via script `npm run`, e o arquivo `frontend/doctor.config.json` cumpre o papel de um `mypy.ini`/`.eslintrc` — fonte única de configuração (o config na raiz do repo foi removido para evitar drift, já que os scripts npm e o hook de pre-commit rodam escopados a `frontend/`).

> **Nome do arquivo de config (0.5.x):** a partir da 0.5, o react-doctor procura `doctor.config.*` (ou a chave `reactDoctor` em `package.json`); o nome antigo `react-doctor.config.json` deixou de ser reconhecido. O arquivo foi renomeado para `doctor.config.json` no bump 0.2.11 → 0.5.6. O schema (`ignore.overrides` + `rules`) é o mesmo.

## Como rodar

```bash
cd frontend
npm run react-doctor          # scan completo do app (report)
npm run react-doctor:diff     # só os arquivos do branch atual vs main (check manual)
```

A config é lida do diretório de execução (o react-doctor resolve o projeto via `findNearestPackageDirectory`, e só `frontend/` tem `package.json`), por isso os comandos rodam de dentro de `frontend/`.

## Gate local de pre-commit — bloqueante para código novo, não para o legado

O gate roda **localmente, antes do commit** (estilo flake8/mypy), não no CI. `.pre-commit-config.yaml` define um hook `repo: local` que executa `react-doctor . --scope changed --base HEAD --blocking error` em commits que tocam arquivos `frontend/**/*.{ts,tsx}`. Como `--scope changed --base HEAD` reporta só issues nas *linhas* alteradas vs HEAD — verificado na 0.5.8 — e `--blocking error` só falha em diagnósticos *error*-level, o gate **bloqueia somente quando o commit toca uma linha que produz um error**. Todo o débito legado (os 18 errors e ~147 warnings da baseline 0.5.8 abaixo) fica grandfathered: editar uma linha qualquer de um arquivo que já tem um error em *outra* linha não barra o commit. Para endurecer o gate no futuro (ex.: `--blocking warning` depois de pagar o débito de State & Effects), basta ajustar a flag.

> **Mudança de flag (0.5.x):** a flag `--fail-on <level>` da 0.2.x foi removida; o substituto é `--blocking <level>` (`error` | `warning` | `none`; default já é `error`). O hook e os scripts foram migrados no bump.

Por ser **local e opt-in** — cada clone precisa rodar o setup abaixo, e `git commit --no-verify` o ignora —, este gate é uma rede de proteção para quem desenvolve, não um portão de merge no servidor: ele não protege a `main` de forma incondicional. A opção por pre-commit em vez de um job de CI é deliberada, para manter a toolchain leve enquanto a baseline de errors é zero; promover o gate a um check de CI bloqueante é o passo natural caso o enforcement no servidor passe a ser necessário.

### Setup (1x por clone)

```bash
cd frontend && npm install      # instala o react-doctor pinado (binário em node_modules/.bin)
uv tool install pre-commit      # ou: pipx install pre-commit — `pre-commit` é um utilitário Python externo
pre-commit install              # da raiz do repo: grava o hook em .git/hooks
```

### Detalhes de implementação

- **`--scope changed --base HEAD`, não `--staged`**: a 0.5.x tem um modo `--staged` próprio para pre-commit, mas ele é *file-scoped* (escaneia o arquivo staged inteiro), o que quebraria o grandfathering — tocar uma linha qualquer de um arquivo com error legado em *outra* linha barraria o commit. Usamos `--scope changed --base HEAD`, que é *line-scoped* (só as linhas alteradas vs HEAD) e foi verificado na 0.5.8 reproduzindo o grandfathering: tocar uma linha limpa de um arquivo com errors em outras linhas não bloqueia; tocar uma linha que produz error bloqueia. Como o pre-commit faz auto-stash dos arquivos unstaged antes de rodar o hook, o working tree fica idêntico ao staged, então o diff vs HEAD enxerga exatamente o que vai ser commitado.
- **Migração de `--diff` → `--scope changed`**: até a 0.5.6 o hook e o script `react-doctor:diff` usavam `--diff [ref]`. A **0.5.7 deprecou `--diff`** (passou a imprimir um warning a cada run; [#844](https://github.com/millionco/react-doctor/pull/844)) em favor de `--scope changed` (`--base <ref>` para fixar a base). As duas flags foram verificadas equivalentes para o gate na 0.5.8 (mesmo comportamento line-scoped), então a migração é semanticamente neutra.
- O hook faz `cd frontend` (o react-doctor resolve config e escopo pelo diretório de execução) e invoca **diretamente** o binário pinado em `frontend/node_modules/.bin/react-doctor` — não via `npx`, que baixaria a versão mais recente do registry caso as deps não estivessem instaladas, furando o pin. Se o binário estiver ausente, o hook falha fechado pedindo `npm install`, em vez de prosseguir com uma versão não pinada.

## Baseline (react-doctor 0.5.8, medida em 2026-06-23)

Scan completo (`npm run react-doctor`) na 0.5.8, contra a `main` atual, já com os overrides aplicados:

- **Score: 39 / 100** (o algoritmo de score mudou entre 0.2 e 0.5 — não é comparável ao "75" da versão anterior; permaneceu 39 do bump 0.5.6 → 0.5.8).
- **18 errors / 147 warnings** (165 issues), distribuídos em: Security (6 errors), Bugs (12 errors + 91 warnings), Performance (20 warnings), Accessibility (4 warnings), Maintainability (32 warnings).

O bump 0.5.6 → 0.5.8 (só patches: timeouts de fase, ordenação determinística, auto-tuning de workers) **não alterou a saída de errors do ruleset**. A baseline anterior na 0.5.6 (2026-06-15) era 17 errors / 148 warnings; o delta de +1 error é deriva de código — a regra `server-no-mutable-module-state` voltou a disparar num `const` introduzido depois daquela medição (PR #211, 2026-06-22), não por mudança da versão.

Os 18 errors vêm de **quatro regras**, todas legítimas (não são FP) e por isso **não silenciadas** — ficam grandfathered pelo `--scope changed` line-scoped até que as linhas em questão sejam editadas:

- `react-doctor/no-adjust-state-on-prop-change` (11) — Bugs; ajustar state em effect/render conforme prop muda. Ex.: `DocumentPreview.tsx`, `CodingPage.tsx`, `MyVerdictsView.tsx`.
- `react-doctor/supabase-client-owned-authz-field` (4) — Security; campo de autorização escrito via client. Ex.: `lib/auto-review.ts`, `actions/{assignments,members,projects}.ts`.
- `react-doctor/supabase-table-missing-rls` (2) — Security; `CREATE TABLE` sem RLS em `migrations/{clerk_user_mapping,master_users}.sql`.
- `react-doctor/server-no-mutable-module-state` (1) — Bugs; `const AUTOMATION_MODE_VALUES = []` module-scoped em `actions/projects.ts:10`. Resolução é o mesmo padrão `Object.freeze()` já usado no projeto (ver seção "Regras que deixaram de ser FP"), em PR à parte.

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

`server-no-mutable-module-state` deixou de ser FP após o uso de `Object.freeze()` em `TAG_PROFILE` (ver `actions/documents.ts` e `actions/members.ts`). A regra voltou a disparar (1 error) num `const AUTOMATION_MODE_VALUES = []` introduzido em `actions/projects.ts:10` pelo PR #211 — grandfathered na baseline 0.5.8 acima, a resolver com o mesmo `Object.freeze()` em PR à parte.
