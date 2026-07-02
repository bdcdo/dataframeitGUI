# Configuração do react-doctor

> Este documento cobre **só o react-doctor**. Para a stack de qualidade completa — fallow (grafo do codebase), typescript-eslint type-checked (tipos), ruff (backend Python), React Scan (runtime), Dependabot/semgrep (segurança) e o mapa de qual hook dispara o quê — ver [`docs/CODE_QUALITY_TOOLING.md`](CODE_QUALITY_TOOLING.md).

O [react-doctor](https://react.doctor) é tratado como um linter da toolchain do frontend, no mesmo espírito do eslint/mypy: é uma `devDependency` **pinada** (`react-doctor@0.5.8` em `frontend/package.json`), roda via script `npm run`, e o arquivo `frontend/doctor.config.json` cumpre o papel de um `mypy.ini`/`.eslintrc` — fonte única de configuração (o config na raiz do repo foi removido para evitar drift, já que os scripts npm e o hook de pre-commit rodam escopados a `frontend/`).

> **Nome do arquivo de config (0.5.x):** a partir da 0.5, o react-doctor procura `doctor.config.*` (ou a chave `reactDoctor` em `package.json`); o nome antigo `react-doctor.config.json` deixou de ser reconhecido. O arquivo foi renomeado para `doctor.config.json` no bump 0.2.11 → 0.5.6. O schema (`ignore.overrides` + `rules`) é o mesmo.

## Como rodar

```bash
cd frontend
npm run react-doctor          # scan completo do app (report)
npm run react-doctor:diff     # só os arquivos do branch atual vs origin/main (check manual)
```

A config é lida do diretório de execução (o react-doctor resolve o projeto via `findNearestPackageDirectory`, e só `frontend/` tem `package.json`), por isso os comandos rodam de dentro de `frontend/`.

## Gate local de pre-commit — bloqueante para código novo, não para o legado

O gate roda **localmente, antes do commit** (estilo flake8/mypy), não no CI. `.pre-commit-config.yaml` define um hook `repo: local` que executa `react-doctor . --scope changed --base HEAD --blocking error` em commits que tocam arquivos `frontend/**/*.{ts,tsx}`. Como `--scope changed --base HEAD` reporta só issues nas *linhas* alteradas vs HEAD — verificado na 0.5.8 — e `--blocking error` só falha em diagnósticos *error*-level, o gate **bloqueia somente quando o commit toca uma linha que produz um error**. Todo o débito legado (os 8 errors e ~118 warnings da baseline 0.5.8 abaixo) fica grandfathered: editar uma linha qualquer de um arquivo que já tem um error em *outra* linha não barra o commit. Para endurecer o gate no futuro (ex.: `--blocking warning` depois de pagar o débito de State & Effects), basta ajustar a flag.

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

- **Score: 53 / 100** (o algoritmo de score mudou entre 0.2 e 0.5 — não é comparável ao "75" da 0.2.x; era 39 na medição do bump em 2026-06-15 e subiu para 53 conforme o débito de errors foi pago nos PRs abaixo).
- **8 errors / 118 warnings** (126 issues), distribuídos em: Bugs (8 errors + 75 warnings), Performance (19 warnings), Maintainability (24 warnings).

O bump 0.5.6 → 0.5.8 (só patches: timeouts de fase, ordenação determinística, auto-tuning de workers) **não alterou a saída de errors do ruleset** — verificado empiricamente, 0.5.6 e 0.5.8 produzem os mesmos diagnósticos. A queda de 17 errors (baseline 0.5.6, 2026-06-15) para 8 é efeito de outros PRs mesclados na `main` desde então, não da versão: #203/#242 tirou os 6 errors de Security da contagem (silenciados como FP — ver abaixo) e aplicou `Object.freeze()` em `AUTOMATION_MODE_VALUES` (zerando `server-no-mutable-module-state` em `actions/projects.ts`), enquanto #232/#246/#248 refatoraram `MyVerdictsView`, `AnswerCard` e `MobileWarning`, encolhendo o cluster de Bugs. Conte sempre via `npm run react-doctor`, **não fixe o total aqui**.

Os 8 errors restantes são todos da regra `react-doctor/no-adjust-state-on-prop-change` (Bugs; ajustar state em effect/render conforme prop muda) — débito **legítimo e não silenciado**, grandfathered pelo `--scope changed` line-scoped até que as linhas em questão sejam editadas. Ex.: `AutoReviewFieldPanel.tsx`, `AutoReviewPage.tsx`, `CodingPage.tsx`, `QuestionsPanel.tsx`, `DocumentPreview.tsx`, `DocumentSelector.tsx`, `LlmConfigurePane.tsx`.

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

## `no-multi-comp` ignorada em `src/components/ui/**`

Os compound components do shadcn/Radix declaram, por convenção da biblioteca, vários componentes no mesmo arquivo: `ui/collapsible` (`Collapsible` + `CollapsibleTrigger` + `CollapsibleContent`) e `ui/resizable` (`ResizablePanelGroup` + `ResizablePanel` + `ResizableHandle`). A regra `react-doctor/no-multi-comp` (Maintainability) pede mover cada componente secundário para o seu próprio arquivo, o que quebraria o padrão de import único da lib. O override silencia a regra **apenas em `src/components/ui/**`** (×4 ocorrências na 0.5.6), mesmo escopo e justificativa de `only-export-components`. Fora de `ui/**` a regra continua ativa, onde múltiplos componentes por arquivo é sinal real de arquivo grande demais.

## `exhaustive-deps` suprimida em `src/components/coding/QuestionsPanel.tsx`

Os dois `useEffect` de `QuestionsPanel.tsx` (linhas 179 e 205 na 0.5.6) têm deps estreitas **deliberadas**, já anotadas com `// eslint-disable-next-line react-hooks/exhaustive-deps` no código: um anula respostas de campos condicionais que ficaram invisíveis (FR-203), reagindo só a `visibleNames` para evitar cascata; o outro rola até o campo condicional recém-revelado, também disparando só por `visibleNames`. Incluir as demais deps (`fields`, `answers`, refs) reintroduziria os efeitos em cascata que o design evita. O `eslint-disable` cobre o ESLint, mas o react-doctor mantém a sua própria regra `exhaustive-deps`; o override por arquivo silencia **só este arquivo**. As outras 5 ocorrências de `exhaustive-deps` no app (`MultiOptionReview`, `LlmConfigurePane`, `ReviewCommentsView`, `MyVerdictsView`) **não** foram avaliadas como deliberadas e ficam para a issue de hooks / State & Effects — não suprimir em bloco.

## `js-length-check-first` suprimida em `src/lib/date-parts.ts`

`arePartsValid` (linha 39) faz `parts.every((p, i) => ...)` sobre `DateParts`, uma tuple de **tamanho fixo 3** garantida pelo tipo (`[day, month, year]`). A regra `react-doctor/js-length-check-first` (Performance) sugere checar `.length` antes de iterar — otimização morta aqui, já que o comprimento é constante de tipo e não há array vazio possível. Override por arquivo.

## a11y (`prefer-tag-over-role`, `prefer-html-dialog`, `no-noninteractive-element-interactions`) — avaliada, **não** suprimida

As ocorrências dessas três regras na 0.5.6 — `shell/MobileWarning.tsx:21` (`<div role="dialog">`) e `compare/AnswerCard.tsx` (`<div role="button">` e handler em elemento não-interativo) — são **HTML cru de código de app, não primitivas Radix vendidas**. Diferente de um `role` herdado de uma primitiva da lib (que seria convenção a silenciar), aqui o caminho correto é **refatorar** para o elemento semântico nativo (`<dialog>`, `<button>`). Por isso ficam fora desta supressão de convenção e seguem para a issue de a11y (refactor), não para o `doctor.config.json`. Os FPs antigos da #152 `js-min-max-loop` (`AssignmentTable.tsx`) e `jsx-a11y/label-has-associated-control` (`MemberList.tsx`) não reproduzem mais na 0.5.6 e não exigiram supressão.

## `async-await-in-loop` suprimida inline no upload serial de `useDocumentUpload`

A regra `react-doctor/async-await-in-loop` (Performance) recomenda coletar os itens e usar `await Promise.all(items.map(...))` para rodar trabalho independente em paralelo. Em `src/hooks/useDocumentUpload.ts`, o loop de upload em chunks (`doUpload`) é **serial de propósito** e não pode paralelizar: o progresso é reportado sequencialmente (`setPhase({ kind: "uploading", current: processed, ... })`), e a flag `isLast` é o 3º argumento `revalidate` de `uploadDocuments` — passá-la `true` só no último chunk revalida o cache de documentos uma vez, em vez de uma vez por chunk. Disparar os chunks juntos quebraria as duas garantias.

A supressão é **inline e por linha** — `// react-doctor-disable-next-line react-doctor/async-await-in-loop` imediatamente acima da chamada `await uploadDocuments(...)` —, não um override por arquivo no `doctor.config.json`. Inline é mais estreito: a regra continua ativa no resto do hook (pega qualquer `await`-em-loop novo). A justificativa fica numa linha de comentário **separada** acima da diretiva (o parser da diretiva trata o texto após o nome da regra como rule-ids adicionais, então não se usa o sufixo `-- ...` do ESLint aqui).

O segundo `async-await-in-loop` que existia no mesmo arquivo (o loop de `checkDuplicates`) **não** foi suprimido: como os chunks de hash são independentes e a agregação é comutativa, foi paralelizado de fato (#254, Onda 4) — com teto de concorrência via `mapWithConcurrency` (`src/lib/upload-chunking.ts`, limite `MAX_HASH_CHECK_CONCURRENCY = 6`), para que um CSV gigante não dispare centenas de Server Actions de uma vez. Se o progresso sequencial deixar de ser necessário e a revalidação migrar para fora do loop, remover esta supressão e paralelizar o upload também.

## Bugs residual (Onda 5, #305) — supressões por arquivo

O re-scan 0.5.8 deixou 36 diagnósticos da categoria **Bugs** sem dono (épico #239). A maioria virou fix real (ver PRs de #305): o error `no-adjust-state-on-prop-change` em `AutoReviewFieldPanel` foi resolvido com `key={currentKey}` no pai (remonta ao trocar de doc/campo, dispensando o effect de sincronização) e o `exhaustive-deps` em `ReviewCommentsView` saiu movendo `splitSources` para constante de módulo. Os 4 `server-sequential-independent-await` que apareciam como Bugs na 0.5.8 foram tratados na #236 (PR #307): `reviews.ts` e `suggestions.ts` viraram `Promise.all` de awaits genuinamente independentes, e `equivalences.ts` (read-then-delete de ordem obrigatória) ganhou supressão inline — por isso não há override deles aqui. As supressões abaixo cobrem só os diagnósticos confirmados como FP ou design intencional, auditados contra o validation-prompt canônico de cada regra.

- **`no-event-handler` (foco pós-render)** em `AutoReviewFieldPanel.tsx:106`, `ComparisonPanel.tsx:127` e `CommentCard.tsx:494`: os três effects focam um elemento (`textarea`/`button`) **depois** que uma escolha/conclusão o renderiza. A recipe da regra ("mover para o handler que mudou o state") não se aplica: o alvo do foco só existe no DOM após o re-render disparado pela mudança de state, então `focus()` precisa rodar num effect, não no handler. Override por arquivo.
- **`no-event-handler` (subscription externa)** em `usePinnedDoc.ts:43,58`: o state lido (`pinnedDocId`) vem de `useSyncExternalStore` subscrito a eventos de `sessionStorage`/`PINNED_DOC_EVENT`. É o FP explícito do validation-prompt (state de subscription externa que o handler não observa). O effect faz cleanup legítimo do doc órfão. Override por arquivo.
- **`no-fetch-in-effect`** em `useAutosaveOnExit.ts:68`: o effect registra `visibilitychange` e, quando a aba some, chama `navigator.sendBeacon` (com fallback `fetch(..., { keepalive: true })`) para salvar antes de sair. É exatamente a exceção que o próprio prompt da regra reconhece (auto-save on exit; uma lib de data-fetching não cobre o caso de `sendBeacon` em unload). Override por arquivo.
- **`no-chain-state-updates` + `no-derived-state`** em `useDocumentText.ts:76`: `setCache` e `setFailed` ficam em `.then`/`.catch` **independentes** do mesmo fetch — não há encadeamento síncrono nem derivação de state. `loading`/`error` já são derivados em render (não há useState para eles). O hook é bespoke por decisão registrada (mapa `failed` separado do `cache` para retry semântico — erro não envenena o cache; não migra para `useCachedResource`). Override por arquivo, duas regras.
- **`no-array-index-as-key`** em `AssignmentTable.tsx:201`, `OptionsEditor.tsx:54`, `ValidationErrorPanel.tsx:76` e `ExportPanel.tsx:229`: nenhum dos quatro perde estado de React no reorder. `AssignmentTable` mapeia um array local append-only (`tooltipParts`) montado a cada render; `ValidationErrorPanel` (`<li>`) e `ExportPanel` (preview `<td>`) são listas read-only sem estado por item; `OptionsEditor` renderiza `<Input value={opt}>` **controlado** pelas props (sem estado interno a perder) sobre `string[]` que pode duplicar — sem identidade estável possível, e a remoção já move o foco para o botão. Override por arquivo.

## Quick wins (Fase 0, #353) — supressões documentadas

Fase 0 do épico #239 (rastreada por #339): PR de baixo risco que remove 5 warnings baratos da 0.5.8 **sem decompor componentes**. Um foi resolvido por deleção de causa raiz, os outros 4 por supressão auditada.

- **`deslop/unused-file`** em `src/lib/supabase/client.ts`: **deletado, não suprimido.** Órfão (zero imports em `src`); a única export `createBrowserClient` usava o template JWT antigo `getToken({ template: "supabase" })`, morto após a migração de auth RS256 (#299/#309). Fix de causa raiz.
- **`no-giant-component`** em `src/app/(app)/projects/[id]/analyze/compare/page.tsx:59` (`ComparePageRoute`, 491 linhas) e `src/app/(app)/projects/[id]/reviews/comments/page.tsx:8` (`CommentsPage`, 433 linhas): override **por arquivo**, escopado só a estes 2 **page-level route components** (a #339 endossa suprimir esses — são fronteiras de rota, não unidades reusáveis a decompor). A regra segue ativa nos outros 2 disparos (`LotteryDialog.tsx:201`, `DocumentsPageClient.tsx:70`), que **não** são route components e ficam para refactor real numa fase posterior — desligar a regra global os mascararia.
- **`no-json-parse-stringify-clone`** em `src/lib/__tests__/lottery-utils.test.ts:518`: supressão **inline**. Deep clone (`JSON.parse(JSON.stringify(...))`) de uma fixture plana de `coOccurrence` para snapshot do teste de imutabilidade — FP legítimo em arquivo de teste; o objeto não tem `Date`/`Map`/`undefined` que o round-trip perderia.
- **`async-defer-await`** em `src/components/shared/RunLlmButton.tsx:62`: supressão **inline**. O `await requireSupabaseToken(getToken)` roda antes do guard de cancelamento **de propósito** — o token do template expira em ~60s e precisa estar fresco quando a request de status parte a cada poll; mover o await para baixo do guard atrasaria a renovação. Mesma razão da supressão inline que já existia logo abaixo, no `await fetchFastAPI` do mesmo `poll` (esta é a 2ª ocorrência da regra no mesmo bloco; diagnóstico novo, não previsto na #339).

## Regras que deixaram de ser FP

`server-no-mutable-module-state` deixou de ser FP após o uso de `Object.freeze()` em `TAG_PROFILE` (ver `actions/documents.ts` e `actions/members.ts`) e em `AUTOMATION_MODE_VALUES` (`actions/projects.ts`).
