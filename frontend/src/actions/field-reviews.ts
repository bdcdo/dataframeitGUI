"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthUser, getEffectiveMemberId, requireCoordinator } from "@/lib/auth";
import { buildLoadMap } from "@/lib/load-balancing";
import { errorMessage } from "@/lib/utils";
import { canonicalPair } from "@/lib/equivalence";
import { buildEquivalenceMap, type EquivalenceRow } from "@/lib/compare-queue";
import {
  computeBacklogRows,
  compositeKeySet,
  diffReviewsToRemove,
  type ExistingFieldReviewRow,
  type HumanResponseRow,
  type LlmResponseRow,
} from "@/lib/auto-review-backlog";
import { resolveBlindVerdict } from "@/lib/arbitration-order";
import { verdictRequiresJustification } from "@/lib/auto-review-decided";
import { formatAnswerTechnical } from "@/lib/format-answer";
import { syncAutoRevisaoAssignmentStatus } from "@/lib/auto-revisao-sync";
import { syncArbitragemAssignmentStatus } from "@/lib/arbitragem-sync";
import { revalidatePath } from "next/cache";
import type {
  PydanticField,
  SelfVerdict,
  ArbitrationVerdict,
} from "@/lib/types";

export interface SelfVerdictInput {
  fieldName: string;
  verdict: SelfVerdict;
  // Obrigatoria quando verdict='contesta_llm' ou 'ambiguo'. Em contesta_llm o
  // pesquisador registra por que acha que sua resposta esta correta (exibida ao
  // arbitro na revelacao); em ambiguo registra por que o campo e ambiguo
  // (anexada ao project_comments de discussao).
  justification?: string;
}

// Humano original conclui sua fase de auto-revisao. Para cada campo:
//   - admite_erro  → gabarito do campo = LLM, fica resolvido
//   - contesta_llm → cai na fila de arbitragem (sorteia arbitro neste mesmo call)
//   - equivalente  → registra o par humano↔LLM em response_equivalences; campo
//                    fica resolvido, sem arbitragem
//   - ambiguo      → gera um project_comments para discussao; campo fica
//                    resolvido, sem arbitragem
//
// Idempotente: regravar a auto-revisao apos enviada nao reinicia arbitragem
// (UPDATE so toca campos com self_verdict IS NULL; os efeitos colaterais de
// equivalente/ambiguo so agem nos campos cujo UPDATE retornou linha).
export async function submitAutoReview(
  projectId: string,
  documentId: string,
  verdicts: SelfVerdictInput[],
): Promise<{
  success: boolean;
  error?: string;
  warning?: string;
  arbitrated?: number;
}> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    // Identidade de trabalho no projeto (spec 002): conta vinculada revisa
    // como o membro canônico.
    const effectiveId = await getEffectiveMemberId(projectId);

    // contesta_llm e ambiguo exigem justificativa — o arbitro precisa do
    // contraponto humano na revelacao; ambiguo leva o porque para a discussao.
    for (const v of verdicts) {
      if (verdictRequiresJustification(v.verdict) && !v.justification?.trim()) {
        return {
          success: false,
          error:
            v.verdict === "ambiguo"
              ? `Campo "${v.fieldName}": justificativa obrigatória quando você marca como ambíguo.`
              : `Campo "${v.fieldName}": justificativa obrigatória quando você contesta o LLM.`,
        };
      }
    }

    const admin = createSupabaseAdmin();
    const now = new Date().toISOString();

    // UPDATE paralelo (em vez de N+1 sequencial). Cada UPDATE so toca o seu
    // proprio par (doc, field) com self_verdict ainda NULL — RETURNING ajuda
    // a saber quais campos foram efetivamente atualizados.
    const updateResults = await Promise.all(
      verdicts.map((v) =>
        admin
          .from("field_reviews")
          .update({
            self_verdict: v.verdict,
            self_reviewed_at: now,
            self_justification: verdictRequiresJustification(v.verdict)
              ? (v.justification?.trim() ?? null)
              : null,
          })
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("field_name", v.fieldName)
          .eq("self_reviewer_id", effectiveId)
          .is("self_verdict", null)
          .select("field_name"),
      ),
    );

    // Campos efetivamente atualizados neste call (UPDATE casou linha). Fonte
    // para a logica de arbitragem de contesta_llm — re-submit nao reabre
    // arbitragem. Os efeitos de equivalente/ambiguo usam outra fonte (estado
    // real de field_reviews) para tolerar retry apos falha parcial.
    const updatedFieldNames = new Set<string>();
    for (const res of updateResults) {
      if (res.error) return { success: false, error: res.error.message };
      for (const r of res.data ?? []) {
        if (r.field_name) updatedFieldNames.add(r.field_name);
      }
    }

    // Sync do assignment auto_revisao — ver lib/auto-revisao-sync.ts.
    await syncAutoRevisaoAssignmentStatus(admin, projectId, documentId, effectiveId, now);

    // Efeitos colaterais de equivalente/ambiguo precisam rodar tanto para
    // campos recem-atualizados quanto para os que JA estavam com o verdict
    // gravado — retry apos falha parcial (o UPDATE acima casa 0 linhas porque
    // self_verdict ja nao e NULL). Por isso a fonte de verdade aqui e o estado
    // real de field_reviews, nao `updatedByField`. Os efeitos sao idempotentes
    // (upsert ignoreDuplicates / check-before-insert), entao re-executar e
    // seguro.
    const sideEffectFieldNames = verdicts.flatMap((v) =>
      v.verdict === "equivalente" || v.verdict === "ambiguo"
        ? [v.fieldName]
        : [],
    );
    const effectByField = new Map<
      string,
      {
        self_verdict: SelfVerdict | null;
        human_response_id: string;
        llm_response_id: string;
      }
    >();
    if (sideEffectFieldNames.length > 0) {
      const { data: stateRows, error: stateErr } = await admin
        .from("field_reviews")
        .select("field_name, self_verdict, human_response_id, llm_response_id")
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("self_reviewer_id", effectiveId)
        .in("field_name", sideEffectFieldNames);
      if (stateErr) return { success: false, error: stateErr.message };
      for (const r of stateRows ?? []) {
        effectByField.set(r.field_name, {
          self_verdict: r.self_verdict,
          human_response_id: r.human_response_id,
          llm_response_id: r.llm_response_id,
        });
      }
    }

    // equivalente: registra o par humano↔LLM em response_equivalences. O campo
    // fica resolvido (sem arbitragem) e a divergencia nao reaparece, pois
    // createAutoReviewIfDiverges/regenerateAutoReviewBacklog passam a consultar
    // response_equivalences. So age em campos cujo self_verdict gravado e
    // 'equivalente' (cobre este call e retry de falha parcial).
    const equivalentFields = verdicts.filter(
      (v) =>
        v.verdict === "equivalente" &&
        effectByField.get(v.fieldName)?.self_verdict === "equivalente",
    );
    if (equivalentFields.length > 0) {
      const equivRows = equivalentFields.map((v) => {
        const ids = effectByField.get(v.fieldName)!;
        const [a, b] = canonicalPair(
          ids.human_response_id,
          ids.llm_response_id,
        );
        return {
          project_id: projectId,
          document_id: documentId,
          field_name: v.fieldName,
          response_a_id: a,
          response_b_id: b,
          reviewer_id: effectiveId,
        };
      });
      const { error: equivErr } = await admin
        .from("response_equivalences")
        .upsert(equivRows, {
          onConflict:
            "project_id,document_id,field_name,response_a_id,response_b_id",
          ignoreDuplicates: true,
        });
      if (equivErr) return { success: false, error: equivErr.message };
    }

    // ambiguo: o campo e genuinamente ambiguo → registra um project_comments
    // com o contraste humano vs LLM para discussao posterior. Check-before-insert
    // evita duplicar em retry. So age em campos cujo self_verdict gravado e
    // 'ambiguo' (cobre este call e retry de falha parcial).
    const ambiguousFields = verdicts.filter(
      (v) =>
        v.verdict === "ambiguo" &&
        effectByField.get(v.fieldName)?.self_verdict === "ambiguo",
    );
    if (ambiguousFields.length > 0) {
      const responseIds = new Set<string>();
      for (const v of ambiguousFields) {
        const ids = effectByField.get(v.fieldName)!;
        responseIds.add(ids.human_response_id);
        responseIds.add(ids.llm_response_id);
      }
      const { data: respRows } = await admin
        .from("responses")
        .select("id, answers")
        .in("id", Array.from(responseIds));
      const answersById = new Map(
        (respRows ?? []).map((r) => [
          r.id as string,
          r.answers as Record<string, unknown> | null,
        ]),
      );

      const { data: existingComments } = await admin
        .from("project_comments")
        .select("field_name")
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .in(
          "field_name",
          ambiguousFields.map((v) => v.fieldName),
        )
        .eq("author_id", effectiveId);
      const alreadyCommented = new Set(
        (existingComments ?? []).map((r) => r.field_name as string),
      );

      const commentRows = ambiguousFields.flatMap((v) => {
        if (alreadyCommented.has(v.fieldName)) return [];
        const ids = effectByField.get(v.fieldName)!;
        const humanAnswer = formatAnswerTechnical(
          answersById.get(ids.human_response_id)?.[v.fieldName],
        );
        const llmAnswer = formatAnswerTechnical(
          answersById.get(ids.llm_response_id)?.[v.fieldName],
        );
        const body = [
          `Campo "${v.fieldName}" marcado como ambíguo na auto-revisão.`,
          `Humano respondeu: ${humanAnswer}`,
          `LLM respondeu: ${llmAnswer}`,
          // Justificativa garantida nao-vazia pela validacao no topo da funcao.
          `Justificativa do pesquisador: ${v.justification!.trim()}`,
          `Precisa de discussão para decidir o gabarito.`,
        ].join("\n\n");
        return [{
          project_id: projectId,
          document_id: documentId,
          field_name: v.fieldName,
          author_id: effectiveId,
          body,
        }];
      });

      if (commentRows.length > 0) {
        const { error: commentErr } = await admin
          .from("project_comments")
          .insert(commentRows);
        if (commentErr) return { success: false, error: commentErr.message };
      }
    }

    // Sorteia arbitro APENAS para campos cujo UPDATE acabou de gravar
    // contesta_llm (re-submit nao reabre arbitragem).
    const contested = verdicts.flatMap((v) =>
      v.verdict === "contesta_llm" && updatedFieldNames.has(v.fieldName)
        ? [v.fieldName]
        : [],
    );

    let arbitrated = 0;
    let warning: string | undefined;
    if (contested.length > 0) {
      const result = await assignArbitrator(
        projectId,
        documentId,
        effectiveId,
        contested,
      );
      arbitrated = result.count;
      // Pool vazio: o submit completa (self_verdict gravado) mas os campos
      // contestados ficam sem árbitro. Pode ser falta de outros membros ou
      // que nenhum dos demais foi marcado como elegível (can_arbitrate). Sem
      // este warning, os campos ficariam invisíveis em estado
      // "aguarda_arbitragem" indefinidamente. O retryPendingArbitrations
      // do setCanArbitrate cobre o caso de o coordenador habilitar alguém depois.
      if (result.noPool) {
        warning = `Não há árbitros elegíveis para ${contested.length} campo(s) contestado(s). Peça ao coordenador para marcar membros como elegíveis em Configuração → Equipe.`;
      }
    }

    revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true, arbitrated, warning };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

// Escolhe um arbitro elegível com balanceamento por carga; em empate na menor
// carga, sorteia aleatoriamente entre os candidatos para evitar viés
// estrutural em projetos pequenos. Prefere quem NÃO codificou o documento;
// quando isso é impossível, cai para qualquer elegível != auto-revisor.
//
// Granularidade: TODOS os campos contestados deste submit recebem o MESMO
// arbitro (um por documento, nao um por campo). Intencional para coerencia —
// o arbitro ve todos os campos do mesmo doc de uma vez. A tabela
// field_reviews permite arbitros diferentes por campo, mas este caminho
// (submit unico → 1 arbitro por doc) prefere coerencia sobre granularidade.
//
// Dois submits concorrentes ainda podem ler o mesmo `minLoad` e escolher o
// mesmo árbitro — isso só degrada o balanceamento. A correção não depende
// dessa leitura: a RPC final valida can_arbitrate sob lock e grava revisão +
// assignment na mesma transação, serializada com a desabilitação do membro.
//
// Idempotente: arbitrator_id so e gravado em field_reviews que ainda nao
// tem arbitro definido (re-chamadas nao trocam um arbitro ja escolhido).
//
// Retorna:
//  - count: quantidade de field_reviews efetivamente atribuidos
//  - noPool: true se o projeto não tem outros membros disponíveis (chamador
//    usa para alertar o pesquisador; sem esse sinal, o submit completa
//    silenciosamente e os campos ficam presos sem árbitro)
async function assignArbitrator(
  projectId: string,
  documentId: string,
  excludeUserId: string,
  fieldNames: string[],
  precomputedCoderIds?: Set<string>,
): Promise<{ count: number; noPool: boolean }> {
  const admin = createSupabaseAdmin();

  // Codificadores humanos deste documento — quem já tem resposta registrada
  // para o doc (recurso de comparação N+). Quando o caller pré-buscou em
  // batch (retryPendingArbitrations), reusa o set para evitar N queries.
  let coderIds: Set<string>;
  if (precomputedCoderIds) {
    coderIds = precomputedCoderIds;
  } else {
    const { data: coders } = await admin
      .from("responses")
      .select("respondent_id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("respondent_type", "humano");
    coderIds = new Set<string>();
    for (const c of coders ?? []) {
      if (c.respondent_id) coderIds.add(c.respondent_id as string);
    }
  }

  // Elegíveis (can_arbitrate) menos o auto-revisor original — esse nunca
  // arbitra, sob nenhuma circunstância, porque julgaria a própria resposta.
  const { data: eligibleMembers } = await admin
    .from("project_members")
    .select("user_id, role")
    .eq("project_id", projectId)
    .eq("can_arbitrate", true);
  const eligible = (eligibleMembers ?? []).filter(
    (m) => m.user_id !== excludeUserId,
  );

  // Pool ideal: árbitro que NÃO codificou o documento — totalmente neutro na
  // fase cega. Fallback: documentos codificados por toda a equipe elegível
  // (ex.: docs de calibração) não têm terceiro neutro possível; aceita-se
  // então qualquer elegível != auto-revisor — ele não julga a própria
  // resposta, ainda que tenha codificado o mesmo doc. noPool=true só quando
  // nem o fallback tem candidato → o caso cai no banner de pendências.
  const neutral = eligible.filter((m) => !coderIds.has(m.user_id));
  const members = neutral.length > 0 ? neutral : eligible;
  if (members.length === 0) return { count: 0, noPool: true };

  // Conta arbitragens abertas por candidato (balanceamento)
  const { data: openCounts } = await admin
    .from("assignments")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("type", "arbitragem")
    .neq("status", "concluido");

  const loadByUser = buildLoadMap(openCounts ?? []);

  // Carga minima entre candidatos
  let minLoad = Infinity;
  for (const m of members) {
    const l = loadByUser.get(m.user_id) ?? 0;
    if (l < minLoad) minLoad = l;
  }

  // Pesquisador tem prioridade sobre coordenador na menor carga
  const candidatesAtMinLoad = members.filter(
    (m) => (loadByUser.get(m.user_id) ?? 0) === minLoad,
  );
  const researchersAtMinLoad = candidatesAtMinLoad.filter(
    (m) => m.role === "pesquisador",
  );
  const finalPool = researchersAtMinLoad.length > 0
    ? researchersAtMinLoad
    : candidatesAtMinLoad;

  // Sorteio aleatorio entre os empatados
  const arbitratorId =
    finalPool[Math.floor(Math.random() * finalPool.length)].user_id;

  const { data: assigned, error: assignmentError } = await admin.rpc(
    "assign_arbitration_if_eligible",
    {
      p_project_id: projectId,
      p_document_id: documentId,
      p_user_id: arbitratorId,
      p_field_names: fieldNames,
    },
  );
  if (assignmentError) throw new Error(assignmentError.message);

  return { count: typeof assigned === "number" ? assigned : 0, noPool: false };
}

export interface BlindChoice {
  fieldReviewId: string;
  choice: "a" | "b";
}

// Fase 1 da arbitragem: arbitro escolhe cegamente entre A/B (sem justificativa).
// O cliente envia apenas A/B; o servidor traduz para humano/llm via assignOrder
// (deterministico por fieldReviewId) — assim o mapeamento A/B → humano/llm
// nunca trafega para o navegador na fase cega, eliminando o vetor de
// inspecao via DevTools.
//
// So aceita escrever onde arbitrator_id = current user e blind_verdict IS NULL.
// Retries com mesmo verdict sao tolerados como no-op (idempotente); retries
// com verdict diferente retornam erro descritivo em vez de no-op silencioso.
export async function submitBlindVerdicts(
  projectId: string,
  documentId: string,
  choices: BlindChoice[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    // Conta vinculada arbitra como o membro canônico (spec 002).
    const effectiveId = await getEffectiveMemberId(projectId);

    const supabase = await createSupabaseServer();
    const now = new Date().toISOString();

    const results = await Promise.all(
      choices.map((c) => {
        const verdict = resolveBlindVerdict(c.fieldReviewId, c.choice);
        return supabase
          .from("field_reviews")
          .update({ blind_verdict: verdict, blind_decided_at: now })
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("id", c.fieldReviewId)
          .eq("arbitrator_id", effectiveId)
          .is("blind_verdict", null)
          .select("id");
      }),
    );

    // Detecta UPDATE de 0 linhas: pode ser RLS, linha inexistente OU ja
    // decidida. Re-fetch para diferenciar idempotente (mesmo verdict) de
    // conflito real.
    const failedIndices: number[] = [];
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.error) return { success: false, error: res.error.message };
      if (!res.data || res.data.length === 0) {
        failedIndices.push(i);
      }
    }

    if (failedIndices.length > 0) {
      const failedIds = failedIndices.map((i) => choices[i].fieldReviewId);
      const { data: existing } = await supabase
        .from("field_reviews")
        .select("id, blind_verdict")
        .in("id", failedIds)
        .eq("arbitrator_id", effectiveId);
      const existingById = new Map(
        (existing ?? []).map((r) => [
          r.id as string,
          r.blind_verdict as ArbitrationVerdict | null,
        ]),
      );

      for (const i of failedIndices) {
        const c = choices[i];
        const expected = resolveBlindVerdict(c.fieldReviewId, c.choice);
        const current = existingById.get(c.fieldReviewId);
        if (current === undefined) {
          return {
            success: false,
            error: `Linha de revisão não encontrada ou sem permissão (${c.fieldReviewId}).`,
          };
        }
        if (current === expected) {
          continue; // idempotente OK
        }
        return {
          success: false,
          error: `Veredito cego já registrado com valor diferente para ${c.fieldReviewId}.`,
        };
      }
    }

    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

export interface FinalChoice {
  fieldName: string;
  verdict: ArbitrationVerdict;
  questionImprovementSuggestion?: string;
  arbitratorComment?: string;
}

// Fase 2: arbitro confirma/troca veredito apos ver justificativa LLM.
// Se final_verdict='llm' (humano perdeu), exige question_improvement_suggestion
// e cria entry em project_comments com contexto da divergencia.
// Marca assignment arbitragem como concluido se TODOS os field_reviews do doc
// tiverem final_verdict definido.
export async function submitFinalVerdicts(
  projectId: string,
  documentId: string,
  choices: FinalChoice[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    // Conta vinculada arbitra como o membro canônico (spec 002).
    const effectiveId = await getEffectiveMemberId(projectId);

    // Validacao: se humano perdeu (final='llm'), sugestao obrigatoria
    for (const c of choices) {
      if (c.verdict === "llm" && !c.questionImprovementSuggestion?.trim()) {
        return {
          success: false,
          error: `Campo "${c.fieldName}": sugestão de melhoria obrigatória quando você decide pelo LLM contra o humano.`,
        };
      }
    }

    const supabase = await createSupabaseServer();
    const admin = createSupabaseAdmin();
    const now = new Date().toISOString();

    // Estrategia de clientes:
    //  - supabase (RLS): qualquer operacao onde o proprio arbitro e o ator.
    //    Policies de field_reviews ("Arbitrator updates own row", SELECT
    //    arbitrator_id=clerk_uid()) e de assignments ("Researchers update
    //    own assignments") ja cobrem o caso.
    //  - admin (service key): apenas onde o arbitro pode nao ter visibilidade
    //    por RLS — leitura de responses (cross-user, RLS de responses e mais
    //    restritiva) e INSERT em project_comments (autor != arbitro em alguns
    //    cenarios, evitar policy-shaped erros).

    // 1) Carrega field_reviews com estado atual (inclui blind/final_verdict).
    // O estado pre-carregado permite que retries apos falha parcial em (4)
    // detectem "ja gravado com mesmo verdict" como sucesso idempotente em vez
    // de erro travante.
    // Duas FKs de field_reviews para responses (human_/llm_response_id) tornam
    // o nested select ambiguo no PostgREST — buscar respostas separadamente.
    const { data: frRows, error: frErr } = await supabase
      .from("field_reviews")
      .select(
        "id, field_name, human_response_id, llm_response_id, blind_verdict, final_verdict",
      )
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .in(
        "field_name",
        choices.map((c) => c.fieldName),
      )
      .eq("arbitrator_id", effectiveId);
    if (frErr) return { success: false, error: frErr.message };

    const frByField = new Map(
      (frRows ?? []).map((r) => [r.field_name as string, r]),
    );

    // Pre-validacao por linha + classificacao (skip idempotente vs erro vs update).
    const choicesToUpdate: FinalChoice[] = [];
    for (const c of choices) {
      const fr = frByField.get(c.fieldName);
      if (!fr) {
        return {
          success: false,
          error: `Campo "${c.fieldName}": linha de revisão não encontrada ou sem permissão.`,
        };
      }
      if (fr.blind_verdict == null) {
        return {
          success: false,
          error: `Campo "${c.fieldName}": fase cega ainda não decidida.`,
        };
      }
      if (fr.final_verdict != null) {
        // Veredito ja gravado — retry idempotente apenas se for o MESMO verdict.
        if (fr.final_verdict !== c.verdict) {
          return {
            success: false,
            error: `Campo "${c.fieldName}": veredito final já registrado como "${fr.final_verdict}".`,
          };
        }
        // mesmo verdict → segue para passos 4/5 sem re-UPDATE
        continue;
      }
      choicesToUpdate.push(c);
    }

    // 2) Respostas: admin porque a RLS de responses restringe leitura cross-user
    // (arbitro nao precisa ser membro do mesmo "scope" da resposta humana).
    // So precisa carregar respostas se ha algum verdict='llm' (para o comment).
    const needsResponseData = choices.some((c) => c.verdict === "llm");
    const responseById = new Map<string, { id: string; answers: unknown }>();
    if (needsResponseData) {
      const responseIds = new Set<string>();
      for (const r of frRows ?? []) {
        responseIds.add(r.human_response_id);
        responseIds.add(r.llm_response_id);
      }
      const { data: respRows } = await admin
        .from("responses")
        .select("id, answers")
        .in("id", Array.from(responseIds));
      for (const r of respRows ?? []) {
        responseById.set(r.id as string, r);
      }
    }

    // 3) UPDATEs em paralelo via supabase (RLS cobre "Arbitrator updates own row").
    //
    //  - not("blind_verdict", "is", null): obriga sequência blind → final.
    //    Sem isto, um árbitro (ou chamada direta à Server Action) pulava a
    //    fase cega e gravava final_verdict diretamente.
    //  - is("final_verdict", null): proteção contra race entre o pre-fetch
    //    acima e este UPDATE (outro submit concorrente do mesmo árbitro).
    //  - select("id"): detecta UPDATE de 0 linhas (race), erro descritivo.
    if (choicesToUpdate.length > 0) {
      const updateResults = await Promise.all(
        choicesToUpdate.map((c) =>
          supabase
            .from("field_reviews")
            .update({
              final_verdict: c.verdict,
              final_decided_at: now,
              question_improvement_suggestion:
                c.questionImprovementSuggestion ?? null,
              arbitrator_comment: c.arbitratorComment ?? null,
            })
            .eq("project_id", projectId)
            .eq("document_id", documentId)
            .eq("field_name", c.fieldName)
            .eq("arbitrator_id", effectiveId)
            .not("blind_verdict", "is", null)
            .is("final_verdict", null)
            .select("id"),
        ),
      );
      for (let i = 0; i < updateResults.length; i++) {
        const res = updateResults[i];
        if (res.error) return { success: false, error: res.error.message };
        if (!res.data || res.data.length === 0) {
          return {
            success: false,
            error: `Campo "${choicesToUpdate[i].fieldName}": UPDATE rejeitado (concorrência ou RLS).`,
          };
        }
      }
    }

    // 4) project_comments para verdict='llm': check-before-insert evita dupes
    // em retry (sem precisar de UNIQUE constraint que limitaria o uso geral
    // de comments). Race window minuscula entre SELECT e INSERT — aceitavel
    // dado o custo de evitar.
    const llmChoices = choices.filter((c) => c.verdict === "llm");
    if (llmChoices.length > 0) {
      const { data: existingComments } = await admin
        .from("project_comments")
        .select("field_name")
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .in(
          "field_name",
          llmChoices.map((c) => c.fieldName),
        )
        .eq("author_id", effectiveId);
      const alreadyCommented = new Set(
        (existingComments ?? []).map((r) => r.field_name as string),
      );

      const commentRows = llmChoices.flatMap((c) => {
        if (alreadyCommented.has(c.fieldName)) return [];
        const fr = frByField.get(c.fieldName);
        const humanResp = fr
          ? responseById.get(fr.human_response_id)
          : null;
        const llmResp = fr ? responseById.get(fr.llm_response_id) : null;
        const humanAnswer = formatAnswerTechnical(
          (humanResp?.answers as Record<string, unknown> | undefined)?.[
            c.fieldName
          ],
        );
        const llmAnswer = formatAnswerTechnical(
          (llmResp?.answers as Record<string, unknown> | undefined)?.[
            c.fieldName
          ],
        );
        const body = [
          `Discordância em "${c.fieldName}".`,
          `Humano respondeu: ${humanAnswer}`,
          `LLM respondeu: ${llmAnswer}`,
          `Árbitro manteve LLM.`,
          `Sugestão de melhoria: ${c.questionImprovementSuggestion}`,
          c.arbitratorComment ? `Comentário: ${c.arbitratorComment}` : null,
        ]
          .filter(Boolean)
          .join("\n\n");

        return [{
          project_id: projectId,
          document_id: documentId,
          field_name: c.fieldName,
          author_id: effectiveId,
          body,
        }];
      });

      if (commentRows.length > 0) {
        // Falha aqui significa que o veredito ja foi gravado mas o comentario
        // nao — coordenador perderia a sugestao. Propaga o erro para que retry
        // do usuario re-tente (e nao duplique, pelo check acima).
        const { error: commentErr } = await admin
          .from("project_comments")
          .insert(commentRows);
        if (commentErr) {
          return {
            success: false,
            error: `Veredicto salvo mas comentário de divergência falhou: ${commentErr.message}`,
          };
        }
      }
    }

    // 5) Sync do assignment arbitragem — ver lib/arbitragem-sync.ts.
    await syncArbitragemAssignmentStatus(supabase, projectId, documentId, effectiveId, now);

    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

// Coordenador-only: varre todas as respostas humanas concluidas do projeto e
// reconcilia o backlog de auto-revisao + field_reviews. Usado quando a chamada
// inline em saveResponse falhou silenciosamente (ver log "[auto-review]"), apos
// importar respostas em lote, ou apos uma edicao de schema que tornou campos
// antigos "stale" (campos adicionados depois de uma codificacao geravam
// field_reviews espurios com a resposta humana aparecendo como "(vazio)").
//
// Reconcile (nao so insert): alem de inserir o conjunto correto, remove
// field_reviews que nao deveriam mais existir — mas SO os ainda pendentes
// (self_verdict IS NULL). Linhas que o pesquisador ja resolveu nunca sao
// apagadas (apagar perderia trabalho); sao apenas contadas em `keptResolved`.
// Assignments auto_revisao que ficam sem nenhum field_review e ainda estao
// `pendente` sao removidos.
//
// Bulk-otimizado: queries em batch + upserts/deletes em batch, independente do
// numero de respostas.
type SupabaseAdminClient = ReturnType<typeof createSupabaseAdmin>;

interface BacklogInputs {
  fields: PydanticField[];
  humanResponses: HumanResponseRow[];
  llmResponses: LlmResponseRow[];
  equivalences: EquivalenceRow[];
  existingReviews: ExistingFieldReviewRow[];
}

// Batch de leitura inicial do backlog — lança em qualquer erro de query,
// convertido em { success: false, error } pelo try/catch de
// regenerateAutoReviewBacklog.
async function fetchBacklogInputs(
  admin: SupabaseAdminClient,
  projectId: string,
): Promise<BacklogInputs> {
  const [
    { data: project, error: projErr },
    { data: humanResponses, error: humanErr },
    { data: llmResponses, error: llmErr },
    { data: equivalences, error: equivErr },
    { data: existingReviews, error: existingErr },
  ] = await Promise.all([
    admin
      .from("projects")
      .select("pydantic_fields")
      .eq("id", projectId)
      .single(),
    admin
      .from("responses")
      .select("id, document_id, respondent_id, answers, answer_field_hashes")
      .eq("project_id", projectId)
      .eq("respondent_type", "humano")
      .eq("is_partial", false),
    admin
      .from("responses")
      .select("id, document_id, answers, answer_field_hashes")
      .eq("project_id", projectId)
      .eq("respondent_type", "llm")
      .eq("is_latest", true),
    admin
      .from("response_equivalences")
      .select("id, document_id, field_name, response_a_id, response_b_id, reviewer_id")
      .eq("project_id", projectId),
    // Estado atual de field_reviews — usado no reconcile abaixo. Independe
    // do conjunto recem-computado, entao buscamos junto do batch inicial.
    admin
      .from("field_reviews")
      .select("id, document_id, field_name, self_verdict")
      .eq("project_id", projectId),
  ]);

  if (projErr) throw new Error(projErr.message);
  if (humanErr) throw new Error(humanErr.message);
  if (llmErr) throw new Error(llmErr.message);
  if (equivErr) throw new Error(equivErr.message);
  if (existingErr) throw new Error(existingErr.message);

  return {
    fields: (project?.pydantic_fields as PydanticField[]) ?? [],
    humanResponses: (humanResponses ?? []) as HumanResponseRow[],
    llmResponses: (llmResponses ?? []) as LlmResponseRow[],
    equivalences: (equivalences ?? []) as EquivalenceRow[],
    existingReviews: (existingReviews ?? []) as ExistingFieldReviewRow[],
  };
}

// As etapas puras (computeBacklogRows, diffReviewsToRemove, compositeKeySet)
// vivem em @/lib/auto-review-backlog — "use server" só pode exportar funções
// async (regra do Next), então o que é puro e testável fica fora deste arquivo.

// Remove assignments auto_revisao orfaos: sem nenhum field_review restante
// para o doc+pesquisador e ainda `pendente`. Assignments ja iniciados ou
// concluidos sao preservados. As duas leituras refletem o estado pos-
// delete/upsert e sao independentes entre si — buscadas em paralelo.
async function removeOrphanAssignments(
  admin: SupabaseAdminClient,
  projectId: string,
): Promise<void> {
  const [
    { data: remainingReviews, error: remainingErr },
    { data: autoAssignments, error: autoErr },
  ] = await Promise.all([
    admin
      .from("field_reviews")
      .select("document_id, self_reviewer_id")
      .eq("project_id", projectId),
    admin
      .from("assignments")
      .select("id, document_id, user_id")
      .eq("project_id", projectId)
      .eq("type", "auto_revisao")
      .eq("status", "pendente"),
  ]);
  if (remainingErr) throw new Error(remainingErr.message);
  if (autoErr) throw new Error(autoErr.message);
  const docUserWithReviews = compositeKeySet(
    remainingReviews ?? [],
    (r) => `${r.document_id}|${r.self_reviewer_id}`,
  );

  const orphanAssignmentIds = (autoAssignments ?? []).flatMap((a) =>
    docUserWithReviews.has(`${a.document_id}|${a.user_id}`) ? [] : [a.id],
  );
  if (orphanAssignmentIds.length > 0) {
    const { error } = await admin
      .from("assignments")
      .delete()
      .in("id", orphanAssignmentIds);
    if (error) throw new Error(error.message);
  }
}

export async function regenerateAutoReviewBacklog(
  projectId: string,
): Promise<{
  success: boolean;
  error?: string;
  scanned?: number;
  regenerated?: number;
  removed?: number;
  keptResolved?: number;
}> {
  try {
    const gate = await requireCoordinator(
      projectId,
      "Apenas coordenadores podem regenerar o backlog.",
    );
    if (!gate.ok) return { success: false, error: gate.error };

    const admin = createSupabaseAdmin();
    const { fields, humanResponses, llmResponses, equivalences, existingReviews } =
      await fetchBacklogInputs(admin, projectId);

    if (fields.length === 0) {
      return { success: true, scanned: 0, regenerated: 0 };
    }

    // Index LLM por document_id para lookup O(1) no loop in-memory
    const llmByDocId = new Map(llmResponses.map((r) => [r.document_id, r]));
    const equivByDoc = buildEquivalenceMap(equivalences);

    const { assignmentRows, fieldReviewRows, regenerated } = computeBacklogRows(
      projectId,
      humanResponses,
      llmByDocId,
      equivByDoc,
      fields,
    );

    const { idsToDelete, keptResolved } = diffReviewsToRemove(
      existingReviews,
      fieldReviewRows,
    );

    // Defesa em profundidade: `.is("self_verdict", null)` fecha a janela TOCTOU
    // entre a leitura de `existingReviews` (fetchBacklogInputs) e este DELETE.
    // Se um pesquisador resolver um campo nesse intervalo, o DB recusa a linha
    // mesmo que o id esteja em `idsToDelete`. `.select("id")` devolve as linhas
    // efetivamente apagadas, fonte da contagem `removed` retornada.
    let actuallyRemoved = 0;
    if (idsToDelete.length > 0) {
      const { data: deleted, error } = await admin
        .from("field_reviews")
        .delete()
        .in("id", idsToDelete)
        .is("self_verdict", null)
        .select("id");
      if (error) return { success: false, error: error.message };
      actuallyRemoved = deleted?.length ?? 0;
    }

    if (assignmentRows.length > 0) {
      const { error } = await admin.from("assignments").upsert(assignmentRows, {
        onConflict: "document_id,user_id,type",
        ignoreDuplicates: true,
      });
      if (error) return { success: false, error: error.message };
    }
    if (fieldReviewRows.length > 0) {
      // NB: ignoreDuplicates reconcilia o *conjunto* de field_reviews
      // (doc+field), nao os ponteiros. Uma linha ja existente mantem seus
      // human_response_id/llm_response_id antigos mesmo que o LLM tenha
      // re-rodado desde entao — atualizar FKs stale fica fora deste reconcile.
      const { error } = await admin
        .from("field_reviews")
        .upsert(fieldReviewRows, {
          onConflict: "document_id,field_name",
          ignoreDuplicates: true,
        });
      if (error) return { success: false, error: error.message };
    }

    await removeOrphanAssignments(admin, projectId);

    revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return {
      success: true,
      scanned: humanResponses.length,
      regenerated,
      removed: actuallyRemoved,
      keptResolved,
    };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

// Re-tenta alocar árbitro para todo field_review do projeto que está pendente
// (self_verdict='contesta_llm' AND arbitrator_id IS NULL). Disparada quando o
// coordenador habilita um novo membro como elegível em setCanArbitrate, para
// drenar o backlog acumulado enquanto não havia ninguém.
//
// Agrupa por (document_id, self_reviewer_id) e chama assignArbitrator para
// cada grupo — preserva a regra "todos os campos contestados do mesmo doc
// recebem o MESMO árbitro" e a exclusão do auto-revisor original do pool.
export async function retryPendingArbitrations(
  projectId: string,
): Promise<{
  success: boolean;
  error?: string;
  assigned: number;
  stillNoPool: number;
}> {
  try {
    const gate = await requireCoordinator(
      projectId,
      "Apenas coordenadores podem reprocessar arbitragens.",
    );
    if (!gate.ok)
      return { success: false, error: gate.error, assigned: 0, stillNoPool: 0 };

    const admin = createSupabaseAdmin();
    const { data: pending, error } = await admin
      .from("field_reviews")
      .select("document_id, field_name, self_reviewer_id")
      .eq("project_id", projectId)
      .eq("self_verdict", "contesta_llm")
      .is("arbitrator_id", null);
    if (error)
      return { success: false, error: error.message, assigned: 0, stillNoPool: 0 };
    if (!pending || pending.length === 0)
      return { success: true, assigned: 0, stillNoPool: 0 };

    const groups = new Map<
      string,
      { documentId: string; selfReviewerId: string; fieldNames: string[] }
    >();
    for (const p of pending) {
      const key = `${p.document_id}|${p.self_reviewer_id}`;
      const g =
        groups.get(key) ??
        {
          documentId: p.document_id as string,
          selfReviewerId: p.self_reviewer_id as string,
          fieldNames: [] as string[],
        };
      g.fieldNames.push(p.field_name as string);
      groups.set(key, g);
    }

    // Pré-busca em batch: codificadores humanos de todos os docs pendentes
    // de uma vez. assignArbitrator originalmente faz 1 SELECT em responses
    // por chamada — em loop de N groups isso vira N queries. Centralizar
    // num único SELECT mantém a chamada O(1) em queries de responses
    // independente do tamanho do backlog.
    const allDocIds = [
      ...new Set([...groups.values()].map((g) => g.documentId)),
    ];
    const codersByDoc = new Map<string, Set<string>>();
    if (allDocIds.length > 0) {
      const { data: allCoders } = await admin
        .from("responses")
        .select("document_id, respondent_id")
        .eq("project_id", projectId)
        .in("document_id", allDocIds)
        .eq("respondent_type", "humano");
      for (const c of allCoders ?? []) {
        const docId = c.document_id as string;
        const respId = c.respondent_id as string | null;
        if (!respId) continue;
        let set = codersByDoc.get(docId);
        if (!set) {
          set = new Set<string>();
          codersByDoc.set(docId, set);
        }
        set.add(respId);
      }
    }

    // Sequencial intencionalmente: cada assignArbitrator lê openCounts
    // recalculado, preservando o balanceamento entre grupos. Paralelizar com
    // Promise.all faria todos os groups verem o mesmo minLoad e sortearem
    // dentro do mesmo pool — degrada a distribuição (mesma race tolerada em
    // submitAutoReview concorrente para docs diferentes, mas aqui evitável
    // a custo zero porque o loop está dentro de uma única chamada).
    let assigned = 0;
    let stillNoPool = 0;
    for (const g of groups.values()) {
      // Sequencial intencional (ver comentário acima): cada assignArbitrator lê
      // openCounts recalculado; paralelizar degradaria a distribuição.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await assignArbitrator(
        projectId,
        g.documentId,
        g.selfReviewerId,
        g.fieldNames,
        codersByDoc.get(g.documentId) ?? new Set<string>(),
      );
      assigned += result.count;
      if (result.noPool) stillNoPool++;
    }

    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    revalidatePath(`/projects/${projectId}/config/members`);
    return { success: true, assigned, stillNoPool };
  } catch (e) {
    return {
      success: false,
      error: errorMessage(e) || "Erro",
      assigned: 0,
      stillNoPool: 0,
    };
  }
}
