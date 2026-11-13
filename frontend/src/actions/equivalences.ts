"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { resolveProjectMemberActor } from "@/lib/auth";
import { syncCompareAssignment } from "@/lib/compare-sync";
import {
  propagateValueEquivalenceChange,
  type ValueEquivalenceChange,
} from "@/lib/value-equivalence-effects";
import {
  fetchFieldAnswers,
  fetchProjectValueEquivalences,
} from "@/lib/value-equivalence-query";
import { affectedValueKeys } from "@/lib/equivalence";
import {
  equivalenceUsageByClass,
  type UsageDocument,
} from "@/lib/value-equivalence-usage";
import { errorMessage } from "@/lib/utils";
import { ZeroRowsError } from "@/lib/supabase/rls-guard";
import type { ResponseSnapshotEntry } from "@/actions/reviews";
import { copiedVerdictInDomain, OUT_OF_DOMAIN_VOTE_MESSAGE } from "@/lib/review-validity";
import { fetchFieldDefinition } from "@/lib/reviews/field-definition";

// A equivalência "=" é de VALOR (`value_equivalences`): marcar respostas como
// equivalentes grava "no campo X, na versão atual da pergunta, estes valores
// são a mesma resposta", e isso vale no projeto inteiro. As RPCs tiram os
// valores das próprias respostas e o hash do schema atual; o cliente só diz
// quais respostas o revisor fundiu.

type EquivalenceSource = "comparacao" | "llm_insights";

interface EquivalenceCell {
  projectId: string;
  documentId: string;
  fieldName: string;
  reviewerId: string;
  source: EquivalenceSource;
}

// Uma linha por resposta além da primeira, todas ligadas a ela: basta para o
// fecho transitivo, e o banco ignora o par de valores que já existe.
function equivalenceRows(
  anchorId: string,
  responseIds: readonly string[],
  cell: EquivalenceCell,
) {
  const others = [...new Set(responseIds)].filter((id) => id !== anchorId);
  return others.map((otherId) => ({
    project_id: cell.projectId,
    document_id: cell.documentId,
    field_name: cell.fieldName,
    response_a_id: anchorId,
    response_b_id: otherId,
    reviewer_id: cell.reviewerId,
    source: cell.source,
  }));
}

// A equivalência vale no projeto inteiro: os outros documentos com os mesmos
// valores são reconciliados e ressincronizados depois da resposta ao clique.
function schedulePropagation(projectId: string, change: ValueEquivalenceChange) {
  after(() => propagateValueEquivalenceChange({ projectId, changes: [change] }));
}

function revalidateEquivalenceViews(projectId: string) {
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  revalidatePath(`/projects/${projectId}/reviews/llm-insights`);
  revalidatePath(`/projects/${projectId}/reviews/equivalencias`);
}

// Marks two or more responses as equivalent for a field and at the same time
// records the verdict pointing to `gabaritoId` — the response that represents
// the canonical answer in the database. Idempotent: a value pair that already
// exists is ignored by the RPC.
export interface ConfirmEquivalentVerdictInput {
  projectId: string;
  documentId: string;
  fieldName: string;
  responseIds: string[];
  gabaritoId: string;
  verdictDisplay: string;
  comment?: string;
  responseSnapshot?: ResponseSnapshotEntry[];
}

export async function confirmEquivalentVerdict({
  projectId,
  documentId,
  fieldName,
  responseIds,
  gabaritoId,
  verdictDisplay,
  comment,
  responseSnapshot,
}: ConfirmEquivalentVerdictInput): Promise<{ error?: string }> {
  if (responseIds.length < 2) {
    return { error: "Marcar como equivalentes exige 2+ respostas." };
  }
  if (!responseIds.includes(gabaritoId)) {
    return { error: "Gabarito precisa estar na lista de respostas selecionadas." };
  }

  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { error: actor.error };
  const reviewerId = actor.memberUserId;

  const supabase = await createSupabaseServer();

  // O veredito copia a resposta do gabarito: fora das opções atuais, nasceria
  // sem validade, como no voto em card de `submitVerdict`. A recusa vem antes
  // de gravar a equivalência, para não deixá-la sem o veredito que a motivou.
  if (!copiedVerdictInDomain(verdictDisplay, await fetchFieldDefinition(supabase, projectId, fieldName))) {
    return { error: OUT_OF_DOMAIN_VOTE_MESSAGE };
  }

  const rows = equivalenceRows(gabaritoId, responseIds, {
    projectId, documentId, fieldName, reviewerId, source: "comparacao",
  });

  try {
    const { error: equivErr } = await supabase.rpc("record_value_equivalences", { p_rows: rows });
    if (equivErr) throw new Error(equivErr.message);

    const { error: reviewErr } = await supabase.from("reviews").upsert(
      {
        project_id: projectId,
        document_id: documentId,
        field_name: fieldName,
        reviewer_id: reviewerId,
        verdict: verdictDisplay,
        chosen_response_id: gabaritoId,
        comment: comment || null,
        response_snapshot: responseSnapshot ?? null,
      },
      {
        onConflict: "project_id,document_id,field_name,reviewer_id",
      },
    );
    if (reviewErr) throw new Error(reviewErr.message);
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao marcar equivalentes." };
  }

  // Pós-commit best-effort: a equivalência e o review já foram gravados. Uma
  // falha do sync não deve virar { error } (o client refaria uma escrita já
  // persistida). O documento atual sincroniza já, para a fila de quem clicou
  // refletir o voto; os demais documentos com os mesmos valores, depois da
  // resposta.
  try {
    await syncCompareAssignment(supabase, projectId, documentId, reviewerId);
  } catch (e) {
    console.error(
      `[confirmEquivalentVerdict] falha ao sincronizar o assignment: ${errorMessage(e)}`,
    );
  }
  schedulePropagation(projectId, { fieldName, responseIds });

  revalidateEquivalenceViews(projectId);
  return {};
}

// Lightweight variant for the LLM Insights tab: registers that the LLM value
// and the reviewer-chosen value are equivalent, without touching the existing
// review row (the verdict already points to `chosenResponseId` and remains
// valid). The page recomputes errors with the project's value equivalences.
export async function markLlmEquivalent(
  projectId: string,
  documentId: string,
  fieldName: string,
  llmResponseId: string,
  chosenResponseId: string,
): Promise<{ error?: string }> {
  if (llmResponseId === chosenResponseId) {
    return { error: "Respostas já são as mesmas." };
  }

  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { error: actor.error };
  const reviewerId = actor.memberUserId;

  const supabase = await createSupabaseServer();
  const rows = equivalenceRows(chosenResponseId, [llmResponseId], {
    projectId, documentId, fieldName, reviewerId, source: "llm_insights",
  });

  try {
    const { error } = await supabase.rpc("record_value_equivalences", { p_rows: rows });
    if (error) throw new Error(error.message);
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao marcar equivalentes." };
  }

  schedulePropagation(projectId, { fieldName, responseIds: [llmResponseId, chosenResponseId] });
  revalidateEquivalenceViews(projectId);
  return {};
}

// Desfaz uma equivalência de valor no projeto inteiro. Não apaga veredito
// nenhum (decisão de produto, 20261112120000): o voto num valor continua
// válido depois da separação, e só o agrupamento muda daqui em diante. O
// documento cujo campo volta a divergir sem veredito volta à fila pela
// ressincronização.
//
// `documentId`, quando quem desfaz está num documento (a Comparação), faz o
// assignment de quem clicou nesse documento refletir a mudança já; os demais
// documentos e revisores vêm na propagação, depois da resposta.
export async function unmarkEquivalencePair(
  projectId: string,
  equivalenceId: string,
  documentId?: string,
): Promise<{ error?: string }> {
  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { error: actor.error };

  const supabase = await createSupabaseServer();
  let fieldName: string;
  let valueKeys: Set<string>;

  try {
    // A classe ANTES da remoção é onde a divergência pode reaparecer; depois
    // dela, os valores já estão separados.
    const equivalences = await fetchProjectValueEquivalences(supabase, projectId);
    if (equivalences.error) throw new Error(equivalences.error.message);
    const target = equivalences.data.find((row) => row.id === equivalenceId);
    if (!target) {
      throw new ZeroRowsError(
        "value_equivalences",
        "delete",
        "Equivalência não encontrada ou sem permissão para removê-la.",
      );
    }
    const field = await fetchFieldDefinition(supabase, projectId, target.field_name);
    valueKeys = affectedValueKeys(equivalences.data, field, [target.value_a, target.value_b]);

    const { data, error } = await supabase.rpc("remove_value_equivalence", {
      p_project_id: projectId,
      p_equivalence_id: equivalenceId,
    });
    if (error) throw new Error(error.message);

    // Conjunto vazio significa linha inexistente OU autoridade que não bate: a
    // RPC não distingue, e nenhum dos dois é sucesso. Sem este guard a action
    // retornaria `{}` sobre nada removido e a revisora veria "desfeito" — o
    // sucesso falso do #178.
    const row = (data as Array<{ field_name: string | null }> | null)?.[0];
    if (!row?.field_name) {
      throw new ZeroRowsError(
        "value_equivalences",
        "delete",
        "Equivalência não encontrada ou sem permissão para removê-la.",
      );
    }
    fieldName = row.field_name;
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao desfazer equivalência." };
  }

  if (documentId) {
    try {
      await syncCompareAssignment(supabase, projectId, documentId, actor.memberUserId);
    } catch (e) {
      console.error(
        `[unmarkEquivalencePair] falha ao sincronizar o assignment: ${errorMessage(e)}`,
      );
    }
  }
  schedulePropagation(projectId, { fieldName, valueKeys });
  revalidateEquivalenceViews(projectId);
  return {};
}

export type { UsageDocument as EquivalenceUsageDocument } from "@/lib/value-equivalence-usage";

// "Onde se aplica", sob demanda por campo na aba Equivalências: por classe de
// equivalência, os documentos em que ela funde respostas vigentes dadas à
// versão atual da pergunta. Lê só o valor do campo, com o client do membro
// (RLS de leitura do projeto).
export async function loadEquivalenceUsage(
  projectId: string,
  fieldName: string,
): Promise<{ usage?: Record<string, UsageDocument[]>; error?: string }> {
  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { error: actor.error };

  const supabase = await createSupabaseServer();
  try {
    const [answers, equivalences, field] = await Promise.all([
      fetchFieldAnswers(supabase, projectId, fieldName),
      fetchProjectValueEquivalences(supabase, projectId),
      fetchFieldDefinition(supabase, projectId, fieldName),
    ]);
    if (answers.error) throw new Error(answers.error.message);
    if (equivalences.error) throw new Error(equivalences.error.message);
    return { usage: equivalenceUsageByClass(answers.data, equivalences.data, field) };
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao carregar onde a equivalência se aplica." };
  }
}
