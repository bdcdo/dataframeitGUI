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

- **Score: 39 / 100** na medição do bump (o algoritmo de score mudou entre 0.2 e 0.5 — não é comparável ao "75" da versão anterior).
- **Baseline do bump (2026-06-15): 17 errors** contabilizados — Security (6 errors), Bugs (11 errors), além de ~148 warnings (Bugs 90, Performance 19, Accessibility 5, Maintainability 34).
- **Após a auditoria de #203: os 6 errors de Security saem da contagem** (Security 6 → 0 errors). Foram classificados como falso positivo e silenciados via override escopado por arquivo (ver as duas subseções abaixo). Restam os errors da categoria Bugs.

Os errors do bump vinham de **três regras novas** da 0.5.x. Após #203, o débito de errors **legítimo e não silenciado** é o da categoria Bugs — sobretudo o cluster `no-adjust-state-on-prop-change` —, grandfathered pelo `--diff` hunk-scoped até que as linhas em questão sejam editadas:

- `react-doctor/no-adjust-state-on-prop-change` (11) — Bugs; ajustar state em effect/render conforme prop muda. Ex.: `DocumentPreview.tsx`, `CodingPage.tsx`, `MyVerdictsView.tsx`. **Legítimo, não silenciado.** (Um scan posterior pode listar também `server-no-mutable-module-state` em `projects.ts` conforme o código evolui; contar via `npm run react-doctor`, não fixar o total aqui.)

Os 6 errors de Security (4 `supabase-client-owned-authz-field` + 2 `supabase-table-missing-rls`) foram auditados em #203, confirmados como FP heurístico e silenciados por arquivo — detalhes nas subseções "Por que `supabase-client-owned-authz-field`…" e "Por que `supabase-table-missing-rls`…" abaixo.

Pagar o débito de Bugs restante é trabalho de PR(s) à parte (cluster State & Effects #149/#152), fora do escopo de #203. O gate de pre-commit não obriga a corrigi-los para commitar — só barra se a *linha* alterada produzir um error.

## Por que `server-auth-actions` está silenciada em `src/actions/**`

A regra `react-doctor/server-auth-actions` verifica se Server Actions chamam um helper de autenticação reconhecido (por padrão, `auth()` do Clerk). O projeto usa um wrapper próprio, `getAuthUser()` (definido em `frontend/src/lib/auth.ts`), que internamente chama `auth()` mas adiciona resolução do usuário no Supabase. A heurística do react-doctor não reconhece esse wrapper, o que gera dezenas de falsos positivos em actions que estão corretamente autenticadas.

A silenciagem está restrita a `src/actions/**` (escopo onde o padrão é universal e auditável por code review). Não silenciar globalmente.

Se o react-doctor passar a aceitar custom auth helpers (ou se o projeto adotar `auth()` direto), remover este override.

## `only-export-components` ignorada em `src/components/ui/**`

Os componentes shadcn/ui (`ui/button`, `ui/badge`, `ui/tabs`) exportam, além do componente, suas variantes CVA (`buttonVariants`, `badgeVariants` etc.) — convenção intencional do shadcn. A regra `react-doctor/only-export-components` (orientada a Fast Refresh) acusa isso como error. O override silencia a regra **apenas em `src/components/ui/**`** (onde o padrão é da própria biblioteca), mantendo-a ativa no resto do app. Na 0.2.x estes eram os únicos errors do codebase, junto com `server-auth-actions`; com os overrides, a baseline daquela versão era 0 errors. Na 0.5.6 o ruleset expandido introduziu novos errors (ver baseline abaixo), mas estes dois overrides continuam necessários e ativos.

## Por que `supabase-client-owned-authz-field` está silenciada nos 4 arquivos auditados

A regra `react-doctor/supabase-client-owned-authz-field` acusa código client Supabase que escreve campos de `user`/`tenant`/`owner`/`role` que deveriam ser enforçados pela RLS. Os 4 disparos da baseline foram auditados em #203 e confirmados como FP heurístico — silenciados **por arquivo** (não pela regra inteira, nem por `src/actions/**`), para que a regra continue pegando actions novas:

- `src/lib/auto-review.ts` — a escrita (`assignments.status`, `field_reviews`) passa pelo **admin client** (service-role), que ignora a RLS por design; `status` é estado de workflow, não autz. O uso do admin é deliberado e comentado no arquivo (a policy de `assignments` restringe INSERT a coordenadores; o pesquisador precisa criar a própria fila de revisão).
- `src/actions/assignments.ts` — a regra aponta o parâmetro `userId`; as escritas gravam `type`/`assignment_weight`/`assignment_cap` (operacionais) e são barradas pela policy `Coordinators manage assignments`.
- `src/actions/members.ts` — escreve `role`/`can_resolve`/`can_arbitrate`/`can_compare` via client autenticado, mas a policy `Coordinators manage members` (`USING project_id IN auth_user_coordinator_or_creator_project_ids() OR is_master()`) barra qualquer não-coordenador: o UPDATE afeta 0 linhas e o código retorna "Sem permissão". Não há auto-escalação explorável. A ausência de um *column-level guard* em `project_members` (defesa em profundidade, presente em `projects`/`project_comments`/`schema_change_log`) é a única lacuna real, rastreada em issue-filha de #203 — não é vulnerabilidade, e fechá-la embute decisão de produto (se um coordenador pode alternar as próprias flags).
- `src/actions/projects.ts` — `role: "coordenador"` inserido no bootstrap criador→coordenador, gated pela policy `Creator inserts members` (só permite inserir em projeto cujo `created_by = clerk_uid()`). Intencional; ninguém entra em projeto alheio.

Se algum desses fluxos migrar para depender de coluna client-fornecida sem RLS, **remover o override do arquivo afetado** e corrigir.

## Por que `supabase-table-missing-rls` está silenciada nas 2 migrations auditadas

A regra `react-doctor/supabase-table-missing-rls` acusa `CREATE TABLE` que não habilita RLS **na mesma migration**. Os 2 disparos (`migrations/20260401000000_clerk_user_mapping.sql` e `migrations/20260402000000_master_users.sql`) foram auditados em #203 e são FP: ambas as tabelas têm RLS habilitada numa migration posterior (`20260407000000_enable_rls_system_tables.sql`) somada a `REVOKE ALL ... FROM anon, authenticated`, e são acessadas só via service-role (`lib/clerk-sync.ts` e `lib/auth.ts`). A proteção existe — só está distribuída entre arquivos, padrão que a heurística não reconhece. Editar migrations já aplicadas em produção para re-habilitar RLS seria no-op.

O override é escopado **às duas migrations específicas**, de propósito: uma `CREATE TABLE` nova sem RLS deve continuar falhando.

## `js-combine-iterations` desligada globalmente

22 ocorrências de `.filter().map()` (e cadeias afins) sobre arrays pequenos — cosmético, sem impacto real de performance no domínio do projeto. Desligada via `rules` (severidade global `off`), não via ignore por caminho.

## Regras que deixaram de ser FP

`server-no-mutable-module-state` deixou de ser FP após o uso de `Object.freeze()` em `TAG_PROFILE` (ver `actions/documents.ts` e `actions/members.ts`).
