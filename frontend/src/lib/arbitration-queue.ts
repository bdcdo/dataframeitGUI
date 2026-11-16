import type { SupabaseServerClient } from "@/lib/supabase/server";

// A fila de arbitragem (analyze/arbitragem/page.tsx) mostra o documento que
// passa nas duas regras abaixo, e a aba (analyze/layout.tsx) só aparece quando
// as duas têm linha. O banco deveria manter uma em sincronia com a outra, mas
// não mantém em todo caminho: o fechamento do assignment conta campo de ciclo
// superado, e tirar a permissão de arbitrar apaga o assignment sem tocar em
// field_reviews.

// Assignment de arbitragem ainda aberto, de documento que não foi excluído nem
// está com exclusão pendente.
export function openArbitrationAssignmentsQuery(
  client: SupabaseServerClient,
  projectId: string,
  userId: string,
) {
  return client
    .from("assignments")
    .select(
      "id, document_id, documents!inner(excluded_at, exclusion_pending_at)",
    )
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .eq("type", "arbitragem")
    .neq("status", "concluido")
    .is("documents.excluded_at", null)
    .is("documents.exclusion_pending_at", null);
}

// Campo contestado do ciclo corrente, ainda sem veredito final, com este
// árbitro. `columns` é `string`, e não literal, porque a fila e a aba pedem
// projeções diferentes; quem lê as linhas declara o tipo delas.
export function pendingArbitrationFieldsQuery(
  client: SupabaseServerClient,
  projectId: string,
  userId: string,
  columns: string,
) {
  return client
    .from("field_reviews")
    .select(columns)
    .eq("project_id", projectId)
    .eq("arbitrator_id", userId)
    .eq("self_verdict", "contesta_llm")
    .is("superseded_at", null)
    .is("final_verdict", null);
}

// O mesmo, só de documento que a fila mostra: é o que a aba confere.
export function pendingArbitrationFieldProbe(
  client: SupabaseServerClient,
  projectId: string,
  userId: string,
) {
  return pendingArbitrationFieldsQuery(
    client,
    projectId,
    userId,
    "id, documents!inner(excluded_at, exclusion_pending_at)",
  )
    .is("documents.excluded_at", null)
    .is("documents.exclusion_pending_at", null);
}
