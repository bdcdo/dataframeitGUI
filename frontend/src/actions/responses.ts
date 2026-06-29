"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, getEffectiveMemberId } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import { dropHiddenConditionals } from "@/lib/conditional";
import { isCodingComplete } from "@/lib/coding-completeness";
import { createAutoReviewIfDiverges } from "@/lib/auto-review";
import { createAutoComparisonIfDiverges } from "@/lib/auto-comparison";
import type { PydanticField } from "@/lib/types";

export interface SaveResponseOpts {
  notes?: string;
  isAutoSave?: boolean;
}

export async function saveResponse(
  projectId: string,
  documentId: string,
  answers: Record<string, unknown>,
  opts: SaveResponseOpts = {},
): Promise<{ success: boolean; error?: string }> {
  const { notes, isAutoSave = false } = opts;
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    // Identidade de trabalho no projeto (spec 002): conta vinculada codifica
    // como o membro canônico — respondent_id, assignments e auto-review usam
    // sempre o id efetivo.
    const effectiveId = await getEffectiveMemberId(projectId);

    const supabase = await createSupabaseServer();

    // Fetch profile, existing response, and project config in parallel.
    // O lookup de existing filtra is_latest: após uma unificação de membros o
    // conjunto fundido pode ter respostas antigas (is_latest=false) no mesmo
    // documento — .single() sem o filtro erraria com múltiplas linhas.
    const [{ data: profile }, { data: existing }, { data: project, error: projErr }] = await Promise.all([
      supabase
        .from("profiles")
        .select("first_name, last_name")
        .eq("id", effectiveId)
        .single(),
      supabase
        .from("responses")
        .select("id, is_partial")
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("respondent_id", effectiveId)
        .eq("respondent_type", "humano")
        .eq("is_latest", true)
        .maybeSingle(),
      supabase
        .from("projects")
        .select(
          "pydantic_hash, pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch, round_strategy, current_round_id, automation_mode",
        )
        .eq("id", projectId)
        .single(),
    ]);

    if (projErr) return { success: false, error: projErr.message };

    const respondentName = [profile?.first_name, profile?.last_name]
      .filter(Boolean)
      .join(" ") || user.email;

    const justifications = notes ? { _notes: notes } : null;

    // Build per-field hash snapshot for staleness detection
    const fields = (project?.pydantic_fields as PydanticField[]) || [];
    const answerFieldHashes: Record<string, string> = {};
    for (const f of fields) {
      if (f.hash) answerFieldHashes[f.name] = f.hash;
    }

    // Drop values of fields whose visibility condition is not satisfied —
    // prevents orphaned answers from earlier trigger values ending up in the
    // persisted payload. Ponto-fixo compartilhado com o clean de leitura
    // (getDocumentForCoding / code/page.tsx) — ver #252.
    const sanitizedAnswers = dropHiddenConditionals(fields, answers);

    const roundIdToPersist =
      project?.round_strategy === "manual"
        ? (project?.current_round_id ?? null)
        : null;

    // Para humanos is_partial e mutavel: auto-save grava true (segue como
    // current_pending em classifyDocStatus) e submit explicito grava false.
    // Excecao: auto-save em response ja submetida (is_partial=false) NAO
    // rebaixa o sinal — combinado com o guard que preserva assignment.status
    // = "concluido", esse rebaixamento faria um doc ja concluido reaparecer
    // como pendente em classifyDocStatus. A imutabilidade descrita na migration
    // 20260425000000 vale so para o fluxo LLM.
    const isPartialToWrite =
      isAutoSave && existing?.is_partial !== false;

    const responsePayload = {
      answers: sanitizedAnswers,
      justifications,
      pydantic_hash: project?.pydantic_hash ?? null,
      answer_field_hashes: answerFieldHashes,
      schema_version_major: project?.schema_version_major ?? 0,
      schema_version_minor: project?.schema_version_minor ?? 1,
      schema_version_patch: project?.schema_version_patch ?? 0,
      version_inferred_from: "live_save",
      round_id: roundIdToPersist,
      is_partial: isPartialToWrite,
      // Marca a codificacao do pesquisador no tempo — alimenta a ordenacao
      // "codificados recentemente" da navegacao da aba Codificar (issue #108).
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const { error: updateErr } = await supabase
        .from("responses")
        .update(responsePayload)
        .eq("id", existing.id);
      if (updateErr) return { success: false, error: updateErr.message };
    } else {
      const { error: insertErr } = await supabase.from("responses").insert({
        project_id: projectId,
        document_id: documentId,
        respondent_id: effectiveId,
        respondent_type: "humano",
        respondent_name: respondentName,
        is_latest: true,
        ...responsePayload,
      });
      if (insertErr) return { success: false, error: insertErr.message };
    }

    if (fields.length > 0) {
      // Definição única de "codificação completa" — ver lib/coding-completeness.
      // O mesmo helper gateia o backlog de auto-revisão (issue #174).
      const allAnswered = isCodingComplete(fields, sanitizedAnswers);

      // Auto-save nunca promove para "concluido" — mesmo que todos os campos
      // estejam preenchidos, o pesquisador ainda nao clicou em Enviar. Sem essa
      // guarda, sair da pagina dispara visibilitychange -> saveResponse -> doc
      // some da lista no filtro padrao por virar current_done.
      if (allAnswered && !isAutoSave) {
        const { error: assignErr } = await supabase
          .from("assignments")
          .update({ status: "concluido", completed_at: new Date().toISOString() })
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("user_id", effectiveId)
          .eq("type", "codificacao");
        if (assignErr) return { success: false, error: assignErr.message };

        // Dispara a automacao do projeto ao submeter, conforme automation_mode.
        // Falhas nao bloqueiam o submit do pesquisador — o coordenador pode
        // regenerar o backlog manualmente (regenerateAutoReviewBacklog /
        // retryPendingComparisons). "none" nao dispara nada.
        const mode = project?.automation_mode;
        try {
          if (mode === "auto_review_llm") {
            await createAutoReviewIfDiverges(projectId, documentId, effectiveId);
          } else if (mode === "compare_humans") {
            await createAutoComparisonIfDiverges(projectId, documentId, "compare_humans");
          } else if (mode === "compare_llm") {
            await createAutoComparisonIfDiverges(projectId, documentId, "compare_llm");
          }
        } catch (err) {
          // Log estruturado JSON — mesmo formato dos demais eventos das libs de
          // automacao, facilita grep "[auto-review]" / "[auto-compare]" nos logs.
          const prefix = mode === "auto_review_llm" ? "[auto-review]" : "[auto-compare]";
          console.error(
            `${prefix} ${JSON.stringify({
              event: "inline_call_failed",
              mode,
              projectId,
              documentId,
              userId: effectiveId,
              error: err instanceof Error ? err.message : String(err),
            })}`,
          );
        }
      } else {
        // So regredir se NAO esta concluido (evita desfazer progresso por auto-save)
        const { data: currentAssignment } = await supabase
          .from("assignments")
          .select("status")
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("user_id", effectiveId)
          .eq("type", "codificacao")
          .maybeSingle();

        if (currentAssignment && currentAssignment.status !== "concluido") {
          const { error: assignErr } = await supabase
            .from("assignments")
            .update({ status: "em_andamento", completed_at: null })
            .eq("project_id", projectId)
            .eq("document_id", documentId)
            .eq("user_id", effectiveId)
            .eq("type", "codificacao");
          if (assignErr) return { success: false, error: assignErr.message };
        }
      }
    }

    // Auto-save nao revalida o RSC tree — evita re-fetch do servidor a cada
    // troca de aba / navegacao entre docs e qualquer flicker residual no
    // formulario. Submit explicito (handleSubmit / handleBrowseSubmit) revalida
    // normalmente, propagando o efeito para Compare, Reviews e o progresso.
    if (!isAutoSave) {
      revalidatePath(`/projects/${projectId}/analyze/code`);
      revalidatePath(`/projects/${projectId}/analyze/compare`);
      revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
      revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
      revalidatePath(`/projects/${projectId}/reviews`);
      revalidateTag(`project-${projectId}-progress`, { expire: 60 });
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}
