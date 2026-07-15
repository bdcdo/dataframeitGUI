# Runbook proposto: cutover do Clerk para produção

> Status: proposta operacional da issue #348. Este documento não registra que o cutover ocorreu. Todas as etapas marcadas como mutação exigem uma janela coordenada, um operador humano e confirmação explícita. A PR que introduz este runbook usa `Refs #348`, porque domínio, credenciais, usuários e serviços remotos continuam inalterados.

## Resultado esperado

O frontend em `https://dataframeit.com.br` passa a usar uma instância Clerk de produção, o backend valida o token emitido por essa mesma instância, o Supabase mantém o isolamento por `supabase_uid`, os usuários existentes conseguem se autenticar novamente e existe um caminho testado para voltar à instância de desenvolvimento se qualquer invariante falhar.

O cutover não transfere sessões, senhas ou identidades OAuth entre instâncias. A documentação do Clerk afirma que dados de usuários não são transferidos entre instâncias; portanto, os usuários serão recriados na instância live e precisarão se autenticar outra vez. A Backend API aceita importar um `passwordDigest` quando a origem fornece o hash em formato suportado, mas o objeto de usuário lido da instância Clerk dev não expõe esse digest; este runbook não possui nem autoriza uma fonte alternativa de senha. Contas sociais também não podem receber `externalAccounts` em `createUser()`, e sessões pertencem à arquitetura da instância emissora. A forma da nova autenticação precisa ser decidida antes da janela.

## O que o repositório garante hoje

| Superfície | Contrato observado na `main` | Consequência para o cutover |
|---|---|---|
| `frontend/fly.toml` | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` ainda contém uma chave `pk_test_`; por ser `NEXT_PUBLIC_*`, o valor é incorporado no build | trocar apenas o secret de runtime não muda o tenant usado pelo navegador; é obrigatório gerar uma nova imagem do frontend |
| `frontend/src/lib/auth.ts` | `resolveAuth()` chama `currentUser()`, prefere `publicMetadata.supabase_uid`, consulta `clerk_user_mapping` e faz o master-check | cada usuário live precisa receber o mesmo UUID Supabase em `publicMetadata.supabase_uid`; mapping ausente ainda funciona quando a metadata está correta |
| `frontend/src/lib/supabase/server.ts`, `frontend/src/lib/api.ts` e `frontend/src/lib/api-server.ts` | todos pedem `getToken({ template: "supabase" })` | o template chamado exatamente `supabase` precisa existir no tenant live antes do deploy |
| `frontend/src/app/api/webhooks/clerk/route.ts` | verifica `CLERK_WEBHOOK_SECRET`, aceita `user.created` e chama `syncClerkUserToSupabase()` | o endpoint live precisa usar seu próprio signing secret; um evento de exemplo cria ou vincula dados e não é um smoke read-only |
| `frontend/src/lib/clerk-sync.ts` | a sincronização encontra profile por e-mail, reassocia mapping legado e grava `supabase_uid` na metadata | e-mail é parte do pareamento, mas não substitui um manifesto canônico nem resolve duplicidades silenciosamente |
| `backend/config.py` e `backend/services/auth.py` | existe um único `CLERK_JWKS_URL` e um único `CLERK_JWT_ISSUER`; quando JWKS está configurado, somente RS256 é aceito | não há janela de dupla aceitação dev/live; os dois apps Fly precisam ser promovidos na mesma manutenção |
| `frontend/scripts/` | `sync-existing-users-to-clerk.ts` não existe mais | não há comando versionado que possa ser “rerodado” |

O script histórico `frontend/scripts/sync-existing-users-to-clerk.ts` foi removido no commit `f5ff0d4` como migração one-off já executada. Mesmo recuperado do histórico, ele não serve para este cutover: primeiro consulta `clerk_user_mapping` por UUID Supabase e pula qualquer profile já mapeado, exatamente o estado esperado dos 21 usuários atuais; além disso, cria usuário sem senha e não transfere sessão, senha ou identidade OAuth. Recuperar e executar esse arquivo é um bloqueio de segurança, não um atalho.

## Decisões de desenho

### Preservar o contrato do token durante o cutover

Este runbook separa a mudança de tenant da futura modernização Clerk↔Supabase. O código atual depende de um JWT template customizado, embora a integração por JWT templates tenha sido descontinuada pelo Supabase em 1º de abril de 2025 e tenha suporte limitado. A integração recomendada atualmente usa o session token do Clerk, com claim `role=authenticated`, e Third-Party Auth.

Misturar essas duas migrações ampliaria o número de variáveis durante uma troca de identidade. A janela da #348 deve reproduzir no tenant live o contrato que o código consome — template `supabase`, RS256, `aud=authenticated`, `role=authenticated` e `supabase_uid` derivado de `{{user.public_metadata.supabase_uid}}` — e validar que o Supabase aceita o token live antes de receber tráfego. Uma issue separada deve migrar o cliente, o backend e as policies para o session token recomendado; até lá, o risco de depreciação fica explícito.

### Recriar identidades, sem prometer continuidade de credenciais

A fonte canônica da identidade interna é o UUID em `profiles.id`, não o ID Clerk da instância dev. A recriação live deve usar esse UUID em `externalId` e `publicMetadata.supabase_uid`, com e-mail normalizado apenas como chave de conferência. O operador deve falhar se UUID e e-mail apontarem para usuários live diferentes.

`skipPasswordRequirement: true` só é permitido pelo Clerk quando senha não é o único método de login. Se a instância live for password-only, a importação sem senha é tecnicamente inválida; a janela fica em no-go até existir uma estratégia aprovada de definição ou reset individual de senha. Nenhum operador deve inventar senha temporária compartilhada ou alegar migração de digest que não possa ser obtido legitimamente da origem.

### Não depender do webhook para migrar os 21 usuários

Os usuários live são preparados antes do endpoint live assumir produção, de modo que o evento `user.created` não é um mecanismo confiável para preencher `clerk_user_mapping`. O manifesto deve carregar os 21 pares `live_clerk_user_id → supabase_user_id`, e a substituição dos mappings deve ocorrer em transação própria depois do smoke inicial. O webhook fica responsável por signups futuros.

## Papéis e canal operacional

| Papel | Responsabilidade |
|---|---|
| comandante da janela | declara go/no-go, registra horários e decide rollback |
| operador Clerk/DNS/OAuth | cria a instância live, aplica somente os registros emitidos pelo Clerk e configura provedores/webhook/template |
| operador Fly | preserva os valores antigos fora do Fly, prepara os novos secrets e promove/retrocede as imagens |
| operador Supabase | inventaria a integração, valida o token e substitui mappings dentro de transação |
| validador funcional | executa os smokes com papéis distintos sem participar das mutações |

O registro da janela contém somente totais, digests, IDs de release e resultados booleanos. E-mail, UUID de usuário, ID Clerk, JWT, cookies, `sk_*`, `whsec_*`, tokens Supabase, credenciais OAuth e conteúdo de respostas ficam fora do ticket, PR, chat e logs compartilhados. O manifesto temporário deve viver fora do repositório, com permissão `0600`, em volume criptografado, e ser destruído após o encerramento do prazo de rollback.

## Fase 0 — preflight sem mutação nos serviços

Nenhum item desta fase cria ou altera instância, usuário, DNS, integração, secret ou release. `git fetch` atualiza apenas referências locais; as consultas aos serviços são read-only.

### 0.1. Congelar o artefato e registrar versões

```bash
git fetch origin main
git rev-parse origin/main
clerk --version
fly version
supabase --version
```

**Go:** o commit candidato é conhecido, os CLIs respondem e o operador leu o help local dos comandos que usará. **No-go:** qualquer comando da janela difere do help instalado ou o checkout contém mudança não revisada.

### 0.2. Inventariar Clerk e DNS sem alterar estado

```bash
clerk deploy status --mode agent
dig +short CNAME clerk.dataframeit.com.br
dig +short TXT dataframeit.com.br
```

O comando `clerk deploy status --mode agent` é o snapshot read-only documentado pelo Clerk. Os nomes e valores DNS a criar vêm exclusivamente do Dashboard/CLI da instância live; não se copiam registros de exemplos nem se assume que CNAME, DKIM ou validação de certificado terão nomes fixos.

### 0.3. Inventariar Fly sem tentar ler secrets

```bash
fly status -a gui-analise-sistematica-frontend
fly status -a gui-analise-sistematica-api
fly checks list -a gui-analise-sistematica-frontend
fly checks list -a gui-analise-sistematica-api
fly config show -a gui-analise-sistematica-frontend
fly config show -a gui-analise-sistematica-api
fly secrets list -a gui-analise-sistematica-frontend
fly secrets list -a gui-analise-sistematica-api
fly releases --app gui-analise-sistematica-frontend --image
fly releases --app gui-analise-sistematica-api --image
```

`fly secrets list` mostra nome e digest, nunca o valor em texto claro. Antes de substituir qualquer secret, o operador precisa obter do cofre externo os valores dev que permitiriam rollback; o Fly não consegue devolvê-los depois. **No-go:** imagem anterior não identificada, health check vermelho, valor anterior indisponível no cofre ou secret obrigatório ausente.

### 0.4. Produzir o manifesto canônico dos usuários

No SQL Editor do Supabase, o operador executa primeiro apenas contagens e validações. A contagem histórica da issue é 21; ela é um valor esperado, não prova do estado atual.

```sql
select
  count(*) as mappings,
  count(distinct m.supabase_user_id) as distinct_profiles,
  count(distinct lower(p.email)) as distinct_emails,
  count(*) filter (where p.activated_at is not null) as active_mapped_profiles
from public.clerk_user_mapping m
join public.profiles p on p.id = m.supabase_user_id;

select count(*) as active_profiles
from public.profiles
where activated_at is not null;

select lower(email) as normalized_email, count(*)
from public.profiles
where email is not null
group by lower(email)
having count(*) > 1;

select m.supabase_user_id
from public.clerk_user_mapping m
left join public.profiles p on p.id = m.supabase_user_id
where p.id is null or p.email is null or p.activated_at is null;

select p.id
from public.profiles p
left join public.clerk_user_mapping m on m.supabase_user_id = p.id
where p.activated_at is not null and m.supabase_user_id is null;
```

**Go:** `mappings = distinct_profiles = distinct_emails = active_mapped_profiles = active_profiles = 21`, e as três consultas de anomalia retornam zero linhas. O número 21 é o gate histórico esperado e só se torna estado atual confirmado quando essas consultas forem executadas na janela; este documento não o trata como medição live já realizada. Profiles com `activated_at is null` são pré-registros ainda sem conta Clerk e ficam fora do lote. **No-go:** a cardinalidade mudou, existe e-mail ausente/duplicado, profile ativo sem mapping ou mapping para profile inativo. A discrepância precisa ser resolvida na origem antes de criar usuários live.

Em seguida, o operador exporta para o manifesto protegido somente o join dos 21 profiles ativos e mapeados: `profiles.id`, e-mail normalizado, nome e sobrenome necessários à recriação, e o ID Clerk dev atual. O arquivo nunca entra no Git.

### 0.5. Confirmar metadata dev e caminho de rollback

Usando a Backend API da instância dev em uma ferramenta temporária, o operador confere que cada um dos 21 usuários mapeados existe, que o e-mail primário coincide com o manifesto e que `publicMetadata.supabase_uid` coincide com `profiles.id`.

**Go:** 21/21 pares coerentes. **No-go:** qualquer usuário sem metadata correta. Essa metadata é o que permite que o frontend dev continue resolvendo a identidade se o mapping já tiver sido substituído ou se houver rollback.

### 0.6. Decidir o método de login live

Registrar quais estratégias estão habilitadas na instância dev e quais serão habilitadas na live. Em produção, o Clerk exige credenciais OAuth próprias para provedores sociais; as credenciais compartilhadas de desenvolvimento não são reaproveitáveis.

**Go:** há um método aprovado, as credenciais live necessárias estão disponíveis no cofre e o teste piloto está definido para a Fase 1. **No-go:** password-only com usuários sem password digest migrável; OAuth sem client ID/secret e redirect URI live; MFA/passkey obrigatório sem plano de reenrolamento; ou qualquer expectativa de preservar sessão dev.

### 0.7. Inventariar o contrato Clerk↔Supabase

O operador registra o estado atual de Third-Party Auth no Supabase, o issuer dev, o contrato do template atual e se a plataforma permite manter a configuração dev durante o período de rollback. A instância live ainda pode não existir neste ponto; discovery e JWKS live são gates posteriores, depois da criação e do DNS.

**Go:** o contrato dev está documentado sem copiar token e há um plano para coexistência ou substituição coordenada. **No-go:** não se sabe qual issuer/template o Supabase aceita hoje, o painel não permite manter os dois issuers e o tempo de reativação do dev não cabe na manutenção, ou o rollback dependeria de uma configuração que não foi registrada.

## Fase 1 — preparar a instância live sem tráfego

Tudo nesta fase é mutação remota. Ela só começa após o go formal da Fase 0.

### 1.1. Criar e configurar a instância de produção

O operador usa o Dashboard ou o fluxo interativo `clerk deploy`; `--mode agent` permanece reservado à leitura de status. Ao clonar a instância dev, o operador refaz explicitamente integrações, paths e conexões SSO, pois o Clerk informa que esses itens não são copiados por razões de segurança.

Configuração mínima a conferir:

1. domínio principal `dataframeit.com.br` e Frontend API no subdomínio emitido pelo Clerk, esperado como `clerk.dataframeit.com.br`;
2. lista de subdomínios autorizados restrita aos hosts efetivamente usados;
3. redirect URLs do login, callback e pós-login;
4. credenciais OAuth live próprias, quando aplicável;
5. template `supabase` com o contrato descrito acima;
6. chaves live separadas por consumidor, sem reutilizar uma única secret key em operação e migração.

O operador aplica no Registro.br somente os registros gerados para essa instância e volta a consultar `clerk deploy status --mode agent` até DNS, TLS e e-mail estarem prontos. A documentação do Clerk admite propagação de DNS de até 48 horas; a janela de tráfego não deve começar enquanto o status estiver incompleto.

Antes de criar o lote, testar o método live com uma conta piloto que não reutilize credencial de outro usuário. **No-go:** o piloto não conclui login/logout, OAuth retorna para outro host, ou a estratégia exige senha que o operador não pode migrar legitimamente.

Quando o status estiver pronto, validar os endpoints públicos sem token:

```bash
curl --fail --silent --show-error \
  https://clerk.dataframeit.com.br/.well-known/openid-configuration \
  -o /tmp/clerk-openid-configuration.json

curl --fail --silent --show-error \
  https://clerk.dataframeit.com.br/.well-known/jwks.json \
  -o /tmp/clerk-jwks.json
```

**Go:** o issuer do documento, seu `jwks_uri` e ao menos uma chave RS256 com `kid` são coerentes com a instância live. **No-go:** discovery/JWKS não responde ou aponta para outro tenant.

### 1.2. Preparar os 21 usuários live

A ferramenta temporária de migração fica fora do repositório e é dry-run por padrão. Ela deve implementar este contrato fail-closed:

1. recusar manifesto diferente de 21 linhas, e-mail duplicado, UUID inválido ou variável cujo prefixo não seja `sk_live_`;
2. buscar primeiro por `externalId = profiles.id` e depois por e-mail;
3. falhar se externalId e e-mail encontrarem usuários diferentes, ou se o e-mail já pertencer a uma identidade live sem o UUID esperado;
4. criar somente o ausente, com `externalId`, e-mail, nomes e `publicMetadata.supabase_uid`;
5. usar `skipPasswordRequirement` apenas se a estratégia live não for password-only;
6. reler cada usuário após a escrita e exigir igualdade de UUID, e-mail e metadata;
7. não alterar `clerk_user_mapping` nesta fase;
8. emitir somente totais `created`, `already_valid`, `conflict` e `error`, sem dados pessoais.

**Go:** 21/21 usuários live válidos e zero conflito/erro. **No-go:** qualquer criação parcial sem uma reconciliação completa. Não se prossegue supondo que o webhook reparará o lote.

### 1.3. Criar o webhook live depois da importação

Criar endpoint para `user.created` em `https://dataframeit.com.br/api/webhooks/clerk`, guardar o signing secret live no cofre e não enviar o evento de exemplo contra produção: o handler atual trata esse payload como usuário real e pode criar profile/mapping de teste.

O secret usado pelo código chama-se `CLERK_WEBHOOK_SECRET`, embora a documentação atual do Clerk recomende `CLERK_WEBHOOK_SIGNING_SECRET`. Renomear a variável é uma refatoração separada; na #348, o valor live precisa ser armazenado sob o nome que o código lê.

### 1.4. Adicionar a integração live no Supabase

Adicionar no Dashboard Supabase a integração Third-Party Auth com o issuer live validado na etapa 1.1. O session token da instância live precisa conter `role=authenticated`; o template customizado precisa continuar emitindo o contrato que o app usa. Não remover a configuração dev antes do fim do prazo de rollback, se a plataforma permitir coexistência. O Supabase informa que mudanças nas signing keys de provedores podem levar até 30 minutos para serem percebidas; sucesso no Dashboard não é o checkpoint, e a janela não começa enquanto o token piloto real não for aceito.

Antes do tráfego, obter um token de uma conta piloto live em ambiente controlado e verificar localmente, sem imprimi-lo, que `iss`, `aud`, `role`, `supabase_uid`, `exp` e o `kid` esperado estão presentes. Em seguida, executar uma leitura RLS mínima com o anon/publishable key e esse token. **Go:** somente dados permitidos ao piloto aparecem. **No-go:** token nulo, claim ausente, issuer/audience recusado ou leitura que vaze dados de outro usuário/projeto.

## Fase 2 — preparar rollback antes de promover

O operador registra as imagens atuais retornadas por `fly releases --image`, preserva os valores dev de `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, `CLERK_JWKS_URL` e `CLERK_JWT_ISSUER` no cofre, exporta o mapping dev para o manifesto protegido e confirma que o commit de rollback ainda pode ser construído.

Os secrets live podem ser staged no Fly com `--stage`, que não atualiza as Machines até um deploy posterior. O comando concreto deve ser montado pelo operador a partir do `fly secrets --help` instalado e receber valores por stdin ou por um canal que não os grave no histórico do shell. Não se cola secret na issue, no PR ou em terminal compartilhado.

**Go:** imagem e configuração antigas identificadas, secrets dev recuperáveis, snapshot do mapping completo e comando de rollback ensaiado sem executar. **No-go:** qualquer peça de rollback depende de recuperar plaintext do Fly depois da troca.

## Fase 3 — cutover coordenado

### Checkpoint C0 — abrir manutenção

Suspender novos cadastros e operações de LLM, registrar o horário e confirmar que não há job em andamento. O projeto não possui aceitação simultânea dos dois issuers no backend; por isso haverá um intervalo curto em que chamadas FastAPI do frontend dev serão rejeitadas.

### Checkpoint C1 — promover o backend

Aplicar ao app `gui-analise-sistematica-api` o JWKS e issuer live já validados, mantendo `CLERK_JWT_AUDIENCE=authenticated`, e promover o release. O health check `/health` precisa ficar verde antes de continuar.

Não usar o retorno verde do health check como prova de autenticação: ele verifica disponibilidade do processo, não um token live. Durante este intervalo, o frontend ainda emite token dev e as rotas autenticadas do backend podem responder 401/503; não executar trabalho pago.

### Checkpoint C2 — promover o frontend

Gerar a imagem a partir de um commit revisado que substitua o build arg por uma `pk_live_` correspondente à mesma instância, com `CLERK_SECRET_KEY` e `CLERK_WEBHOOK_SECRET` live staged. O `fly secrets set` sem `--stage` reinicia Machines; por isso staging e deploy devem fazer parte do mesmo checkpoint consciente.

O frontend usa deploy rolling com uma única Machine e pode ter um blip; não descrever essa configuração como blue-green ou zero downtime. Prosseguir somente quando `/api/health` estiver verde e `dataframeit.com.br` carregar o Clerk live.

### Checkpoint C3 — smoke de identidade e autorização

Executar em janela anônima, sem reutilizar cookie dev:

1. login e logout da conta piloto;
2. coordenador abre dashboard, projeto e configuração permitida;
3. pesquisador direto abre apenas sua fila;
4. usuário por e-mail vinculado resolve para o membro canônico;
5. master mantém o comportamento esperado;
6. usuário autenticado sem acesso recebe negação fechada, sem conteúdo do projeto;
7. token `supabase` existe e uma leitura RLS retorna somente o escopo autorizado;
8. uma chamada FastAPI read-only com token live é aceita; a mesma rota sem token é rejeitada;
9. logs não contêm JWT, e-mail, UUID ou secret.

**Go:** todos os papéis esperados passam e as negações também. **No-go:** dois erros consecutivos do mesmo fluxo após renovar a sessão, loop de login, token nulo, 401/503 autenticado, RLS vazando ou ocultando dados autorizados, ou diferença entre UUID da metadata e do profile.

### Checkpoint C4 — substituir mappings em transação

Somente depois do smoke, o operador carrega os 21 pares live do manifesto em uma tabela temporária dentro da mesma sessão SQL e executa uma transação que:

1. exige 21 linhas distintas por `clerk_user_id` e `supabase_user_id`;
2. exige que todo UUID exista em `profiles` e coincida com o snapshot;
3. remove apenas os mappings dev dos mesmos 21 UUIDs;
4. insere os mappings live;
5. reconta 21/21 e aborta em qualquer divergência.

O SQL final deve ser revisado com o manifesto real na janela; os identificadores não são versionados neste runbook. Não usar `upsert` isolado em loop: a unicidade de `supabase_user_id` exige substituição atômica, e falha no meio não pode deixar metade da base no tenant antigo.

### Checkpoint C5 — verificar webhook com identidade controlada

Não usar `Send Example`. Criar uma identidade sintética previamente aprovada no tenant live, deixar o webhook `user.created` completar o vínculo, conferir que a entrega recebeu 2xx e que profile, metadata e mapping são coerentes, e então remover todos os artefatos sintéticos segundo um roteiro de limpeza revisado. Se a política não autorizar conta sintética em produção, o webhook fica como pendência explícita e a issue não é fechada.

### Checkpoint C6 — encerrar manutenção

Repetir o smoke curto, confirmar health checks, registrar somente totais e releases, reabrir tráfego e iniciar a observação. A medição da #431 começa apenas depois de o tenant live estar estável; ela não é substituída pelo smoke funcional.

## Rollback

### Gatilhos

Rollback imediato se qualquer papel legítimo não autenticar, se o template `supabase` não for emitido, se backend e Supabase discordarem de issuer/audience, se RLS falhar aberta ou fechada para o cenário esperado, se o mapping ficar parcial, se webhook criar identidade divergente ou se secrets aparecerem em logs.

### Ordem

1. reabrir a manutenção e interromper operações de LLM;
2. restaurar os secrets dev do frontend e promover a imagem anterior, que já contém a `pk_test_` anterior;
3. restaurar `CLERK_JWKS_URL` e `CLERK_JWT_ISSUER` dev no backend e promover sua imagem anterior;
4. restaurar a integração Supabase dev somente se ela tiver sido removida ou substituída, mantendo a manutenção enquanto a aceitação de um token dev real não voltar; a atualização de chaves do provedor pode levar até 30 minutos e impede prometer rollback instantâneo nesse cenário;
5. restaurar, em uma transação, o snapshot dos 21 mappings dev;
6. repetir login, RLS e FastAPI com o tenant dev;
7. manter a instância live, DNS e artefatos de diagnóstico intactos até a análise; não apagar a única evidência no meio do incidente.

Um rollback de imagem não restaura secret nem configuração Supabase por si só. Um rollback de tenant também encerra sessões live e exige novo login no tenant dev.

## Evidência de conclusão

A #348 só pode ser fechada quando houver, sem dados pessoais ou secrets:

- `clerk deploy status --mode agent` completo para domínio, DNS, TLS e OAuth;
- releases exatos de frontend e backend e health checks verdes;
- contagem 21/21 de usuários live, metadata e mappings, com zero conflito;
- smoke dos cinco cenários de autorização;
- token RS256 live aceito pelo backend e pelo Supabase, com RLS preservada;
- entrega real de webhook 2xx e limpeza da identidade sintética;
- rollback ensaiado e valores dev ainda disponíveis durante o prazo acordado;
- #431 desbloqueada para nova medição N=25 + 2 warmups, sem alterar SC-001/RC-006 antes dos dados.

## Fontes oficiais consultadas

- Clerk, [Deploy your Clerk app to production](https://clerk.com/docs/guides/development/deployment/production): instância live, chaves, OAuth próprio, webhook, DNS, subdomínios e certificados.
- Clerk, [Instances / Environments](https://clerk.com/docs/guides/development/managing-environments): dados não são transferidos entre instâncias e a arquitetura de sessão muda entre dev e produção.
- Clerk, [`createUser()`](https://clerk.com/docs/reference/backend/user/create-user): `externalId`, metadata, password digest e restrição de `skipPasswordRequirement` em password-only.
- Clerk, [`getUserList()`](https://clerk.com/docs/reference/backend/user/get-user-list) e [Backend User](https://clerk.com/docs/reference/backend/types/backend-user): busca exata por `externalId`/e-mail e ausência de digest de senha no objeto exportável.
- Clerk, [JWT templates](https://clerk.com/docs/guides/sessions/jwt-templates): claims, shortcodes, default issuer/exp/sub e custo adicional de geração do template.
- Clerk, [CLI](https://clerk.com/docs/cli) e [clerk deploy](https://clerk.com/changelog/2026-06-10-clerk-deploy): fluxo interativo e status read-only `--mode agent`.
- Clerk, [Sync data with webhooks](https://clerk.com/docs/guides/development/webhooks/syncing): assinatura, retries, consistência eventual e endpoint de produção.
- Clerk, [Rotate API keys](https://clerk.com/docs/guides/secure/rotate-api-keys): chaves por consumidor e preservação da chave/endpoint antigo até verificação.
- Supabase, [Clerk third-party auth](https://supabase.com/docs/guides/auth/third-party/clerk): integração recomendada por session token, claim `role` e depreciação do caminho por JWT template.
- Supabase, [Third-party auth](https://supabase.com/docs/guides/auth/third-party/overview): issuer OIDC, assinatura assimétrica, `kid` e janela de atualização de chaves de até 30 minutos.
- Fly.io, [Secrets and Fly Apps](https://fly.io/docs/apps/secrets/): secrets não são legíveis em plaintext, `--stage` e reinício/deploy ao aplicar.
- Fly.io, [Deploy an app](https://fly.io/docs/launch/deploy/) e [Health checks](https://fly.io/docs/reference/health-checks/): estratégias, smoke checks e limites do sinal de saúde.
- Fly.io, [Rollback Guide](https://fly.io/docs/blueprints/rollback-guide/): inventário de releases/imagens e redeploy de uma imagem anterior.
