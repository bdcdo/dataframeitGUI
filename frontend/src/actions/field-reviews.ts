"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthUser, isProjectCoordinator } from "@/lib/auth";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import { canonicalPair, type EquivalencePair } from "@/lib/equivalence";
import { resolveBlindVerdict } from "@/lib/arbitration-order";
import { formatAnswerTechnical } from "@/lib/format-answer";
import { revalidatePath } from "next/cache";
import type {
  PydanticField,
  SelfVerdict,
  ArbitrationVerdict,
} from "@/lib/types";

export interface SelfVerdictInput {
  fieldName: string;
  verdict: SelfVerdict;
  // Obrigatoria quando verdict='contesta_llm': o pesquisador registra por que
  // acha que sua resposta esta correta. Exibida ao arbitro na fase de revelacao.
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

    // Contestar o LLM exige justificativa — o arbitro precisa do contraponto
    // humano na fase de revelacao.
    for (const v of verdicts) {
      if (v.verdict === "contesta_llm" && !v.justification?.trim()) {
        return {
          success: false,
          error: `Campo "${v.fieldName}": justificativa obrigatória quando você contesta o LLM.`,
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
            self_justification:
              v.verdict === "contesta_llm"
                ? (v.justification?.trim() ?? null)
                : null,
          })
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("field_name", v.fieldName)
          .eq("self_reviewer_id", user.id)
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

    // Marca assignment auto_revisao como concluido
    await admin
      .from("assignments")
      .update({ status: "concluido", completed_at: now })
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("user_id", user.id)
      .eq("type", "auto_revisao");

    // Efeitos colaterais de equivalente/ambiguo precisam rodar tanto para
    // campos recem-atualizados quanto para os que JA estavam com o verdict
    // gravado — retry apos falha parcial (o UPDATE acima casa 0 linhas porque
    // self_verdict ja nao e NULL). Por isso a fonte de verdade aqui e o estado
    // real de field_reviews, nao `updatedByField`. Os efeitos sao idempotentes
    // (upsert ignoreDuplicates / check-before-insert), entao re-executar e
    // seguro.
    const sideEffectFieldNames = verdicts
      .filter((v) => v.verdict === "equivalente" || v.verdict === "ambiguo")
      .map((v) => v.fieldName);
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
        .eq("self_reviewer_id", user.id)
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
          reviewer_id: user.id,
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
        .eq("author_id", user.id);
      const alreadyCommented = new Set(
        (existingComments ?? []).map((r) => r.field_name as string),
      );

      const commentRows = ambiguousFields
        .filter((v) => !alreadyCommented.has(v.fieldName))
        .map((v) => {
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
            `Precisa de discussão para decidir o gabarito.`,
          ].join("\n\n");
          return {
            project_id: projectId,
            document_id: documentId,
            field_name: v.fieldName,
            author_id: user.id,
            body,
          };
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
    const contested = verdicts
      .filter(
        (v) =>
          v.verdict === "contesta_llm" && updatedFieldNames.has(v.fieldName),
      )
      .map((v) => v.fieldName);

    let arbitrated = 0;
    let warning: string | undefined;
    if (contested.length > 0) {
      const result = await assignArbitrator(
        projectId,
        documentId,
        user.id,
        contested,
      );
      arbitrated = result.count;
      // Pool vazio: o submit completa (self_verdict gravado) mas os campos
      // contestados ficam sem árbitro. Avisa o pesquisador para que o
      // coordenador adicione mais membros ao projeto — sem este warning, os
      // campos ficariam invisíveis em estado "aguarda_arbitragem" indefinidamente.
      if (result.noPool) {
        warning = `Não há outros membros no projeto disponíveis para arbitrar ${contested.length} campo(s) contestado(s). Peça ao coordenador para adicionar pesquisadores ao projeto.`;
      }
    }

    revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true, arbitrated, warning };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro" };
  }
}

// Escolhe um arbitro (pesquisador do projeto != humano original) com
// balanceamento por carga; em empate na menor carga, sorteia aleatoriamente
// entre os candidatos para evitar viés estrutural em projetos pequenos.
//
// Granularidade: TODOS os campos contestados deste submit recebem o MESMO
// arbitro (um por documento, nao um por campo). Intencional para coerencia —
// o arbitro ve todos os campos do mesmo doc de uma vez. A tabela
// field_reviews permite arbitros diferentes por campo, mas este caminho
// (submit unico → 1 arbitro por doc) prefere coerencia sobre granularidade.
//
// Race condition (TOCTOU): se dois submitAutoReview rodam concorrentes para
// docs diferentes, podem ler o mesmo `minLoad` e sortearem o mesmo arbitro
// — degrada o balanceamento mas nao a correcao. Tolerado para evitar custo
// de lock; em projetos com volume, a aleatoriedade entre empatados ja dilui.
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
): Promise<{ count: number; noPool: boolean }> {
  const admin = createSupabaseAdmin();

  // Pool: membros do projeto exceto o humano original
  const { data: members } = await admin
    .from("project_members")
    .select("user_id, role")
    .eq("project_id", projectId)
    .neq("user_id", excludeUserId);

  if (!members || members.length === 0) return { count: 0, noPool: true };

  // Conta arbitragens abertas por candidato (balanceamento)
  const { data: openCounts } = await admin
    .from("assignments")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("type", "arbitragem")
    .neq("status", "concluido");

  const loadByUser = new Map<string, number>();
  for (const r of openCounts ?? []) {
    loadByUser.set(r.user_id, (loadByUser.get(r.user_id) ?? 0) + 1);
  }

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

  // Atualiza arbitrator_id APENAS onde ainda nao foi definido (idempotente).
  // O .select() devolve as linhas que de fato tocamos — usamos isso para
  // decidir se criamos um assignment de arbitragem.
  const { data: assigned, error: frErr } = await admin
    .from("field_reviews")
    .update({ arbitrator_id: arbitratorId })
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .in("field_name", fieldNames)
    .is("arbitrator_id", null)
    .select("field_name");
  if (frErr) throw new Error(frErr.message);

  if (!assigned || assigned.length === 0) return { count: 0, noPool: false };

  // Cria assignment arbitragem (idempotente em doc+user+type)
  await admin.from("assignments").upsert(
    {
      project_id: projectId,
      document_id: documentId,
      user_id: arbitratorId,
      type: "arbitragem",
      status: "pendente",
    },
    { onConflict: "document_id,user_id,type", ignoreDuplicates: true },
  );

  return { count: assigned.length, noPool: false };
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
          .eq("arbitrator_id", user.id)
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
        .eq("arbitrator_id", user.id);
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
    return { success: false, error: e instanceof Error ? e.message : "Erro" };
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
      .eq("arbitrator_id", user.id);
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
            .eq("arbitrator_id", user.id)
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
        .eq("author_id", user.id);
      const alreadyCommented = new Set(
        (existingComments ?? []).map((r) => r.field_name as string),
      );

      const commentRows = llmChoices
        .filter((c) => !alreadyCommented.has(c.fieldName))
        .map((c) => {
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

          return {
            project_id: projectId,
            document_id: documentId,
            field_name: c.fieldName,
            author_id: user.id,
            body,
          };
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

    // 5) Pending check + assignment update via supabase: SELECT cabe na policy
    // "Members view own field_reviews" e UPDATE cabe na "Researchers update
    // own assignments". Sem admin aqui.
    const { data: pending } = await supabase
      .from("field_reviews")
      .select("id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("arbitrator_id", user.id)
      .is("final_verdict", null)
      .limit(1);

    if (!pending || pending.length === 0) {
      await supabase
        .from("assignments")
        .update({ status: "concluido", completed_at: now })
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("user_id", user.id)
        .eq("type", "arbitragem");
    }

    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro" };
  }
}

// Coordenador-only: varre todas as respostas humanas concluidas do projeto e
// materializa o backlog de auto-revisao + field_reviews. Usado quando a chamada
// inline em saveResponse falhou silenciosamente (ver log "[auto-review]") ou
// apos importar respostas em lote.
//
// Bulk-otimizado: 3 queries (project + humanos + LLMs) + 2 upserts em batch,
// independente do numero de respostas. Antes era N+1 (3 queries por response).
//
// Idempotente: upserts usam ignoreDuplicates em chaves unicas
// (assignments: doc+user+type; field_reviews: doc+field).
export async function regenerateAutoReviewBacklog(
  projectId: string,
): Promise<{
  success: boolean;
  error?: string;
  scanned?: number;
  regenerated?: number;
}> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();
    const isCoord = await isProjectCoordinator(supabase, projectId, user);
    if (!isCoord) {
      return {
        success: false,
        error: "Apenas coordenadores podem regenerar o backlog.",
      };
    }

    const admin = createSupabaseAdmin();

    const [
      { data: project, error: projErr },
      { data: humanResponses, error: humanErr },
      { data: llmResponses, error: llmErr },
      { data: equivalences, error: equivErr },
    ] = await Promise.all([
      admin
        .from("projects")
        .select("pydantic_fields")
        .eq("id", projectId)
        .single(),
      admin
        .from("responses")
        .select("id, document_id, respondent_id, answers")
        .eq("project_id", projectId)
        .eq("respondent_type", "humano")
        .eq("is_partial", false),
      admin
        .from("responses")
        .select("id, document_id, answers")
        .eq("project_id", projectId)
        .eq("respondent_type", "llm")
        .eq("is_current", true),
      admin
        .from("response_equivalences")
        .select("document_id, field_name, response_a_id, response_b_id")
        .eq("project_id", projectId),
    ]);

    if (projErr) return { success: false, error: projErr.message };
    if (humanErr) return { success: false, error: humanErr.message };
    if (llmErr) return { success: false, error: llmErr.message };
    if (equivErr) return { success: false, error: equivErr.message };

    const fields = (project?.pydantic_fields as PydanticField[]) ?? [];
    if (fields.length === 0) {
      return { success: true, scanned: 0, regenerated: 0 };
    }

    // Index LLM por document_id para lookup O(1) no loop in-memory
    const llmByDocId = new Map(
      (llmResponses ?? []).map((r) => [r.document_id as string, r]),
    );

    // Index equivalencias por document_id → (field_name → pares). Respeitar
    // equivalencias ja marcadas evita recriar divergencias resolvidas.
    const equivByDoc = new Map<string, Map<string, EquivalencePair[]>>();
    for (const eq of equivalences ?? []) {
      const byField =
        equivByDoc.get(eq.document_id) ?? new Map<string, EquivalencePair[]>();
      const list = byField.get(eq.field_name) ?? [];
      list.push({
        response_a_id: eq.response_a_id,
        response_b_id: eq.response_b_id,
      });
      byField.set(eq.field_name, list);
      equivByDoc.set(eq.document_id, byField);
    }

    const assignmentRows: Array<{
      project_id: string;
      document_id: string;
      user_id: string;
      type: "auto_revisao";
      status: "pendente";
    }> = [];
    const fieldReviewRows: Array<{
      project_id: string;
      document_id: string;
      field_name: string;
      human_response_id: string;
      llm_response_id: string;
      self_reviewer_id: string;
    }> = [];

    let regenerated = 0;
    const queue = humanResponses ?? [];
    for (const human of queue) {
      const llm = llmByDocId.get(human.document_id);
      if (!llm) continue;

      const divergent = computeDivergentFieldNames(
        fields,
        [
          {
            id: human.id,
            answers: (human.answers as Record<string, unknown>) ?? {},
          },
          {
            id: llm.id,
            answers: (llm.answers as Record<string, unknown>) ?? {},
          },
        ],
        equivByDoc.get(human.document_id),
      );
      if (divergent.length === 0) continue;

      regenerated++;
      assignmentRows.push({
        project_id: projectId,
        document_id: human.document_id,
        user_id: human.respondent_id,
        type: "auto_revisao",
        status: "pendente",
      });
      for (const fieldName of divergent) {
        fieldReviewRows.push({
          project_id: projectId,
          document_id: human.document_id,
          field_name: fieldName,
          human_response_id: human.id,
          llm_response_id: llm.id,
          self_reviewer_id: human.respondent_id,
        });
      }
    }

    if (assignmentRows.length > 0) {
      const { error } = await admin.from("assignments").upsert(assignmentRows, {
        onConflict: "document_id,user_id,type",
        ignoreDuplicates: true,
      });
      if (error) return { success: false, error: error.message };
    }
    if (fieldReviewRows.length > 0) {
      const { error } = await admin
        .from("field_reviews")
        .upsert(fieldReviewRows, {
          onConflict: "document_id,field_name",
          ignoreDuplicates: true,
        });
      if (error) return { success: false, error: error.message };
    }

    revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return {
      success: true,
      scanned: queue.length,
      regenerated,
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro" };
  }
}

