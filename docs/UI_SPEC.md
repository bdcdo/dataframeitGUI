# UI Specification

## Layout Global

```
+--------------------------------------------------+
| [Logo] {nome_projeto}                  [User v]  |  48px fixo
| [Docs] [Codificar] [Comparar] [Stats] [Config]   |  40px fixo
+--------------------------------------------------+
|                                                   |
|             CONTEUDO DA TAB                       |  flex-grow
|                                                   |
+--------------------------------------------------+
```

- Header + tabs = ~88px fixos no topo
- Conteudo: `h-[calc(100vh-88px)]`
- Tabs visiveis por role: coordenadores veem tudo; pesquisadores nao veem [Config]

## Tela de Codificacao (`/projects/[id]/code`)

```
+--------------------------------------------------+
| Doc: "Parecer 250116"                 [< 3/32 >] |  32px info bar
+--------------------------------------------------+
|                                                   |
|  Texto do parecer completo.                       |
|  max-width: 800px, centralizado.                  |  flex-grow
|  overflow-y: auto.                                |
+--------------------------------------------------+
| ● ● ● ● ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ (dots)    |
| 5/28: O tratamento e oferecido pelo SUS?          |  auto-height
| ○ Sim    ○ Nao                                    |  max 40vh
|                            [← Anterior] [Proximo →]|
+--------------------------------------------------+
```

### Comportamento
- **Dots** clicaveis: preenchido=respondida, vazio=pendente, maior=atual
- **Altura banner** adapta: max 40vh
- **Tipos de campo:**
  - `single` + options -> radio buttons verticais
  - `multi` + options -> checkboxes verticais
  - `text` -> textarea (2 linhas)
- **Navegacao:** botoes, dots, ou teclas ← →
- **Auto-save:** ao navegar para proxima pergunta
- **Navegacao entre docs:** setas na info bar

## Tela de Comparacao (`/projects/[id]/compare`)

```
+--------------------------------------------------+
| Doc: "Parecer 250116"  | Filtro: [Todos campos v]|
+--------------------------------------------------+
|  Texto do parecer, rolavel.                       |  ~50-60vh
+--------------------------------------------------+
| ● ● ○ ○ ○ ○ ○  (dots: so campos divergentes)    |
| Campo 3/47: q7_1 — Evidencia de eficacia          |
|                                                   |
| ┌ LLM ─────────────────────── ⚠ Desatualizada ┐ |
| │ "Sim, com ressalvas"                          │ |
| │ ▼ Justificativa                               │ |
| └───────────────────────────────────────────────┘ |
| ┌ Daniel ───────────────────────────────────────┐ |
| │ "Nao informado"                               │ |
| └───────────────────────────────────────────────┘ |
|                                                   |
| Veredito: [1] LLM  [2] Daniel  [3] Mariana       |
|           [A] Ambiguo  [S] Pular                  |
| Comentario: [____________________________]        |
|                            [← Anterior] [Proximo →]|
+--------------------------------------------------+
```

### Atalhos de teclado
- `1-9`: escolher resposta
- `a`: ambiguo
- `s`: pular
- `t`: toggle texto doc
- `n`: proximo
- `p`: anterior

## Config — Schema

Monaco Editor Python + barra de acoes (Validar, Salvar, Rodar LLM, status).

## Config — LLM

Provider/model selects + temperature + thinking level + botoes rodar + barra progresso.

## Documentos

Tabela com upload CSV, busca, preview.

## Atribuicoes

Grid editavel (docs x pesquisadores) + botao sortear.

## Stats

3 stat cards + progresso por campo + grafico barras recharts.

## Export

Botoes download CSV/Markdown + preview.
