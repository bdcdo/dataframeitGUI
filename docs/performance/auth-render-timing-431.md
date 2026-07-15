# RFC: decomposição do render autenticado

> Status: proposta de instrumentação e protocolo da issue #431. Esta PR não contém medição pós-deploy, não afirma a causa da cauda de 1,3 s e não altera SC-001/RC-006. A execução depende do cutover Clerk da #348 e de um deploy posterior; por isso a referência correta é `Refs #431`.

## Decisão

Não usar `Server-Timing` como fonte de verdade para a decomposição dessa rota RSC no Next.js 16. O contrato público de `headers()` em Server Components é read-only; o Proxy pode definir response headers, mas executa antes do render; e `after()` só roda depois de a resposta terminar. Logo, nenhum desses pontos consegue conhecer os tempos de `currentUser()`, queries e render e ainda acrescentá-los com fidelidade a um header que já começou a ser enviado.

A proposta usa o caminho oficialmente suportado pelo Next.js: OpenTelemetry para o root span `[http.method] [next.route]`, `render route (app) [next.route]` e `start response`, identificados também pelos `next.span_type` oficiais, acrescido de spans mínimos nas fronteiras de auth do projeto. O Playwright continua sendo a fonte das durações observadas pelo navegador. Um ID aleatório de correlação liga a amostra do browser ao trace/log, sem token, e-mail, UUID de usuário, ID de projeto ou conteúdo de pesquisa.

Se não houver collector OTLP aprovado no momento da implementação, o fallback precisa continuar sendo OpenTelemetry, com exporter temporário para stdout habilitado por `AUTH_TIMING_DEBUG=1`. JSON ad hoc pode resumir contadores, mas não substitui os spans internos do Next: sem registrar um provider/exporter, ele não observa `render route (app)` nem `start response`. O fallback não altera a resposta, não vira log permanente e existe somente para a janela N=25 + 2 warmups.

## Evidência já disponível

A issue registra uma medição anterior em produção, com conta coordenadora, cache desabilitado, rota `/projects/<id>/analyze/code`, 2 warmups descartados e 25 amostras. O TTFB teve p50 de 699 ms, p95 de 1.352 ms, mínimo de 582 ms e máximo de 1.363 ms; o proxy de utilizabilidade `domInteractive - startTime` teve p50 de 917 ms, p95 de 1.517 ms, mínimo de 637 ms e máximo de 1.585 ms. Esses números formam o baseline histórico; esta PR não os reproduziu nem os substitui.

O alvo segue intacto: SC-001/RC-006 exige que a página protegida fique utilizável em p95 ≤ 300 ms, com 150–250 ms como faixa de qualidade. O protocolo preserva `domInteractive - startTime` como o proxy de utilizabilidade já publicado e reporta TTFB separadamente como componente diagnóstico; TTFB ≤ 300 ms, sozinho, não faz o gate passar. Nenhuma conclusão deste RFC autoriza alterar o limiar ou trocar a métrica por uma mais fácil. Se a medição mostrar que o objetivo é incompatível com o contrato escolhido, uma decisão separada e explícita será necessária.

## Caminho atual, verificado no código

### Resolução de identidade

`resolveAuth()` em `frontend/src/lib/auth.ts` está envolvido por `cache()` do React e faz, em sequência:

1. `currentUser()` no Clerk;
2. leitura read-only de `clerk_user_mapping` pelo client admin;
3. leitura de `master_users` pelo client admin;
4. construção de `AuthResolution`.

`AUTH_RESOLVE_DEBUG=1` hoje emite somente uma linha quando o corpo cacheado executa. Esse sinal é útil para confirmar uma resolução por request, mas não traz duração, correlação, status de estágio ou máquina.

### Emissão do token Supabase

`createSupabaseServer()` em `frontend/src/lib/supabase/server.ts` não está cacheado. Cada chamada executa `auth()` e depois `getToken({ template: "supabase" })` antes de criar o client. A documentação do Clerk alerta que JWT templates customizados podem acrescentar latência de geração.

Na rota representativa, há cinco chamadas estaticamente alcançáveis a `createSupabaseServer()`:

| Consumidor | Motivo |
|---|---|
| `projects/[id]/layout.tsx` | profile e demais leituras do layout |
| `getProjectAccessContext()` | projeto + membership |
| `getRunningLlmCount()` | badge de run em andamento |
| `analyze/layout.tsx` | assignments e modo de automação |
| `analyze/code/page.tsx` | projeto, documentos, rounds, respostas e exclusões |

As chamadas a `isProjectCoordinator(id, user)` no layout de análise e na página chegam ao mesmo `getProjectAccessContext(id, user.id, user.isMaster)` já iniciado pelo layout do projeto; por isso não acrescentam uma sexta ou sétima criação. `resolveAuth()` e `getProjectAccessContext()` têm deduplicação request-scoped, mas os cinco clients/token fetches acima não compartilham esse cache. “Cinco alcançáveis” não é o mesmo que “cinco roundtrips remotos”: o SDK pode cachear o token e a execução RSC pode intercalar consumidores. A instrumentação deve contar e medir, sem presumir o comportamento interno.

### Render RSC

A request atravessa `(app)/layout.tsx`, `projects/[id]/layout.tsx`, `analyze/layout.tsx` e `analyze/code/page.tsx`. Medir apenas o tempo da função de um layout não mede os filhos: Server Components podem renderizar e transmitir em streaming. O span padrão `render route (app)` e o marco `start response` do Next.js são os sinais adequados para delimitar render e primeiro byte.

## Por que `Server-Timing` foi rejeitado

| Alternativa | Limitação no contrato atual |
|---|---|
| chamar `headers().set()` dentro de `resolveAuth()` | `headers()` devolve os headers de entrada em modo read-only |
| definir `Server-Timing` no Proxy | o Proxy roda antes de `currentUser()`, Supabase e render; só poderia publicar um número ainda desconhecido |
| usar `after()` no layout | o callback ocorre depois que a resposta terminou; pode logar, mas não reescrever um header já enviado |
| envolver a página em Route Handler | muda a semântica do App Router e do streaming para obter apenas observabilidade |
| criar custom server Node | amplia a stack e contraria a simplicidade constitucional sem necessidade, pois o Next já expõe spans oficiais |

Um `Server-Timing` estático ou parcial seria pior que a ausência do header: pareceria uma decomposição completa ao consumidor e ocultaria estágios posteriores. O RFC não proíbe um proxy de borda futuro que tenha um hook pós-upstream; apenas registra que esse mecanismo não existe na arquitetura atual.

## Taxonomia de spans e logs

Todos os nomes têm versão de schema `1`. Durações são monotônicas, em milissegundos, e cada evento pertence a um único request.

| Nome | Limites | Atributos permitidos |
|---|---|---|
| `[http.method] [next.route]` | root span padrão de cada request | `next.span_type=BaseServer.handleRequest`, método, status e rota normalizada |
| `auth.resolve` | entrada até retorno/throw de `resolveAuth()` | `auth.status`, `auth.resolve_count`, `error.type` categórico |
| `auth.clerk.current_user` | somente `currentUser()` | `outcome=present|signed_out|error` |
| `auth.supabase.mapping` | somente query a `clerk_user_mapping` | `outcome=match|missing|error` |
| `auth.supabase.master` | somente query a `master_users` | `outcome=master|regular|error` |
| `auth.clerk.supabase_token` | somente `getToken({ template: "supabase" })` | `outcome=present|missing|error`, `call_index` |
| `auth.supabase.client` | criação lógica do client server-side | `call_index`, sem URL com query |
| `app.supabase.fetch` | wrapper seguro das chamadas Supabase feitas pelos cinco clients | `stage` de allowlist, host e status; nunca URL bruta |
| `render route (app) [next.route]` | span padrão do Next para o App Router | `next.span_type=AppRender.getBodyResult`, rota normalizada |
| `start response` | marco padrão zero-length para o primeiro byte enviado | `next.span_type=NextNodeServer.startResponse`, sem identidade |

Os spans `fetch` automáticos do Next não podem ser exportados como vêm: a documentação oficial inclui `http.url`, que nas chamadas PostgREST contém filtros e IDs reais. A implementação deve usar `NEXT_OTEL_FETCH_DISABLED=1` e um wrapper de `fetch` seguro passado ao client Supabase, ou provar por teste que um processor in-process remove a URL antes de qualquer exporter. Sanitização apenas no collector é insuficiente para o fallback em stdout.

No fallback, o evento final contém `request_id`, `route_pattern`, `release`, `machine_id`, `machine_version`, `machine_region`, `resolve_count`, `supabase_token_count`, durações por estágio e outcome. O total `supabase_token_count` pertence ao evento final, porque um span individual já encerrado não conhece o total futuro da request. Os valores `FLY_MACHINE_ID`, `FLY_MACHINE_VERSION`, `FLY_REGION` e `FLY_IMAGE_REF` são metadados de runtime fornecidos pelo Fly e permitem testar a hipótese de cauda por máquina/release sem registrar IP do usuário.

## Privacidade e cardinalidade

É proibido anexar aos spans/logs:

- JWT, cookie ou header `Authorization`;
- e-mail, nome, Clerk user ID, UUID Supabase ou `supabase_uid`;
- project ID, document ID, querystring, texto ou resposta;
- URL completa do Supabase quando contiver filtro/query;
- stack trace de SDK que incorpore request headers.

A rota é normalizada para `/projects/:id/analyze/code`. `request_id` é UUID aleatório gerado pelo servidor e não deriva de sessão. Na série principal ele tem cardinalidade deliberadamente limitada a 27 valores — 2 warmups e 25 amostras —, pode aparecer somente em spans/logs da janela e nunca vira label de métrica, resource attribute ou dimensão de dashboard. Em collector permanente, logs usam o `trace_id`/`span_id` nativo para correlação e o ID exposto ao browser é descartado depois da série. `machine_id`, release, stage, outcome e status têm cardinalidade operacional conhecida; erro externo é reduzido a uma enumeração (`timeout`, `rate_limit`, `network`, `unauthorized`, `unknown`) antes de sair do processo.

## Implementação proposta, em PR posterior

### Etapa A — collector ou fallback

1. Decidir retenção, acesso e endpoint OTLP. Não enviar traces a terceiro sem decisão de tratamento dos dados.
2. Se houver collector, adicionar `instrumentation.ts` conforme o contrato estável do Next e registrar OpenTelemetry uma vez no boot.
3. Se não houver collector, registrar temporariamente um exporter OpenTelemetry para stdout sob `AUTH_TIMING_DEBUG=1`, preservando os spans padrão do Next e os spans customizados; desligá-lo logo depois.
4. Habilitar `NEXT_OTEL_VERBOSE=1` na janela e testar a presença dos três sinais oficiais exigidos: root `BaseServer.handleRequest`, render `AppRender.getBodyResult` e primeiro byte `NextNodeServer.startResponse`.
5. Desabilitar o `fetch` automático com `NEXT_OTEL_FETCH_DISABLED=1` e instrumentar o `fetch` fornecido ao Supabase com atributos de allowlist, salvo se um teste do exporter in-process provar que nenhuma URL bruta chega ao collector ou stdout.

### Etapa B — correlação request-scoped

1. O Proxy sobrescreve qualquer `x-auth-perf-request-id` de entrada por um UUID novo e o encaminha apenas ao app.
2. Para facilitar a captura pelo Playwright, a resposta pode expor o mesmo UUID aleatório sob um header próprio; ele não contém estado autenticado.
3. O trace/log carrega o ID apenas durante as 27 requests da série, junto de route pattern e metadados Fly; métricas e resources nunca recebem esse ID.
4. O teste do Proxy prova que um header fornecido pelo cliente não é confiado nem ecoado.

### Etapa C — spans mínimos

1. Envolver `currentUser()`, mapping e master-check sem capturar argumentos nem resultados brutos.
2. Envolver `getToken({ template: "supabase" })` e incrementar um contador request-scoped.
3. Envolver as chamadas Supabase restantes no `fetch` seguro com `stage` de allowlist; nunca derivar atributo de querystring, ID ou corpo.
4. Preservar `cache()` de `resolveAuth()` e medir `resolve_count`; não criar cache global.
5. Não capturar o token, nem mesmo em erro.
6. Não mudar ordem, fallback, tratamento de erro, privilégio ou client Supabase nesta etapa.

### Etapa D — testes

Os testes unitários devem provar:

1. flag desligado produz zero log customizado e preserva o resultado;
2. cada estágio emite exatamente um span por execução de `resolveAuth()`;
3. signed-out não emite mapping/master;
4. erro mantém o comportamento original e registra somente categoria;
5. cinco criações do client geram cinco índices observáveis sem incluir token;
6. o contador final registra `supabase_token_count=5`, sem fingir que cada span individual conhecia o total;
7. serialização não contém e-mail, Clerk ID, UUID, token, cookie, header, URL PostgREST ou querystring;
8. correlação inbound é substituída pelo servidor e não aparece em métricas/resources;
9. `auth.resolve_count` continua 1 na request E2E representativa;
10. o trace E2E contém exatamente um root `BaseServer.handleRequest`, ao menos um render `AppRender.getBodyResult` da rota e um marco `NextNodeServer.startResponse`.

Typecheck, Vitest completo, lint types, fallow e React Doctor são gates obrigatórios. O E2E autenticado deve ser delegado a um agente dedicado e só pode ser declarado verde com as credenciais do ambiente correto.

## Protocolo comparável ao baseline

### Pré-condições

1. #348 concluída e observada como estável; publishable key, secret key, issuer, JWKS, token template e Supabase pertencem à mesma instância live.
2. Release e configuração de instrumentação identificados.
3. Frontend em `gru`, `auto_stop_machines="off"` e `min_machines_running=1`, conferidos no estado remoto.
4. Conta coordenadora com vínculo preparado, sem fluxo de conclusão pendente.
5. Projeto representativo e rota idênticos ao baseline.
6. Nenhum deploy, migração, sync de usuários ou run LLM durante a série.
7. Relógio do cliente sincronizado e rede sem VPN/proxy adicional.

Falha em qualquer pré-condição invalida a série; não se completa N com amostras de dois releases ou dois tenants.

### Aquecimento e amostra principal

1. Abrir um contexto Playwright autenticado e reutilizar a mesma sessão.
2. Desabilitar cache do navegador e acrescentar query de cache-bust distinta por navegação, removida dos artefatos publicados.
3. Fazer 2 navegações sequenciais de warmup e descartá-las.
4. Fazer 25 navegações sequenciais, aguardando a anterior concluir antes da próxima.
5. Não abrir outros papéis ou abas em paralelo.
6. Registrar para cada amostra: status HTTP, TTFB (`responseStart − requestStart`), o mesmo proxy de utilizabilidade do baseline (`domInteractive − startTime`), request ID, release/máquina/região, intervalos dos spans, contadores e outcome.
7. Guardar o JSON bruto fora do Git se contiver URL real; publicar apenas rota normalizada, números e agregados.

O p95 usa nearest-rank: ordenar 25 valores e selecionar a posição `ceil(0,95 × 25) = 24`, contando a partir de 1. O cálculo é feito separadamente para TTFB e `domInteractive − startTime`; a amostra p95 do waterfall é selecionada pela métrica de utilizabilidade que governa SC-001/RC-006, não pelo TTFB. Publicar N, warmups, p50, p95, mínimo, máximo e os dois vetores completos de 25 durações anonimizadas; sem isso, a conclusão não é auditável.

### Série secundária para a cauda

A série principal permanece sequencial para ser comparável. Somente depois, se a cauda persistir, executar uma série diagnóstica separada com concorrência controlada e identificada, sem misturar seus resultados ao N=25.

Para cada pico, correlacionar:

- `auth.clerk.current_user` e `auth.clerk.supabase_token`;
- mapping/master Supabase;
- demais spans seguros `app.supabase.fetch`;
- `render route (app)` e `start response`;
- Machine/release/região;
- métricas Fly de CPU balance, throttle, memória e load no mesmo intervalo;
- erro/rate-limit categórico.

Não atribuir pico a autostart, GC, Supabase ou Clerk apenas pela forma da distribuição. A origem é considerada identificada somente quando o estágio anômalo e a infraestrutura correlata aparecem nas mesmas amostras, ou quando uma hipótese é reproduzida em série controlada.

## Cálculo da decomposição

| Quantidade | Fonte |
|---|---|
| TTFB percebido | Navigation Timing do Playwright |
| utilizabilidade de SC-001/RC-006 | `domInteractive − startTime`, preservado como proxy comparável ao baseline |
| tempo até primeiro byte no servidor | root span → `start response` do Next |
| render App Router | `render route (app)` |
| identidade Clerk | `auth.clerk.current_user` |
| mapping | `auth.supabase.mapping` |
| master-check | `auth.supabase.master` |
| geração de tokens Supabase | soma e contagem de `auth.clerk.supabase_token` |
| queries de dados restantes | spans `app.supabase.fetch` agrupados por `stage` de allowlist |
| proxy/rede/residual | TTFB do browser menos o marco server-side comparável, explicitado como residual e não como “rede pura” |

Spans concorrentes não devem ser somados como se fossem sequenciais. Para cada request, o exportador normaliza todos os timestamps pelo início do root span, valida que filhos terminam dentro dele, ordena os intervalos e calcula a união dos intervalos por estágio; o caminho crítico até `start response` é a cadeia causal/temporal que alcança esse marco, não a soma de durações sobrepostas. O relatório precisa mostrar um waterfall da amostra mediana, da posição 24 e do máximo ordenados por `domInteractive − startTime`, além das distribuições independentes por estágio. Se faltarem parent IDs ou timestamps suficientes para reconstruir os intervalos, G2 falha em vez de preencher o residual por suposição.

## Gates de decisão

### G1 — mecanismo vivo

**Go:** 25/25 requests válidas têm `resolve_count=1`, request ID único gerado pelo servidor, mesmo release/tenant e trace completo; os 2 warmups estão marcados e excluídos dos agregados. **No-go:** correlação ausente, ID inbound reutilizado, duplicação de `resolveAuth()`, mistura de releases/tenants ou reposição silenciosa de uma amostra falha.

### G2 — decomposição suficiente

**Go:** cada uma das 25 amostras tem um root `BaseServer.handleRequest`, `start response`, `auth.resolve`, seus filhos esperados, `supabase_token_count=5` e intervalos suficientes para reconstruir sobreposição/caminho crítico; a rota possui `AppRender.getBodyResult` e o scan do artefato encontra zero URL bruta ou identificador proibido. **No-go:** falta qualquer sinal obrigatório, um filho cai fora do root, o contador diverge da contagem de spans ou “auth total” continua como caixa-preta.

### G3 — causa da cauda

**Go:** o excesso da amostra de cauda sobre a mediana aparece em intervalo pertencente ao caminho crítico e coincide com o sinal de estágio/máquina/recurso na mesma amostra; a relação se repete em outra amostra ou numa série controlada separada. **No-go:** associação apenas temporal, soma de spans concorrentes, uma ocorrência isolada ou hipótese sem sinal de estágio. Se esse critério não fechar, o resultado correto é “causa não identificada”.

### G4 — otimização

Qualquer mudança vem em PR separado, com uma hipótese por vez. Possíveis decisões depois dos dados incluem reduzir chamadas repetidas a `getToken({ template: "supabase" })`, substituir `currentUser()` por claims de um token suportado ou remover lookup redundante de mapping. Nenhuma delas é autorizada por este RFC antes da medição.

### G5 — alvo

SC-001/RC-006 passa somente se o p95 nearest-rank de `domInteractive − startTime` ficar ≤ 300 ms; TTFB é publicado em paralelo, mas não substitui o gate de utilizabilidade. Se o p95 ficar acima, o relatório descreve o gap e a fronteira técnica. Alterar o número ou a métrica exige autorização explícita; não se reclassifica a série nem se exclui cauda para tornar o gate verde.

## Artefato de publicação

O comentário final da #431 deve conter:

1. commit, release, data/hora, tenant Clerk live e região, sem secrets;
2. protocolo e N;
3. tabela baseline vs pós-#348 com TTFB e `domInteractive − startTime` separados;
4. contagem real de `resolveAuth()` e `getToken()` por request;
5. decomposição p50/p95 por estágio sem somar intervalos concorrentes;
6. waterfall de mediana, posição 24 e máximo ordenados pela métrica de utilizabilidade;
7. correlação das caudas com Machine/CPU/throttle;
8. conclusão sobre a causa e PR de otimização, se houver;
9. decisão explícita sobre SC-001/RC-006, sem alteração implícita.

Até esse artefato existir, a #431 permanece aberta.

## Fontes oficiais consultadas

- Next.js, [`headers()`](https://nextjs.org/docs/app/api-reference/functions/headers): headers de request em Server Components são read-only.
- Next.js, [Backend for Frontend — working with headers](https://nextjs.org/docs/app/guides/backend-for-frontend#working-with-headers): distinção entre upstream request headers e response headers no Proxy/Route Handlers.
- Next.js, [`after()`](https://nextjs.org/docs/app/api-reference/functions/after): callback executado depois de a resposta terminar e limites em Server Components.
- Next.js, [OpenTelemetry](https://nextjs.org/docs/pages/guides/open-telemetry): spans padrão de root request, App Router render e `start response`.
- Next.js, [`instrumentation.ts`](https://nextjs.org/docs/pages/api-reference/file-conventions/instrumentation): ponto estável de registro de observabilidade no boot.
- OpenTelemetry, [log correlation](https://opentelemetry.io/docs/specs/otel/logs/#log-correlation) e [cardinalidade de métricas](https://opentelemetry.io/docs/concepts/signals/metrics/#cardinality-limits): correlação nativa por trace/span ID e proibição prática de IDs por request como dimensão métrica.
- Clerk, [JWT templates](https://clerk.com/docs/guides/sessions/jwt-templates): geração, claims e possível latência adicional de tokens customizados.
- Supabase, [Clerk third-party auth](https://supabase.com/docs/guides/auth/third-party/clerk): caminho recomendado por session token e depreciação do template legado.
- Fly.io, [Machine runtime environment](https://fly.io/docs/machines/runtime-environment/): `FLY_MACHINE_ID`, `FLY_MACHINE_VERSION`, `FLY_REGION` e `FLY_IMAGE_REF`.
- Fly.io, [Metrics](https://fly.io/docs/monitoring/metrics/) e [CPU performance](https://fly.io/docs/machines/cpu-performance/): CPU balance, throttle, load e memória para correlacionar cauda.
