---
name: comentarios-relatorio
description: Gerar relatório .md dos comentários abertos de um projeto dataframeitGUI, organizado por pergunta Pydantic, e depois aplicar as decisões do usuário ao schema + marcar comentários como resolvidos. Use esta skill quando o usuário pedir "gerar relatório de comentários", "compilar comentários abertos", "revisar feedback do projeto", "aplicar decisões do relatório", "resolver comentários em lote", "revisar anotações de pesquisadores", "consolidar dúvidas", "processar sugestões de schema", ou mencionar explicitamente esta skill. Também acionar quando o usuário quiser iterar sobre o .md anotado para aplicar mudanças em massa no schema Pydantic de um projeto.
---

# Skill: comentarios-relatorio

Fluxo em dois passos para revisar e responder a comentários abertos de pesquisadores/LLM/coordenadores no dataframeitGUI. Organiza tudo por pergunta, faz dedup, e aplica em lote as decisões do usuário.

## Quando usar

- Usuário quer consolidar feedback antes de uma revisão de schema
- Muitos comentários abertos acumulados e precisa priorizar
- Após um batch de codificação, triar notas/dúvidas/ambiguidades
- Aplicar em lote decisões já tomadas offline (no .md)

**Não use** para:
- Criar um comentário novo (use a UI)
- Resolver um comentário específico avulso (use a UI ou server action direto)
- Refatorar schema do zero sem feedback existente (use a aba Schema)

## Pré-requisitos

1. Estar num repo com estrutura do dataframeitGUI
2. `frontend/.env.local` contendo `NEXT_PUBLIC_SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`
3. `frontend/node_modules` instalado (`cd frontend && npm install`)
4. Se estiver trabalhando em worktree: verificar se `.env.local` e `node_modules` existem — se não, criar symlinks para o main branch:
   ```bash
   cd frontend
   [ ! -e node_modules ] && ln -s ../../../frontend/node_modules node_modules
   [ ! -e .env.local ] && ln -s ../../../frontend/.env.local .env.local
   ```
   (Ajustar `../../../frontend` conforme profundidade do worktree.)

## Passo 1 — Gerar o relatório

### 1.1 Identificar o projeto

Se o usuário mencionou um nome:
```bash
cd frontend
npx tsx scripts/comentarios-relatorio/fetch-open-comments.ts --project-name "Zolgensma"
```

Se não: listar e perguntar via AskUserQuestion:
```bash
cd frontend
npx tsx scripts/comentarios-relatorio/fetch-open-comments.ts --list
```

Se preferir passar id direto:
```bash
npx tsx scripts/comentarios-relatorio/fetch-open-comments.ts --project-id <uuid>
```

### 1.2 Gerar o .md

O script `fetch-open-comments.ts` imprime JSON; em seguida, o script `generate-report.py` transforma esse JSON no .md final (fazendo agrupamento por campo, dedup por texto e inferência cruzada de notas gerais).

Pipeline padrão:

```bash
mkdir -p docs/comentarios
cd frontend
npx tsx scripts/comentarios-relatorio/fetch-open-comments.ts \
  --project-name "Zolgensma" > /tmp/comments.json
python3 scripts/comentarios-relatorio/generate-report.py \
  /tmp/comments.json ../docs/comentarios/Zolgensma-$(date +%Y%m%d).md
```

Estrutura do JSON produzido por `fetch-open-comments.ts`:
- `project`: `{ id, name, version }`
- `fields`: `PydanticField[]`
- `stats.bySource`: contagem por fonte
- `comments`: `OpenComment[]` com `id`, `source`, `rawId`, `fieldName`, `documentId`, `documentTitle`, `text`, `author`, `createdAt`, `extra`

O script Python faz automaticamente:
- Agrupa comentários por `fieldName` (seções na ordem dos `fields`)
- **Clusters por reviewId**: quando múltiplos pesquisadores contestam o mesmo veredito (`duvida` com mesmo `extra.reviewId`), ficam num único bloco de decisão junto com o review original (`rawId` igual ao `reviewId`) e anotações do mesmo documento
- **Dúvidas órfãs**: dúvidas cujo review não aparece nos abertos (já resolvido) viram um cluster próprio por `reviewId`
- Cria seção "Notas gerais" para `fieldName === "(geral)"` — cada nota/dificuldade vira um bloco
- Vereditos multi-select (JSON dict) são resumidos em "A, B, C e mais N" — não aparecem crus

### 1.3 Quando fugir do pipeline padrão

Use o pipeline padrão na maioria dos casos. Só pule o Python se o usuário pediu um formato diferente (ex: resumo executivo curto, priorização por urgência). Nesses casos, gere o .md diretamente a partir do JSON no fluxo conversacional.

### 1.4 Estrutura do .md (formato conversacional)

O parser (passo 2) identifica blocos pelo heading `###` e extrai os `rawId`s do comentário HTML `<!-- ids: ... -->` no rodapé do bloco. Headings são prosa livre — não há parsing por regex de id no título.

```markdown
# Comentários em aberto — {projectName}

Projeto `{projectId}` na versão do schema `{version}`. Gerado em {YYYY-MM-DD}.

Há **{N} comentários em aberto** — {M} perguntas com comentários específicos e {P} nota(s) geral(is). Por fonte: ...

Para cada bloco, preencha `Decisão:` dentro do comentário HTML (`<!-- ... -->`).

---

## `{fieldName}`

**Pergunta:** {description}
**Orientação aos pesquisadores:** {help_text} (se houver)
**Opções:** A · B · C (se houver)
**Subcampos:** key (label), ... (regra) (se houver)

### Review de **{reviewer}** em *{doc}* — contestado por {N} pesquisadores

Em {date}, **{reviewer}** revisou este documento e escolheu o veredito **"{verdict}"**, deixando a seguinte observação:

> {review comment}

{N} pesquisadores manifestaram dúvida sobre esse veredito:

- **{nome}** — {texto}
- **{nome}** — {texto}

Além disso, {N} anotações no mesmo documento:

- **{nome}** — {texto}

**Decisão:** <!-- aprovar | rejeitar | reformular | ignorar -->
**Mudança no schema:** <!-- descreva em português o que mudar, ou deixe vazio -->
**Nota ao resolver:** <!-- opcional -->

<!-- ids: review-<uuid>; duvida-<reviewId>-<resp1>; duvida-<reviewId>-<resp2>; anotacao-<uuid> -->

### Anotação de **{autor}** em *{doc}* ({date})

> {texto}

**Decisão:** <!-- aprovar | rejeitar | reformular | ignorar -->
**Mudança no schema:** <!-- ... -->
**Nota ao resolver:** <!-- ... -->

<!-- ids: anotacao-<uuid> -->

---

## Notas gerais

### Nota de pesquisador de **{autor}** ao codificar *{doc}* ({date})

> {texto}

**Campos mencionados:** <!-- ex: q2, q14 -->
**Decisão:** <!-- aprovar | rejeitar | reformular | ignorar -->
**Mudança no schema:** <!-- ... -->
**Nota ao resolver:** <!-- ... -->

<!-- ids: nota-<response-uuid> -->
```

Tipos de heading de bloco (úteis ao gerar/parsear):
- `### Review de **X** em *doc*` (com ou sem " — contestado por N pesquisadores")
- `### Dúvidas em *doc* sobre o veredito "Y" (N pesquisadores)` (dúvidas órfãs)
- `### Anotação de **X** em *doc* (date)` (anotação única)
- `### N anotações em *doc*` (anotações agrupadas por documento)
- `### Sugestão de schema por **X** (date)`
- `### Nota de pesquisador de **X** ao codificar *doc* (date)` (seção Notas gerais)
- `### Ambiguidade reportada pelo LLM em *doc* (date)` (seção Notas gerais)

### 1.5 Salvar e informar

O pipeline padrão já salva em `docs/comentarios/{projectName}-{YYYYMMDD}.md`. Avise o caminho completo ao usuário e explique como editar as diretivas dentro dos `<!-- ... -->`.

## Passo 2 — Aplicar as decisões

Quando o usuário devolver o .md anotado:

### 2.1 Parsear o .md anotado

O .md atual usa formato conversacional. Parse assim:

1. **Seções por campo**: split por `^## ` (H2). O heading `## \`{fieldName}\`` indica o field. A seção `## Notas gerais` concentra notas/dificuldades do `(geral)`.
2. **Blocos por cluster**: dentro de cada seção, split por `^### ` (H3). O heading é prosa livre — não tenta extrair id dele.
3. **IDs do bloco**: extrair do comentário HTML `<!-- ids: id1; id2; ... -->` no fim do bloco. Cada id tem formato `{source}-{rawId}` (para `duvida`, o rawId é `{reviewId}-{respondentId}`).
4. **Diretivas**: extrair conteúdo entre `<!--` e `-->` de cada linha `**Decisão:**`, `**Mudança no schema:**`, `**Nota ao resolver:**`, `**Campos mencionados:**` (se aplicável).
5. **Uma decisão se aplica a todos os ids do bloco** — ex: cluster com 1 review + 4 dúvidas fecha os 5 de uma vez. O texto de "Mudança no schema" e "Nota ao resolver" também é único para o bloco.
6. **Aceitar variantes de escrita humana em `Decisão:`**: o usuário pode escrever "aprovar", "Ignorar e resolver.", "ok, resolver sem mudar", etc. Interpretar semanticamente:
   - Se menciona "resolver"/"fechar"/"ok" e NÃO tem texto em "Mudança no schema" → trata como `rejeitar` (fecha sem mudar).
   - Se "aprovar"/"sim" com texto em "Mudança no schema" preenchido → `aprovar` (aplica + fecha).
   - Se "reformular"/"ajustar com nota" → `reformular`.
   - Se "ignorar"/"pular"/"depois" ou vazio → pular o bloco.
7. Quando em dúvida sobre o texto livre do usuário, use AskUserQuestion antes de aplicar.

### 2.2 Converter "Mudança no schema" em diff concreto

O usuário escreve em linguagem livre. Você converte para mutações no `PydanticField[]`. Casos típicos:

| Texto do usuário | Mutação |
|---|---|
| "adicionar opção X" | `field.options.push("X")` |
| "remover opção Y" | `field.options = field.options.filter(o => o !== "Y")` |
| "mudar description para ..." | `field.description = "..."` |
| "remover help_text" | `field.help_text = undefined` |
| "adicionar help_text: ..." | `field.help_text = "..."` |
| "renomear para X" | `field.name = "X"` (cuidado: é mudança estrutural minor) |
| "adicionar campo novo: ..." | push novo objeto `PydanticField` |
| "remover campo" | `fields = fields.filter(f => f.name !== target)` |

**Regras importantes:**
- Mudanças de `description`/`help_text` → patch version (invalida responses LLM se hash mudar)
- Mudanças em `options`, `type`, `required`, `target`, `subfields` → minor version
- Nunca aprove "mudança no schema" sem entender o que está sendo mudado. Em caso de dúvida, use AskUserQuestion.

### 2.3 Montar o decisions.json

Produza um arquivo temporário com esta estrutura (definida em `scripts/comentarios-relatorio/apply-decisions.ts`):

```json
{
  "projectId": "uuid",
  "changedBy": "uuid-opcional",
  "newFields": [ /* lista COMPLETA de fields após aplicar mudanças */ ],
  "resolutions": [
    { "source": "anotacao", "rawId": "uuid" },
    { "source": "review",   "rawId": "uuid" },
    { "source": "nota",     "rawId": "response-uuid", "note": "texto opcional" },
    { "source": "dificuldade", "rawId": "response-uuid", "documentId": "doc-uuid", "note": "..." },
    { "source": "duvida",   "reviewId": "uuid", "respondentId": "uuid" },
    { "source": "sugestao", "rawId": "suggestion-uuid", "action": "approved" }
  ],
  "summaryNote": "texto opcional: resumo do que foi decidido nessa rodada"
}
```

Salve em `/tmp/decisions-{projectName}-{timestamp}.json`.

### 2.4 Rodar dry-run

Sempre primeiro:
```bash
cd frontend
npx tsx scripts/comentarios-relatorio/apply-decisions.ts /tmp/decisions-xxx.json --dry-run
```

Revise o output (`changeType`, `newVersion`, `logEntries`). Mostre ao usuário.

### 2.5 Aplicar

Após confirmação do usuário:
```bash
npx tsx scripts/comentarios-relatorio/apply-decisions.ts /tmp/decisions-xxx.json --yes
```

Isso:
1. Atualiza `projects.pydantic_code`, `pydantic_hash`, `pydantic_fields`, `schema_version_*`
2. Insere entries em `schema_change_log`
3. Marca LLM responses antigas como `is_current=false` (se hash mudou)
4. Resolve cada comentário via INSERT/UPDATE na tabela correta
5. Registra `summaryNote` como um `project_comment` já resolvido (trilha de auditoria)

## Referências

- `references/comment-sources.md` — detalhes das 6 fontes de comentários (schema, queries, semântica)
- `references/markdown-format.md` — gramática detalhada do .md que o usuário anota

## Gotchas

- **Drift de lógica**: `apply-decisions.ts` duplica `saveSchemaFromGUI` de `frontend/src/actions/schema.ts`. Quando aquela função evoluir (classificação de versão, novos campos de `PydanticField`, etc.), atualizar o script também. A duplicação é intencional (script não pode chamar server actions fora do Next runtime).
- **Parser e gerador acoplados**: o formato do .md é definido pelo `generate-report.py`. Se alterar o gerador (heading style, onde ficam os ids, etc.), atualizar também a seção 2.1 deste SKILL.md e `references/markdown-format.md`. O gerador e o parser (Claude) precisam estar de acordo.
- **Cluster = 1 decisão para N ids**: um bloco pode conter review + várias dúvidas + anotações. A diretiva `Decisão:` se aplica a todos os ids listados em `<!-- ids: ... -->`. Ao montar `resolutions` do JSON, produzir uma entry por id.
- **Responses humanas não são invalidadas**: mudança de descrição marca LLM como stale (via hash), mas respostas humanas permanecem — staleness é detectada em display time via `answer_field_hashes`.
- **Não inferir demais**: se uma nota geral menciona vários fields de forma ambígua, liste como cross-reference (não invente mudanças de schema). O usuário decide.
- **`duvida` tem chave composta**: `(review_id, respondent_id)`, não um id único. No sintético o formato é `duvida-{reviewId}-{respondentId}` — parse com cuidado (`rawId` tem hifens internos).
- **Sugestões**: aprovar uma sugestão com edits é equivalente a incluir as mudanças em `newFields` + adicionar `{ source: "sugestao", rawId: "...", action: "approved" }` nas resolutions. Não precisa chamar uma API separada.
- **`changedBy`**: se omitido, o script usa `projects.created_by` como fallback. Isso garante que o audit log tenha um user_id válido mesmo rodando fora do contexto Clerk.

## Invocação

O usuário aciona com frases como:
- "gera relatório de comentários do projeto Zolgensma"
- "compila os comentários abertos"
- "quero revisar o feedback do projeto X"
- "/comentarios-relatorio"

Ao terminar o passo 1, confirme o caminho do .md. Ao terminar o passo 2, mostre um resumo (quantos comentários resolvidos, versão bumpada de X → Y, quantos log entries inseridos).
