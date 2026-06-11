# Quickstart: Melhorar o sorteio de atribuições

**Feature**: 001-improve-assignment-lottery

## Pré-requisitos

- Trabalhar em worktree própria (nunca no checkout primário):

```bash
git worktree add ../worktrees/001-improve-assignment-lottery 001-improve-assignment-lottery
cd ../worktrees/001-improve-assignment-lottery
```

- `frontend/.env.local` com as chaves Supabase/Clerk (já existente no checkout primário; copiar se necessário).

## Rodar

```bash
cd frontend && npm run dev
# backend FastAPI não é necessário para esta feature
```

## Aplicar a migration

Migrations são manuais (nunca rodam no merge):

```bash
cd frontend
export SUPABASE_ACCESS_TOKEN=$(grep SUPABASE_ACCESS_TOKEN .env.local | cut -d= -f2)
npx supabase link --project-ref nryebmwlmxuwvynfuzsv
npx supabase db push
```

## Testes

```bash
cd frontend && npx vitest run src/lib/__tests__/lottery-utils.test.ts
```

Cobrem as duas primitivas puras: `filterEligibleDocs` (filtros e composição) e `distributeDocs` (uniformidade da rodada, nivelamento por histórico, não-concentração, desempate aleatório via RNG injetado — research.md D10/D12).

## Validação manual (espelha os acceptance scenarios da spec)

1. Abrir um projeto com documentos parcialmente codificados → `/projects/<id>/analyze/assignments` → "Sortear".
2. **Filtros (US1)**: marcar "sem nenhuma codificação" e conferir que a contagem de elegíveis cai na hora; sortear e conferir na tabela que só docs sem codificação ganharam células novas.
3. **Append (US2)**: sortear "Lote 1"; reabrir, filtrar "sem atribuição ativa do tipo", modo acrescentar, rotular "Lote 2", sortear; conferir que as atribuições pendentes do Lote 1 continuam na tabela.
4. **Replace (US2)**: sortear em modo substituir e conferir que pendentes foram redistribuídas e em andamento/concluídas ficaram intactas.
5. **Participantes (US3)**: desligar um pesquisador e sortear; a coluna dele não ganha atribuições novas. Ligar um coordenador e conferir que ele recebe.
6. **Lote (US4)**: excluir o "Lote 1" da elegibilidade e conferir que nenhum doc daquele lote reaparece.
7. **Manual (US5)**: ligar a seleção manual, buscar e marcar 5 docs, sortear; só esses 5 distribuem.
8. **Prazo (US6)**: percorrer o dialog — sem seção de prazo; prévia sem coluna Prazo.
9. **Equilíbrio (US7)**: num projeto com 3+ participantes de cargas diferentes, sortear ~12 docs no modo "Equilibrar só esta rodada" → prévia e tabela mostram cada participante com a mesma quantidade de atribuições novas (±1); repetir no modo "considerando rodadas anteriores" → quem tinha menos carga recebe mais, sem ninguém levar tudo. Repetir o sorteio (substituir) algumas vezes e conferir que os contemplados variam (desempate aleatório, não a ordem dos membros).
10. **Bordas**: combinar filtros até 0 elegíveis → botões desabilitados com mensagem; todos os toggles desligados → idem.
11. **Prévia (SC-005)**: para a mesma configuração, "Visualizar prévia" e o toast pós-sorteio devem reportar os mesmos totais.

## Verificação de qualidade antes do PR

```bash
cd frontend && npx tsc --noEmit && npm run lint
```

O gate react-doctor roda no pre-commit (usar `--diff`, não `--staged`).
