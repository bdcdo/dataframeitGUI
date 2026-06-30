import "server-only";

import type { createSupabaseServer } from "@/lib/supabase/server";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import {
  computeDivergentFieldNames,
  resolveCompareStatus,
} from "@/lib/compare-divergence";
import {
  responseQualifiesForVersion,
  versionGate,
  type VersionedResponse,
} from "@/lib/compare-version";
import type { EquivalencePair } from "@/lib/equivalence";

// Recomputes assignment status (pendente / em_andamento / concluido) for the
// reviewer's "comparacao" assignment on this document, taking into account
// any equivalences registered between responses for free-text fields.
export async function syncCompareAssignment(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  projectId: string,
  documentId: string,
  userId: string,
) {
  const { data: assignment } = await supabase
    .from("assignments")
    .select("id, status")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .eq("type", "comparacao")
    .maybeSingle();

  if (!assignment) return;

  const [
    { data: project },
    { data: responses },
    { data: reviews },
    { data: equivalences },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "pydantic_fields, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .eq("id", projectId)
      .single(),
    supabase
      .from("responses")
      .select(
        "id, respondent_type, is_latest, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch, answers, answer_field_hashes",
      )
      .eq("project_id", projectId)
      .eq("document_id", documentId),
    supabase
      .from("reviews")
      .select("field_name")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("reviewer_id", userId),
    supabase
      .from("response_equivalences")
      .select("field_name, response_a_id, response_b_id")
      .eq("project_id", projectId)
      .eq("document_id", documentId),
  ]);

  const reviewedFields = new Set((reviews ?? []).map((r) => r.field_name));

  const fields = (project?.pydantic_fields as PydanticField[]) || [];

  // Conclusão usa o MESMO predicado (`responseQualifiesForVersion`, anti-drift
  // #217) e o MESMO piso de versão que a página aplica no estado DEFAULT da UI
  // — derivado de `COMPARE_DEFAULT_VERSION` (compare-filters.ts) via
  // `resolveMinVersion`, a mesma constante e função que `compare/page.tsx` usa
  // através de `compareDefaultsForMode`. O default vivo é "latest_major" (#247),
  // então `minVersion` é o `latestMajorAnchor` do projeto: o fecho considera só
  // as respostas `is_latest` da MAJOR corrente — exatamente o que a revisora vê
  // na fila default. Por construção, no estado default a visão e o fecho
  // coincidem: resolver as divergências visíveis sempre fecha o parecer.
  //
  // Codificações de majors anteriores (`is_latest`, schema antigo) e as
  // pré-versionamento (`pydantic_hash` NULL) ficam de fora do fecho E da fila —
  // "deixam de contar por padrão" (#247). Isso restaura o acoplamento
  // visão==fecho que o #218 garantia: antes, com piso `all`, o fecho contava
  // rodadas antigas que a fila `latest_major` escondia, e o parecer não fechava
  // apesar de a revisora ter resolvido tudo o que via (regressão do #217).
  // Codificações SUPERSEDED (`is_latest=false`) seguem fora, como sempre.
  //
  // Filtros efêmeros (versão manual mais larga/estreita, `since`, `respondent`)
  // são lentes de inspeção: NÃO redefinem "concluído". Se a revisora escolher
  // uma lente mais estreita que o default, a tela pode mostrar menos do que o
  // fecho exige — comportamento esperado de uma lente, fora do fluxo "default".
  // Piso `latest_major` + contexto do helper compartilhado `versionGate`
  // (compare-version.ts) — a MESMA fonte, fallback {0,1,0} e constante
  // COMPARE_DEFAULT_VERSION que o gatilho (auto-comparison.ts) usa; a página
  // deriva o contexto da mesma origem mas resolve o piso a partir da URL.
  const { minVersion, ctx: projectVersionCtx } = versionGate(project ?? {});

  type ActiveResponse = {
    id: string;
    answers: Record<string, unknown>;
    answerFieldHashes: AnswerFieldHashes;
  };
  const activeResponses: ActiveResponse[] = (responses ?? [])
    .filter((r) =>
      responseQualifiesForVersion(
        r as unknown as VersionedResponse,
        minVersion,
        projectVersionCtx,
      ),
    )
    .map((r) => ({
      id: r.id,
      answers: (r.answers ?? {}) as Record<string, unknown>,
      answerFieldHashes: r.answer_field_hashes as AnswerFieldHashes,
    }));

  // Sem ao menos 2 respostas qualificadas sob o piso corrente não há PAR a
  // comparar — então não há divergência a "resolver". Aqui o conjunto vazio/único
  // faria `computeDivergentFieldNames` devolver [] e o status virar "concluido",
  // marcando como revisado um doc que ninguém comparou na versão corrente (ex.:
  // doc só com codificações pré-versionamento, ou cujas rodadas antigas caíram
  // abaixo do piso após um bump estrutural). Preserva o status atual: a fila
  // default também não mostra o doc (filtro de mín. humanos), então o assignment
  // fica fora de vista sem fechar à toa. "concluido" continua reservado para o
  // caso legítimo de ≥2 respostas cujas divergências foram todas resolvidas/fundidas
  // (#217). Não regride um assignment já concluído nem reabre — só evita o fecho
  // espúrio.
  if (activeResponses.length < 2) return;

  const equivalencesByField = new Map<string, EquivalencePair[]>();
  for (const eq of equivalences ?? []) {
    if (!equivalencesByField.has(eq.field_name)) {
      equivalencesByField.set(eq.field_name, []);
    }
    equivalencesByField.get(eq.field_name)!.push({
      response_a_id: eq.response_a_id,
      response_b_id: eq.response_b_id,
    });
  }

  const divergentFields = computeDivergentFieldNames(
    fields,
    activeResponses,
    equivalencesByField,
  );

  // `resolveCompareStatus` trata o caso `divergentFields.length === 0` (ex.:
  // todas as divergências fundidas por equivalência): vira `concluido` em vez de
  // ficar preso. Atualiza só quando o status muda, limpando `completed_at` em
  // qualquer regressão (ex.: desmarcar uma equivalência reabre a divergência).
  const next = resolveCompareStatus(divergentFields, reviewedFields);
  if (assignment.status !== next) {
    await supabase
      .from("assignments")
      .update({
        status: next,
        completed_at: next === "concluido" ? new Date().toISOString() : null,
      })
      .eq("id", assignment.id);
  }
}
