# Formato do relatório .md

Gramática do .md que a skill `comentarios-relatorio` gera (passo 1, via `generate-report.py`) e parseia de volta (passo 2, via Claude).

## Princípios

1. **Conversacional, não formulário**: headings são prosa; metadados dos campos ficam em linhas `**Label:** valor` (uma por atributo).
2. **Cluster = 1 bloco = 1 decisão**: quando múltiplos pesquisadores contestam o mesmo veredito, vão num único H3 com a decisão aplicada a todos.
3. **IDs invisíveis ao leitor**: os `rawId`s necessários para resolução ficam num comentário HTML `<!-- ids: ... -->` no fim do bloco.
4. **Diretivas em HTML comments**: `<!-- aprovar | ... -->` é o placeholder. O usuário edita dentro dos `<!-- -->` ou substitui totalmente pelo valor desejado.

## Estrutura

```markdown
# Comentários em aberto — {projectName}

Projeto `{projectId}` na versão do schema `{version}`. Gerado em {YYYY-MM-DD}.

Há **{N} comentários em aberto** — {M} perguntas com comentários específicos e {P} nota(s) geral(is). Por fonte: ...

Para cada bloco, preencha `Decisão:` ...

---

## `{fieldName}`

**Pergunta:** {description}
**Orientação aos pesquisadores:** {help_text}     (opcional)
**Opções:** A · B · C                              (opcional)
**Subcampos:** key (label), ... ({regra})          (opcional)

### {heading livre identificando o cluster}

{corpo conversacional: prosa + citações + bullets de quem disse o quê}

**Decisão:** <!-- aprovar | rejeitar | reformular | ignorar -->
**Mudança no schema:** <!-- descreva em português o que mudar, ou deixe vazio -->
**Nota ao resolver:** <!-- opcional -->

<!-- ids: {source}-{rawId}; {source}-{rawId}; ... -->

---

## Notas gerais

### {heading: Nota / Ambiguidade}

{corpo}

**Campos mencionados:** <!-- ex: q2, q14 -->
**Decisão:** <!-- ... -->
**Mudança no schema:** <!-- ... -->
**Nota ao resolver:** <!-- ... -->

<!-- ids: nota-<response-uuid> -->
```

## Tipos de cluster e seus headings

Gerados por `generate-report.py`:

| Tipo de cluster | Heading típico | Conteúdo |
|---|---|---|
| Review + dúvidas | `### Review de **{reviewer}** em *{doc}* — contestado por N pesquisadores` | Review original + todas as dúvidas com `extra.reviewId == review.rawId` + anotações do mesmo `documentId` |
| Review sem dúvidas | `### Review de **{reviewer}** em *{doc}*` | Só o review |
| Dúvidas órfãs | `### Dúvidas em *{doc}* sobre o veredito "{verdict}" (N pesquisadores)` | Dúvidas cujo review já foi resolvido |
| Anotação única | `### Anotação de **{autor}** em *{doc}* ({date})` | 1 anotação avulsa |
| Anotações múltiplas | `### N anotações em *{doc}*` | Várias anotações no mesmo documento |
| Sugestão | `### Sugestão de schema por **{autor}** ({date})` | 1 sugestão |
| Nota geral | `### Nota de pesquisador de **{autor}** ao codificar *{doc}* ({date})` | 1 nota livre |
| Dificuldade LLM | `### Ambiguidade reportada pelo LLM em *{doc}* ({date})` | 1 `llm_ambiguidades` |

**Vereditos multi-select** (JSON dict) são resumidos em `"opção A, opção B e mais N"` — o gerador chama `format_verdict()` em `generate-report.py`.

## Diretivas

Sempre estas (na ordem):

```markdown
**Decisão:** <!-- aprovar | rejeitar | reformular | ignorar -->
**Mudança no schema:** <!-- descreva em português o que mudar, ou deixe vazio -->
**Nota ao resolver:** <!-- opcional -->
```

Em blocos da seção "Notas gerais", adicionar também:

```markdown
**Campos mencionados:** <!-- ex: q2, q14 -->
```

### Semântica da decisão

| Valor | Efeito |
|---|---|
| `aprovar` | Aplica "Mudança no schema" + marca **todos os ids do bloco** como resolvidos |
| `rejeitar` | Não aplica mudança; marca todos os ids como resolvidos. Para sugestão, `status=rejected` |
| `reformular` | Marca como resolvido + registra "Nota ao resolver" num novo `project_comment` já resolvido |
| `ignorar` ou vazio | Pula o bloco (não resolve nada) |

### Aceitar escrita humana

O usuário frequentemente escreve em português livre. Interpretar semanticamente (ver também seção 2.1 do SKILL.md):

- "Ignorar e resolver" / "ok, resolver sem mudar" / "fechar" → `rejeitar`
- "Aprovar" + texto em "Mudança no schema" → `aprovar`
- "Reformular" / "ajustar com nota" → `reformular`
- "Ignorar" / "depois" / "pular" / vazio → pular

Em caso de dúvida, usar `AskUserQuestion`.

## IDs no rodapé

Formato:

```markdown
<!-- ids: id1; id2; id3 -->
```

Cada id é `{source}-{rawId}`:
- `review-{uuid}`
- `nota-{response-uuid}`
- `sugestao-{suggestion-uuid}`
- `dificuldade-{response-uuid}`
- `anotacao-{project-comment-uuid}`
- `duvida-{reviewId}-{respondentId}` — **dois UUIDs concatenados com `-`**

Ao parsear `duvida`: o id sintético tem formato `duvida-{8-4-4-4-12}-{8-4-4-4-12}`. Regex utilizável:

```
^duvida-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$
```

## Algoritmo de parse (passo 2)

1. Ler o .md inteiro
2. Split por `^## ` → cada seção é um field ou "Notas gerais"
3. Para cada seção não-geral, capturar `fieldName` do heading `## \`{name}\``
4. Dentro, split por `^### ` → cada bloco é um cluster
5. Para cada bloco:
   - Extrair `<!-- ids: ... -->` do fim
   - Extrair diretivas entre `<!--` e `-->` de cada linha `**Decisão:**`, `**Mudança no schema:**`, `**Nota ao resolver:**`, `**Campos mencionados:**`
   - Se `Decisão:` vazio ou "ignorar" → pular
   - Se tem "Mudança no schema" preenchida, interpretar como mutações de `PydanticField[]`
6. Consolidar todas as mutações em um único `newFields` (lista completa)
7. Gerar `resolutions` com um item por id encontrado

## Exemplo completo (mini)

```markdown
# Comentários em aberto — Zolgensma

Projeto `0c6394da-...` na versão do schema `0.11.1`. Gerado em 2026-04-22.

Há **2 comentários em aberto** — 1 pergunta com comentários específicos e 0 notas gerais. Por fonte: 1 review, 1 duvida.

---

## `q8_registro_anvisa`

**Pergunta:** Registro na ANVISA
**Opções:** Sim · Não · Não informado

### Review de **Jacqueline** em *Parecer 123* — contestado por Um pesquisador

Em 2026-03-27, **Jacqueline** revisou este documento e escolheu o veredito **"Não informado"**, deixando a seguinte observação:

> Tem casos em que o documento diz "em análise". Podemos adicionar essa opção?

Um pesquisador manifestou dúvida sobre esse veredito:

- **Maria** — Quando o registro foi cancelado, conto como "Não"?

**Decisão:** <!-- aprovar -->
**Mudança no schema:** <!-- adicionar opção "Em análise"; help_text: "Se cancelado, marcar Não." -->
**Nota ao resolver:** <!-- Conforme reunião 2026-04-20 -->

<!-- ids: review-abc123; duvida-abc123-resp1 -->
```

Esse .md produz:

```json
{
  "projectId": "0c6394da-...",
  "newFields": [ /* q8 com options=[...,"Em análise"], help_text="Se cancelado, marcar Não." */ ],
  "resolutions": [
    { "source": "review", "rawId": "abc123" },
    { "source": "duvida", "reviewId": "abc123", "respondentId": "resp1" }
  ],
  "summaryNote": "Conforme reunião 2026-04-20"
}
```

Classificação: mudança em `options` → **minor**. Versão: `0.11.1` → `0.12.0`.
