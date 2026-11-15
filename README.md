# dataframeitGUI

Plataforma web para análise de conteúdo com IA, baseada na lib dataframeit.

## Funcionalidades

- **Coordenadores:** definem perguntas via Pydantic, atribuem documentos, configuram e rodam LLM
- **Pesquisadores:** codificam documentos respondendo perguntas, revisam divergencias
- **Comparacao automatica:** quando N+ respostas existem para um documento, divergencias sao identificadas
- **Classificacao LLM:** usa `dataframeit` para classificar documentos automaticamente
- **Exportacao:** CSV e Markdown

## Arquitetura

- **Next.js 16** (App Router) — frontend + Server Actions
- **Supabase** — Postgres + Row Level Security (autenticacao via Clerk, nao o Auth nativo)
- **FastAPI** — backend leve para LLM e validacao Pydantic

## Instalacao

### Frontend

Requer Node.js 24.10 ou mais recente.

```bash
npm --prefix frontend install
cp frontend/.env.local.example frontend/.env.local
# Preencha frontend/.env.local sem versionar credenciais.
npm --prefix frontend run dev
```

### Provisionamento de worktrees

Os arquivos de ambiente vivem num diretório **fonte canônico**, fora de qualquer checkout ou worktree:

```
~/.config/dataframeitGUI/frontend/{.env.local,.env.e2e}
```

Crie-o uma única vez, a partir dos `.example`, e preencha com os valores reais. Para manter os segredos noutro lugar, aponte `DATAFRAMEITGUI_ENV_HOME` para o diretório desejado.

A partir daí **não há passo manual**: o hook de `post-checkout` (instalado por `pre-commit install`, junto dos demais) roda o bootstrap a cada `git worktree add` e `git checkout`, e a worktree nova já nasce com os symlinks ligados. Para provisionar ou reparar à mão:

```bash
./frontend/scripts/worktree-env/bootstrap.sh                    # fonte canônica
./frontend/scripts/worktree-env/bootstrap.sh --source /outro/frontend
```

O bootstrap valida as atribuições não comentadas de `.env.local.example` e `.env.e2e.example`, cria os symlinks e falha antes de alterar a worktree se a fonte estiver incompleta. É **idempotente e reparador**: link já correto é no-op, link quebrado ou apontando para outra fonte é refeito, e arquivo real no destino faz o script recusar — nunca sobrescreve conteúdo, que pode ser a única cópia de um segredo. Ele não copia credenciais e não descobre checkouts pelo layout dos diretórios.

A fonte é canônica justamente porque worktree é efêmera: apontar o link de uma worktree para outra faz `git worktree remove` quebrar o ambiente de quem apontava para ela — e o sintoma aparece longe da causa, como "faltando N variáveis" no gate de pre-push. Quando isso acontece, a mensagem do gate agora nomeia o link pendente e o alvo morto.

Nunca adicione `.env.local`, `.env.e2e` ou seus symlinks ao Git. Somente os arquivos `.example`, mantidos sem valores reais, são versionados.

### Backend

```bash
cd backend
uv sync
cp .env.example .env  # configurar SUPABASE_URL e SUPABASE_SERVICE_KEY
uv run uvicorn main:app --reload
```

### Supabase Local

```bash
cd frontend
npx supabase start
npx supabase db push
```

## Secret scanning

O repositório roda [gitleaks](https://github.com/gitleaks/gitleaks) em dois pontos: no CI (`.github/workflows/secret-scan.yml`, em todo PR e em push para `main`) e como hook de pre-commit local. Para habilitar o hook (uma vez por checkout):

```bash
pipx install pre-commit   # ou: uv tool install pre-commit
pre-commit install
```

A partir daí, cada commit é varrido em busca de segredos antes de entrarem no histórico.

## Deploy (Produção)

Produção roda inteiramente no **Fly.io** (`gru`), com deploy **automático por CI** a partir de merge na `main`: `backend/**` dispara `fly-deploy.yml` (app `gui-analise-sistematica-api`) e `frontend/**` dispara `frontend-fly-deploy.yml` (app `gui-analise-sistematica-frontend`). Domínio: `dataframeit.com.br`.

A imagem do backend instala o grafo de produção com `uv sync --locked --no-dev`; `backend/pyproject.toml` e `backend/uv.lock` são as únicas fontes das dependências e versões implantadas.

Se um deploy falhar, o workflow abre um incidente atribuído ao owner com a aplicação, o commit e o link da execução; novas falhas da mesma aplicação são adicionadas ao incidente aberto. Depois de confirmar a recuperação de produção, feche a issue para que uma falha futura abra outro incidente. Deploy verde não gera ruído.

A reconciliação da auto-revisão tem uma ordem de rollout deliberada: configurar o mesmo `AUTO_REVIEW_RECONCILIATION_SECRET` nos dois apps, aplicar as migrations, implantar o frontend e, por fim, implantar o backend. O backend verifica a RPC de capability no startup e não substitui a versão anterior se o contrato do banco ainda não existir.

### 1. Supabase Cloud

1. Criar projeto em [supabase.com](https://supabase.com)
2. Antes do deploy da aplicação, revisar `npx supabase db push --dry-run` e aplicar manualmente apenas as migrations esperadas de `frontend/supabase/migrations/` (`npx supabase db push`); não usar `--include-all` para incorporar migrations retroativas
3. Auth é via **Clerk** (não o Auth nativo do Supabase); o RLS valida o JWT do Clerk
4. Anotar: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`

### 2. Backend (Fly.io — `gui-analise-sistematica-api`)

Config em `backend/fly.toml`. Secrets de runtime via `fly secrets set` (nunca no toml):

```bash
cd backend
fly secrets set SUPABASE_URL=https://xxx.supabase.co \
  SUPABASE_SERVICE_KEY=your-key \
  AUTO_REVIEW_RECONCILIATION_SECRET=the-same-long-random-secret \
  -a gui-analise-sistematica-api
# CORS_ORIGINS, CLERK_JWKS_URL e CLERK_JWT_ISSUER ficam em [env] no fly.toml:
# nenhum é secret (o JWKS é endpoint público, o issuer é a URL da Frontend API),
# e mantê-los no toml faz da troca de instância Clerk um diff revisável.
fly deploy -c fly.toml --ha=false -a gui-analise-sistematica-api   # fallback; o normal é via CI
```

`CLERK_JWKS_URL` já existiu como secret deste app. Enquanto o secret existir, ele **sombreia o `[env]` homônimo** do `fly.toml` — o valor versionado é ignorado em silêncio (o mesmo já aconteceu aqui com `CORS_ORIGINS`). Depois do primeiro deploy que traz a variável para o `[env]`, remover o secret:

```bash
fly secrets unset CLERK_JWKS_URL -a gui-analise-sistematica-api
```

Enquanto os dois valores forem idênticos a ordem deploy → unset não tem downtime; a inversa teria. O risco de deixar o secret para trás aparece na *próxima* troca de instância Clerk: o `fly.toml` apontaria para o JWKS novo, o secret continuaria servindo o antigo, e o par JWKS/issuer divergiria — exatamente o modo de falha que a validação de `iss` existe para tornar diagnosticável.

Verificar: `curl https://gui-analise-sistematica-api.fly.dev/health`

O backend opera com exatamente uma Machine `shared-cpu-1x` de 512 MB, sempre ligada (`auto_stop_machines = "off"`). Com `stop` o cold start estourava o proxy, e com `suspend` a Machine retomada voltava com o relógio errado; o motivo está em `backend/fly.toml` e `frontend/fly.toml`, e os contratos do deploy reprovam qualquer uma delas. O `/health` informa `active_jobs` e `server_time`, o relógio da Machine, que o vigia agendado compara com o do runner. O workflow constrói e publica a imagem primeiro e só então espera as runs em curso terminarem (lê `active_jobs` no `/health`), para que a troca da Machine venha logo depois da espera, sem a janela do build; recusa deploy quando encontra mais de uma Machine e valida cardinalidade, região, tamanho e health depois da atualização; reduções remotas continuam sendo uma operação explícita, fora do deploy automático.

### 3. Frontend (Fly.io — `gui-analise-sistematica-frontend`)

Config em `frontend/fly.toml`. As `NEXT_PUBLIC_*` ficam em `[build.args]` (embutidas no bundle em build time, todas públicas por design); os secrets de runtime (`CLERK_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_WEBHOOK_SECRET`, `AUTO_REVIEW_RECONCILIATION_SECRET`) via `fly secrets set`:

```bash
cd frontend
fly secrets set CLERK_SECRET_KEY=sk_... \
  SUPABASE_SERVICE_ROLE_KEY=your-key \
  CLERK_WEBHOOK_SECRET=whsec_... \
  AUTO_REVIEW_RECONCILIATION_SECRET=the-same-long-random-secret \
  -a gui-analise-sistematica-frontend
# Fallback; o normal é via CI. Sem o SHA e a chave, o build falha (ver
# "Chave das Server Actions" abaixo, inclusive sobre qual chave usar aqui).
fly deploy -c fly.toml --remote-only -a gui-analise-sistematica-frontend \
  --build-arg NEXT_DEPLOYMENT_ID="$(git rev-parse HEAD)" \
  --build-secret NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:?defina a chave antes}"
fly scale count 2 --region gru -a gui-analise-sistematica-frontend   # só se o fallback rodar com menos de duas
```

O endpoint de webhook do Clerk em produção é `https://dataframeit.com.br/api/webhooks/clerk`. Ele deve assinar e entregar `user.created`, `user.updated` e `user.deleted`; o signing secret correspondente fica em `CLERK_WEBHOOK_SECRET`. Ao ativar uma rota nova de reconciliação, configure esses três eventos somente depois que o frontend compatível estiver no ar e confirme uma entrega `2xx` de cada tipo — uma rota antiga pode responder `2xx` sem processar eventos que ainda não conhece.

Mudanças que dependem de RPCs, constraints ou colunas novas seguem ordem estrita: backup e preflight, reparo de dados incompatíveis, migrations, verificação de pós-condições, deploy do frontend do mesmo SHA e smokes autenticados. Depois que o schema novo recebe escritas, o rollback suportado é roll-forward; não edite uma migration já registrada.

O frontend opera com duas Machines `shared-cpu-1x` de 1 GB, sempre ligadas. Em 2026-08-10, com `stop`, o host de `gru` ficou sem CPU livre, a Machine parada não conseguiu voltar e o site ficou fora do ar até ser recriada à mão em outro host. Em 2026-11-03, com `suspend`, uma Machine voltou da pausa com o relógio quase 11 h atrás, o Clerk recusou as sessões e página e documento deixaram de carregar. O workflow converge a topologia com `flyctl scale count 2` depois do preflight, recusa mais de duas Machines antes do deploy e valida cardinalidade, região, tamanho, autostop desligado e health **de cada uma** depois da atualização.

Para a Machine que mesmo assim não volte, o vigia agendado (`.github/workflows/fly-vigia.yml`) olha as duas apps a cada 15 minutos e, uma vez por hora, chama o health e confere o relógio de cada Machine iniciada; relógio a mais de 30 s do runner falha o job, sem recriar nada. Machine em estado `failed`, em crash loop ou que, com a sonda vermelha, recusa o start por falta de capacidade no host é clonada em `gru` (o scheduler escolhe outro host) e a original destruída; o job falha de propósito para gerar notificação. Start que falha por outro motivo (erro da API, lease ocupado) não recria nada: o job só falha e avisa.

A separação entre hosts é *best-effort* do scheduler do Fly e não é verificável pela CLI (nem `machine list --json` nem `machine status` expõem o host), então o contrato automatizado cobre a cardinalidade e a saúde, não a anti-afinidade. As duas Machines seguem em `gru`: isto não protege contra queda de região.

#### Chave das Server Actions (`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`)

É um secret do **repositório no GitHub** (`Settings → Secrets and variables → Actions`), não do Fly. O `frontend-fly-deploy.yml` o entrega ao build como BuildKit secret (`--build-secret`). O Next usa a chave como sal dos IDs das Server Actions e a grava no manifesto server-only da imagem, então quem lê a imagem lê a chave. Como o valor é o mesmo de um build para o outro, os IDs também são, e uma aba aberta durante um deploy continua salvando (#511).

O build **falha** se o secret estiver ausente (`required=true`) ou vazio (`test -s`) no `frontend/Dockerfile`. Isso é proposital e não é defeito do pipeline: com a chave vazia, o Next voltaria a sortear uma por build, os IDs voltariam a mudar a cada deploy e o deploy passaria verde. O GitHub não deixa ler o valor de volta, por isso o fallback manual acima só preserva os IDs com a chave guardada em outro lugar. Com outra chave, o fallback é uma rotação, com o efeito descrito abaixo; grave a mesma chave no secret do GitHub, ou o próximo deploy do CI troca de novo.

**Efeito de trocar a chave.** Todos os IDs mudam de uma vez, então o deploy seguinte produz o mesmo descompasso que o #511 corrigiu, agora de forma planejada. Em toda aba aberta antes do deploy, cada chamada de Server Action falha até a página ser recarregada: o servidor responde `Failed to find Server Action` (aparece nos logs do Fly), e a codificação mostra o aviso de que não salvou. O aviso sugere tentar de novo sem recarregar, o que vale para um deploy comum, mas aqui nenhuma nova tentativa funciona nessa aba. As respostas não salvas ficam no rascunho local do navegador (#608) e voltam a ser oferecidas depois de recarregar. Isso acontece uma única vez por aba, e os deploys seguintes com a chave nova voltam a preservar os IDs.

Rotacione quando a chave puder ter vazado, e não por rotina. Hoje ela só serve de sal, porque nenhuma Server Action do app captura variáveis de componente (todas vêm de módulos `"use server"` em `frontend/src/actions/`). Se uma passar a capturar, a chave também cifra essas variáveis.

**Como rotacionar:**

1. Escolha uma janela de baixo uso e avise quem estiver codificando para salvar antes do deploy e recarregar a página depois dele.
2. Gere uma chave AES-256 em base64 (32 bytes, o mesmo formato que o Next gera sozinho) e confira o tamanho, que deve sair `32`. O Next não valida o formato no build, só ao usar a chave:

   ```bash
   KEY="$(openssl rand -base64 32)"
   printf %s "$KEY" | base64 -d | wc -c
   ```

3. Anote o ID atual de uma Server Action pública, para comparar depois. A página de login carrega uma, a `invalidateCacheAction` do Clerk:

   ```bash
   SITE=https://dataframeit.com.br
   curl -fsS "$SITE/auth/login" | grep -oE '/_next/static/chunks/[^"?]+\.js' | sort -u \
     | while read -r c; do curl -fsS "$SITE$c"; done \
     | grep -oE 'createServerReference\)\("[0-9a-f]{42}"' | sort -u
   ```

4. Se quiser poder usar o fallback manual sem rotacionar de novo, guarde a chave também em outro lugar. Depois atualize o secret em `Settings → Secrets and variables → Actions → NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (ou `printf %s "$KEY" | gh secret set NEXT_SERVER_ACTIONS_ENCRYPTION_KEY --repo bdcdo/dataframeitGUI`) e faça o deploy logo em seguida, a partir de um commit **ainda não implantado**: o próximo merge que toque `frontend/**`, ou `Run workflow` depois de um commit novo na `main`. Um re-run, ou `Run workflow` sobre o commit já implantado, pode reaproveitar do cache do builder a camada do `npm run build` feita com a chave antiga. O valor do secret não entra na chave de cache do BuildKit ([doc do Docker](https://docs.docker.com/build/cache/invalidation/)), enquanto o SHA, que entra como `NEXT_DEPLOYMENT_ID`, entra.
5. Com o deploy verde, rode de novo o comando do passo 3. Se o ID mudou, o build usou a chave nova. Se o ID continua igual, o build veio do cache com a chave antiga (passo 4) e o deploy precisa ser refeito. Fora a chave, o ID só muda se o próprio módulo da action mudar, por exemplo numa atualização do `@clerk/nextjs` que mova ou renomeie a action. Portanto evite rotacionar no mesmo deploy de uma atualização do Clerk.

### Variáveis de ambiente

| Variável | Onde | Descrição |
|----------|------|-----------|
| `SUPABASE_URL` | Backend (Fly.io) | URL do projeto Supabase |
| `SUPABASE_SERVICE_KEY` | Backend (Fly.io) | Service role key |
| `CLERK_JWKS_URL` | Backend (`fly.toml [env]`) | URL do JWKS do Clerk (verificação RS256 do JWT) |
| `CLERK_JWT_ISSUER` | Backend (`fly.toml [env]`) | Frontend API URL da instância Clerk; identifica o tenant. Obrigatório com `CLERK_JWKS_URL` — sem ele o backend não sobe |
| `CORS_ORIGINS` | Backend (`fly.toml [env]`) | JSON array de origens permitidas |
| `NEXT_PUBLIC_SUPABASE_URL` | Frontend (`fly.toml [build.args]`) | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Frontend (`fly.toml [build.args]`) | Anon/publishable key |
| `NEXT_PUBLIC_API_URL` | Frontend (`fly.toml [build.args]`) | URL do backend no Fly.io |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Frontend (`fly.toml [build.args]`) | Publishable key do Clerk |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | Frontend (secret do GitHub Actions, entregue ao build) | Chave AES-256 em base64, estável entre builds; sal dos IDs das Server Actions. Rotação em "Chave das Server Actions" |
| `CLERK_SECRET_KEY` | Frontend (Fly secret) | Secret key do Clerk |
| `SUPABASE_SERVICE_ROLE_KEY` | Frontend (Fly secret) | Service role (server actions) |
| `CLERK_WEBHOOK_SECRET` | Frontend (Fly secret) | Signing secret do webhook do Clerk |
| `AUTO_REVIEW_RECONCILIATION_SECRET` | Backend e frontend (Fly secret) | Segredo dedicado, idêntico nos dois apps, para o wakeup HTTP da outbox |
| `LLM_RATE_LIMIT_REQUESTS` | Backend (`fly.toml [env]`) | Máximo compartilhado de disparos LLM por usuário efetivo e projeto em cada janela (default: `5`) |
| `LLM_RATE_LIMIT_WINDOW_SECONDS` | Backend (`fly.toml [env]`) | Duração da janela atômica no Postgres, em segundos (default: `60`) |

## Estrutura do Projeto

```
frontend/     # Next.js 16 + shadcn/ui + Tailwind v4
backend/      # FastAPI + dataframeit
docs/         # Especificacoes tecnicas
```
