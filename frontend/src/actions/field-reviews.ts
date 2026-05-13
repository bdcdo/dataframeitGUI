"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { SelfVerdict, ArbitrationVerdict } from "@/lib/types";

export interface SelfVerdictInput {
  fieldName: string;
  verdict: SelfVerdict;
}

// Humano original conclui sua fase de auto-revisao. Para cada campo:
//   - admite_erro  → gabarito do campo = LLM, fica resolvido
//   - contesta_llm → cai na fila de arbitragem (sorteia arbitro neste mesmo call)
//
// Idempotente: regravar a auto-revisao apos enviada nao reinicia arbitragem
// (UPDATE so toca campos com self_verdict IS NULL).
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

    for (const v of verdicts) {
      const { error } = await admin
        .from("field_reviews")
        .update({ self_verdict: v.verdict, self_reviewed_at: now })
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("field_name", v.fieldName)
        .eq("self_reviewer_id", user.id)
        .is("self_verdict", null);
      if (error) return { success: false, error: error.message };
    }

    // Marca assignment auto_revisao como concluido
    await admin
      .from("assignments")
      .update({ status: "concluido", completed_at: now })
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("user_id", user.id)
      .eq("type", "auto_revisao");

    // Para campos contestados, sorteia arbitro e cria assignment arbitragem
    const contested = verdicts
      .filter((v) => v.verdict === "contesta_llm")
      .map((v) => v.fieldName);

    let arbitrated = 0;
    if (contested.length > 0) {
      arbitrated = await assignArbitrator(projectId, documentId, user.id, contested);
    }

    revalidatePath(`/projects/${projectId}/analyze/auto-review`);
    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true, arbitrated };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro" };
  }
}

// Escolhe um arbitro (pesquisador do projeto != humano original) com balanceamento
// simples (menos arbitragens pendentes). Atualiza field_reviews.arbitrator_id
// dos campos contestados e cria 1 assignment arbitragem por documento.
//
// Retorna a quantidade de field_reviews atribuidos.
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

  // Ordena por carga ascendente; em empate, pesquisador antes de coordenador
  const sorted = [...members].sort((a, b) => {
    const la = loadByUser.get(a.user_id) ?? 0;
    const lb = loadByUser.get(b.user_id) ?? 0;
    if (la !== lb) return la - lb;
    if (a.role !== b.role) return a.role === "pesquisador" ? -1 : 1;
    return 0;
  });
  const arbitratorId = sorted[0].user_id;

  // Atualiza field_reviews dos campos contestados
  const { error: frErr } = await admin
    .from("field_reviews")
    .update({ arbitrator_id: arbitratorId })
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .in("field_name", fieldNames);
  if (frErr) throw new Error(frErr.message);

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

  return fieldNames.length;
}

export interface BlindChoice {
  fieldName: string;
  verdict: ArbitrationVerdict;
}

// Fase 1 da arbitragem: arbitro escolhe cegamente entre A/B (sem justificativa).
// Persiste blind_verdict + blind_decided_at. So aceita escrever onde
// arbitrator_id = current user e blind_verdict IS NULL (idempotencia).
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

    for (const c of choices) {
      const { error } = await supabase
        .from("field_reviews")
        .update({ blind_verdict: c.verdict, blind_decided_at: now })
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("field_name", c.fieldName)
        .eq("arbitrator_id", user.id)
        .is("blind_verdict", null);
      if (error) return { success: false, error: error.message };
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

    // Carrega field_reviews + respostas para montar comentarios.
    // Duas FKs de field_reviews para responses (human_/llm_response_id) tornam
    // o nested select ambiguo no PostgREST — buscar respostas separadamente.
    const { data: frRows, error: frErr } = await admin
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

    for (const c of choices) {
      const { error } = await supabase
        .from("field_reviews")
        .update({
          final_verdict: c.verdict,
          final_decided_at: now,
          question_improvement_suggestion: c.questionImprovementSuggestion ?? null,
          arbitrator_comment: c.arbitratorComment ?? null,
        })
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("field_name", c.fieldName)
        .eq("arbitrator_id", user.id);
      if (error) return { success: false, error: error.message };

      if (c.verdict === "llm") {
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

        await admin.from("project_comments").insert({
          project_id: projectId,
          document_id: documentId,
          field_name: c.fieldName,
          author_id: user.id,
          body,
        });
      }
    }

    // Se TODOS os field_reviews deste doc para este arbitro tem final_verdict,
    // marca assignment arbitragem como concluido
    const { data: pending } = await admin
      .from("field_reviews")
      .select("id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("arbitrator_id", user.id)
      .is("final_verdict", null)
      .limit(1);

    if (!pending || pending.length === 0) {
      await admin
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

function formatAnswer(v: unknown): string {
  if (v === null || v === undefined) return "(vazio)";
  if (typeof v === "string") return `"${v}"`;
  if (Array.isArray(v)) return `[${v.map((x) => formatAnswer(x)).join(", ")}]`;
  return JSON.stringify(v);
}
