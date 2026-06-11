# Contracts: Server Actions do sorteio

**Feature**: 001-improve-assignment-lottery | **Date**: 2026-06-10 | **Updated**: 2026-06-11 (US7 — `balancing` + `distributeDocs`; remediação I1 — semente prévia → sorteio, research D13)

Interface exposta = Server Actions em `frontend/src/actions/assignments.ts` consumidas pelo `LotteryDialog`. Todas exigem usuário autenticado (Clerk) e operam sob RLS (coordenador do projeto).

## Tipos compartilhados (`frontend/src/lib/lottery-utils.ts`)

```ts
export type LotteryMode = "append" | "replace";
export type LotteryBalancing = "round" | "history";
export type AssignmentFilter = "any" | "noActiveOfType" | "neverAssigned";

export interface LotteryFilters {
  maxHumanCodings?: number;          // undefined = todos; 0 = sem nenhuma; N = no máximo N
  assignmentFilter?: AssignmentFilter; // default "any"
  batchFilter?: { exclude?: string[]; only?: string };
  manualDocIds?: string[];
}

export interface LotteryDocStats {
  id: string;
  externalId: string | null;
  title: string | null;
  humanCodingCount: number;          // respondentes humanos distintos com resposta is_latest
  activeAssignments: { codificacao: number; comparacao: number }; // pendente + em_andamento
  hasAnyAssignmentEver: boolean;
  batchIds: string[];
}

// Pura, compartilhada client/server — fonte única da elegibilidade
export function filterEligibleDocs(
  docs: LotteryDocStats[],
  type: "codificacao" | "comparacao",
  filters: LotteryFilters,
): LotteryDocStats[];

// Pura — núcleo da distribuição (research.md D12); RNG injetável p/ testes
export interface LotteryParticipant {
  id: string;
  accumulatedLoad: number;   // atribuições do tipo no conjunto preservado do modo
  capacity: number;          // docsPerResearcher - accumulatedLoad, ou Infinity
}

export function distributeDocs(
  eligibleDocIds: string[],
  participants: LotteryParticipant[],
  options: {
    researchersPerDoc: number;
    balancing: LotteryBalancing;
    preservedPairs: Set<string>;                    // "docId:userId" já existentes
    docAssignedUsers: Record<string, string[]>;     // usuários preservados por doc
    coOccurrence: Record<string, Record<string, number>>;
    rng: () => number;                               // PRNG seedado vindo de computeLottery (research D13)
  },
): { document_id: string; user_id: string }[];
```

## `getLotteryDocStats(projectId: string)` — NOVA (leitura)

Carregada uma vez na abertura do dialog.

```ts
returns Promise<{
  docs: LotteryDocStats[];                                  // só documentos ativos
  batches: { id: string; label: string | null; createdAt: string }[];
  minResponsesForComparison: number;
}>
```

Erros: `"Não autenticado"`; RLS devolve vazio para não-membros.

## `LotteryParams` — ALTERADA

```ts
export interface LotteryParams {
  projectId: string;
  type?: "codificacao" | "comparacao";   // default "codificacao"
  mode: LotteryMode;                      // NOVO — default na UI: "append"
  balancing: LotteryBalancing;            // NOVO — default na UI: "round"
  seed?: number;                          // NOVO — semente da prévia (research D13); ausente = gerar nova
  researchersPerDoc: number;
  docsPerResearcher?: number;
  docSubsetSize?: number;
  label?: string;
  filters?: LotteryFilters;               // NOVO
  participantIds: string[];               // NOVO — substitui includedCoordinatorIds
  // REMOVIDOS: deadlineMode, deadlineDate, recurringCount, recurringStart,
  //            includedCoordinatorIds
}
```

Validações server-side (erros como `throw new Error(mensagem pt-BR)`):

- `participantIds` não vazio e todos membros do projeto (qualquer role) — senão `"Necessário ter ao menos um participante válido."`
- Conjunto elegível pós-filtros não vazio — senão `"Nenhum documento passa nos filtros atuais."` (comparação mantém `"Nenhum documento tem respostas suficientes para comparação."` quando o corte vem da exigência mínima)
- `batchFilter.only` e `batchFilter.exclude` são mutuamente exclusivos (UI já impede; server rejeita)

## `previewLottery(params: LotteryParams)` — ALTERADA

```ts
returns Promise<LotteryPreview>

export interface LotteryPreview {
  participants: { userId: string; existing: number; newDocs: number }[]; // sem deadline
  totalNew: number;
  totalPreserved: number;   // em append inclui pendentes preservadas
  eligibleDocs: number;     // NOVO — nº de docs elegíveis pós-filtros (pré-subset)
  seed: number;             // NOVO — semente usada; o dialog a reenvia em smartRandomize (research D13)
}
```

Garantia (FR-013/SC-005): usa exatamente o mesmo `computeLottery(params)` da execução, e toda a aleatoriedade (shuffle de docs, subset, desempates de `distributeDocs`) deriva do PRNG seedado — mesma semente + mesma configuração + mesmos dados ⇒ resultado idêntico ao sortear. `existing` conta as atribuições preservadas pelo modo corrente (em `append`, inclui pendentes).

## `smartRandomize(params: LotteryParams)` — ALTERADA

```ts
returns Promise<{ count: number; preserved: number }>
```

Efeitos:

1. `mode === "replace"`: DELETE das atribuições `pendente` do tipo no projeto; `mode === "append"`: nenhum delete.
2. INSERT em `assignment_batches` com `mode`, `balancing`, `filters` (JSONB, incluindo `participantIds`, `docSubsetSize` e `seed`), `deadline_mode: 'none'`, demais colunas como hoje.
3. INSERT das novas atribuições em chunks de 100, sem `deadline`, com `batch_id` e `type`.
4. `revalidatePath` de assignments/code/compare (inalterado).

Invariantes (FR-009): nunca viola `UNIQUE(document_id, user_id, type)`; nunca toca atribuições `em_andamento`/`concluido`.

Garantias da distribuição (US7): no modo `balancing: "round"` sem limites de capacidade, diferença máxima de 1 atribuição nova entre participantes (SC-006); no modo `"history"`, prioridade a quem tem menor carga acumulada (pendentes + em andamento + concluídas em `append`; em andamento + concluídas em `replace`); em ambos, desempate aleatório — a ordem do array de membros não influencia o resultado (FR-019) — e nunca um único participante recebe todos os documentos havendo outros com capacidade.

## Removida

`randomizeAssignments(...)` (wrapper legado sem chamadores fora do próprio arquivo) — excluir.

## Contrato de UI (`LotteryDialog`)

Props: `projectId: string; members: { userId: string; name: string; role: "pesquisador" | "coordenador" }[]` (a page de atribuições já tem nomes; `totalDocs`/`totalResearchers`/`coordinators` saem — contagens passam a vir de `getLotteryDocStats` + toggles).

Comportamentos obrigatórios: contagem de elegíveis e estimativa por participante recalculadas client-side a cada mudança (FR-007); "Visualizar prévia" e "Sortear" desabilitados com 0 elegíveis ou 0 participantes, com mensagem contextual; seção Prazo inexistente (FR-012); prévia sem coluna Prazo e exibindo nomes dos participantes (não mais `userId.slice(0,8)`); seleção do modo de equilíbrio na seção Distribuição (RadioGroup "Equilibrar só esta rodada" — default — / "Equilibrar considerando rodadas anteriores"), refletida na prévia (FR-016); o dialog guarda a `seed` retornada pela prévia e a envia ao sortear, descartando-a sempre que qualquer configuração muda (sortear sem prévia ⇒ sem `seed`, o server gera nova — research D13).
