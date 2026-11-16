import { createSupabaseServer } from "@/lib/supabase/server";
import {
  getProjectAccessContext,
  resolveProjectQueueIdentity,
} from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import {
  ArbitrationPage,
  type ArbitrationDoc,
  type ArbitrationField,
} from "@/components/arbitration/ArbitrationPage";
import { assignOrder } from "@/lib/arbitration-order";
import {
  openArbitrationAssignmentsQuery,
  pendingArbitrationFieldsQuery,
} from "@/lib/arbitration-queue";
import { fetchProfileNames, withProfileNames } from "@/lib/respondent-names";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import {
  buildReviewQueueDocumentMap,
  loadReviewQueueRows,
} from "@/lib/review-queue";
import {
  fetchAllAfterId,
  fetchByDocumentChunks,
} from "@/lib/supabase/fetch-all-paged";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";

// Server-side A/B embaralhamento da fase cega — o navegador nunca recebe os
// labels humano/llm enquanto blind_verdict IS NULL. Quando blind ja foi decidido,
// montamos o payload `reveal` com aSide/bSide + nomes + justificativa para a
// fase 2 trabalhar normalmente.

interface ArbitrationFieldReviewRow {
  id: string;
  document_id: string;
  field_name: string;
  human_response_id: string;
  llm_response_id: string;
  human_answer_snapshot: unknown;
  llm_answer_snapshot: unknown;
  llm_justification_snapshot: unknown;
  blind_verdict: string | null;
  self_justification: string | null;
}

interface ArbitrationResponseRow {
  id: string;
  respondent_type: string;
  respondent_id: string | null;
  respondent_name: string | null;
}

function buildArbitrationField(
  fr: ArbitrationFieldReviewRow,
  humanName: string | null,
  llmName: string | null,
): ArbitrationField {
  const humanAnswer = fr.human_answer_snapshot;
  const llmAnswer = fr.llm_answer_snapshot;

  const order = assignOrder(fr.id);
  const aSide: ArbitrationVerdict = order === "human_first" ? "humano" : "llm";
  const bSide: ArbitrationVerdict = order === "human_first" ? "llm" : "humano";
  const aAnswer = order === "human_first" ? humanAnswer : llmAnswer;
  const bAnswer = order === "human_first" ? llmAnswer : humanAnswer;
  const blindVerdict = (fr.blind_verdict as ArbitrationVerdict | null) ?? null;

  return {
    fieldReviewId: fr.id,
    fieldName: fr.field_name,
    aAnswer,
    bAnswer,
    blindVerdict,
    reveal:
      blindVerdict !== null
        ? {
            aSide,
            bSide,
            humanName,
            llmName,
            llmJustification:
              typeof fr.llm_justification_snapshot === "string"
                ? fr.llm_justification_snapshot
                : null,
            selfJustification: fr.self_justification ?? null,
          }
        : null,
  };
}

export default async function ArbitrationRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ viewAsUser?: string }>;
}) {
  const [{ id }, sp, user, supabase] = await Promise.all([
    params,
    searchParams,
    requirePageAuthUser(),
    createSupabaseServer(),
  ]);

  // Fila 100% pessoal: pertence à identidade EFETIVA (impersonação master via
  // ?viewAsUser= ou conta-alias por e-mail vinculado), como no Codificar/Comparação.
  // Com user.id cru, o master "visualizando como" via a própria fila (vazia).
  const access = requireResolvedProjectAccess(
    await getProjectAccessContext(id, user),
  );
  const { queueUserId } = resolveProjectQueueIdentity(access, sp.viewAsUser);

  const [{ data: project }, assignmentsRead, profileNames] =
    await Promise.all([
      supabase
        .from("projects")
        .select("pydantic_fields, name, arbitration_blind")
        .eq("id", id)
        .single(),
      fetchAllAfterId<{ id: string; document_id: string }>(() =>
        openArbitrationAssignmentsQuery(supabase, id, queueUserId),
      ),
      fetchProfileNames(supabase, id),
    ]);
  // Leitura que falha derruba a página em vez de abrir a fila vazia, como na
  // auto-revisão (P3).
  if (assignmentsRead.error) {
    throw new Error(
      `Não foi possível carregar a fila de arbitragem: ${assignmentsRead.error.message}`,
    );
  }

  // Sem repetição: o mesmo documento em dois lotes traria os campos dele duas
  // vezes.
  const docIds = Array.from(
    new Set(assignmentsRead.data.map((a) => a.document_id)),
  );
  const { documents: docs, fieldReviews } = await loadReviewQueueRows(
    supabase,
    docIds,
    (ids) =>
      fetchAllAfterId<ArbitrationFieldReviewRow>(() =>
        pendingArbitrationFieldsQuery(
          supabase,
          id,
          queueUserId,
          "id, document_id, field_name, human_response_id, llm_response_id, human_answer_snapshot, llm_answer_snapshot, llm_justification_snapshot, blind_verdict, self_justification",
        )
          .in("document_id", ids)
          // A projeção é `string`: o tipo da linha é declarado aqui.
          .returns<ArbitrationFieldReviewRow[]>() as never,
      ),
    // O documento com assignment aberto e sem campo pendente sai da fila.
    { onlyDocumentsWithReviews: true },
  );

  const responseIdSet = new Set<string>();
  for (const fr of fieldReviews) {
    responseIdSet.add(fr.human_response_id);
    responseIdSet.add(fr.llm_response_id);
  }
  // Em lotes pelo mesmo motivo dos documentos: são dois ids por campo.
  const responsesRead = await fetchByDocumentChunks(
    Array.from(responseIdSet),
    (ids) =>
      fetchAllAfterId<ArbitrationResponseRow>(() =>
        supabase
          .from("responses")
          .select("id, respondent_type, respondent_id, respondent_name")
          .in("id", ids),
      ),
  );
  if (responsesRead.error) {
    throw new Error(
      `Não foi possível carregar a fila de arbitragem: ${responsesRead.error.message}`,
    );
  }
  const responses = responsesRead.data;

  const responsesById = new Map(
    withProfileNames(responses, profileNames).map((r) => [r.id, r]),
  );

  const docMap = buildReviewQueueDocumentMap<ArbitrationField>(docs);

  for (const fr of fieldReviews) {
    const payload = docMap.get(fr.document_id);
    if (!payload) continue;
    const human = responsesById.get(fr.human_response_id);
    const llm = responsesById.get(fr.llm_response_id);

    payload.fields.push(
      buildArbitrationField(
        fr,
        human?.respondent_name ?? null,
        llm?.respondent_name ?? null,
      ),
    );
  }

  const arbitratableDocs: ArbitrationDoc[] = Array.from(docMap.values()).filter(
    (d) => d.fields.length > 0,
  );

  return (
    <ArbitrationPage
      projectId={id}
      projectName={project?.name ?? ""}
      fields={(project?.pydantic_fields as PydanticField[]) ?? []}
      docs={arbitratableDocs}
      arbitrationBlind={project?.arbitration_blind ?? true}
    />
  );
}
