"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthUser, isProjectCoordinator } from "@/lib/auth";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import { resolveBlindVerdict } from "@/lib/arbitration-order";
import { revalidatePath } from "next/cache";
import type {
  PydanticField,
  SelfVerdict,
  ArbitrationVerdict,
} from "@/lib/types";

export interface SelfVerdictInput {
  fieldName: string;
  verdict: SelfVerdict;
}

// Humano original conclui sua fase de auto-revisao. Para cada campo:
//   - admite_erro  → gabarito do campo = LLM, fica resolvido
//   - contesta_llm → cai na fila de arbitragem (sorteia arbitro neste mesmo call)
//
// Idempotente: regravar a auto-revisao apos enviada nao reinicia arbitragem
// (UPDATE so toca campos com self_verdict IS NULL; assignArbitrator so olha
// para campos cujo UPDATE retornou linha).
export async function submitAutoReview(
  projectId: string,
  documentId: string,
  verdicts: SelfVerdictInput[],
): Promise<{ success: boolean; error?: string; arbitrated?: number }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const admin = createSupabaseAdmin();
    const now = new Date().toISOString();

    // UPDATE paralelo (em vez de N+1 sequencial). Cada UPDATE so toca o seu
    // proprio par (doc, field) com self_verdict ainda NULL — RETURNING ajuda
    // a saber quais campos foram efetivamente atualizados.
    const updateResults = await Promise.all(
      verdicts.map((v) =>
        admin
          .from("field_reviews")
          .update({ self_verdict: v.verdict, self_reviewed_at: now })
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("field_name", v.fieldName)
          .eq("self_reviewer_id", user.id)
          .is("self_verdict", null)
          .select("field_name"),
      ),
    );

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

    // Sorteia arbitro APENAS para campos cujo UPDATE acabou de gravar
    // contesta_llm (re-submit nao reabre arbitragem).
    const contested = verdicts
      .filter(
        (v) =>
          v.verdict === "contesta_llm" && updatedFieldNames.has(v.fieldName),
      )
      .map((v) => v.fieldName);

    let arbitrated = 0;
    if (contested.length > 0) {
      arbitrated = await assignArbitrator(
        projectId,
        documentId,
        user.id,
        contested,
      );
    }

    revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true, arbitrated };
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
// Retorna a quantidade de field_reviews efetivamente atribuidos.
async function assignArbitrator(
  projectId: string,
  documentId: string,
  excludeUserId: string,
  fieldNames: string[],
): Promise<number> {
  const admin = createSupabaseAdmin();

  // Pool: membros do projeto exceto o humano original
  const { data: members } = await admin
    .from("project_members")
    .select("user_id, role")
    .eq("project_id", projectId)
    .neq("user_id", excludeUserId);

  if (!members || members.length === 0) return 0;

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

  if (!assigned || assigned.length === 0) return 0;

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

  return assigned.length;
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
// So aceita escrever onde arbitrator_id = current user e blind_verdict IS NULL
// (idempotencia: re-submit no mesmo campo nao reabre a decisao).
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
          .is("blind_verdict", null);
      }),
    );

    for (const res of results) {
      if (res.error) return { success: false, error: res.error.message };
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

    // 1) Carrega field_reviews (arbitro ja tem SELECT pela policy
    // "Members view own field_reviews" introduzida em 020000).
    // Duas FKs de field_reviews para responses (human_/llm_response_id) tornam
    // o nested select ambiguo no PostgREST — buscar respostas separadamente.
    const { data: frRows, error: frErr } = await supabase
      .from("field_reviews")
      .select("id, field_name, human_response_id, llm_response_id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .in(
        "field_name",
        choices.map((c) => c.fieldName),
      )
      .eq("arbitrator_id", user.id);
    if (frErr) return { success: false, error: frErr.message };

    // 2) Respostas: admin porque a RLS de responses restringe leitura cross-user
    // (arbitro nao precisa ser membro do mesmo "scope" da resposta humana).
    const responseIds = new Set<string>();
    for (const r of frRows ?? []) {
      responseIds.add(r.human_response_id);
      responseIds.add(r.llm_response_id);
    }
    const { data: respRows } = await admin
      .from("responses")
      .select("id, answers")
      .in("id", Array.from(responseIds));
    const responseById = new Map(
      (respRows ?? []).map((r) => [r.id as string, r]),
    );

    const frByField = new Map(
      (frRows ?? []).map((r) => [r.field_name as string, r]),
    );

    // 3) UPDATEs em paralelo via supabase (RLS cobre "Arbitrator updates own row")
    const updateResults = await Promise.all(
      choices.map((c) =>
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
          .eq("arbitrator_id", user.id),
      ),
    );
    for (const res of updateResults) {
      if (res.error) return { success: false, error: res.error.message };
    }

    // 4) INSERTs em project_comments em batch via admin (RLS de
    // project_comments pode exigir que author_id seja membro do projeto com
    // role coordenador — admin evita atrito com policy desconhecida).
    const commentRows = choices
      .filter((c) => c.verdict === "llm")
      .map((c) => {
        const fr = frByField.get(c.fieldName);
        const humanResp = fr ? responseById.get(fr.human_response_id) : null;
        const llmResp = fr ? responseById.get(fr.llm_response_id) : null;
        const humanAnswer = formatAnswer(
          (humanResp?.answers as Record<string, unknown> | undefined)?.[
            c.fieldName
          ],
        );
        const llmAnswer = formatAnswer(
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
      await admin.from("project_comments").insert(commentRows);
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
    ]);

    if (projErr) return { success: false, error: projErr.message };
    if (humanErr) return { success: false, error: humanErr.message };
    if (llmErr) return { success: false, error: llmErr.message };

    const fields = (project?.pydantic_fields as PydanticField[]) ?? [];
    if (fields.length === 0) {
      return { success: true, scanned: 0, regenerated: 0 };
    }

    // Index LLM por document_id para lookup O(1) no loop in-memory
    const llmByDocId = new Map(
      (llmResponses ?? []).map((r) => [r.document_id as string, r]),
    );

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

      const divergent = computeDivergentFieldNames(fields, [
        {
          id: human.id,
          answers: (human.answers as Record<string, unknown>) ?? {},
        },
        {
          id: llm.id,
          answers: (llm.answers as Record<string, unknown>) ?? {},
        },
      ]);
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

function formatAnswer(v: unknown): string {
  if (v === null || v === undefined) return "(vazio)";
  if (typeof v === "string") return `"${v}"`;
  if (Array.isArray(v)) return `[${v.map((x) => formatAnswer(x)).join(", ")}]`;
  return JSON.stringify(v);
}
