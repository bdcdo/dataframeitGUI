import { createSupabaseServer } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import {
  fetchReviewBaseData,
  computeHardestDocuments,
} from "@/lib/reviews/queries";
import { HardestDocuments } from "@/components/reviews/HardestDocuments";

export default async function DifficultyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const ctx = await fetchReviewBaseData(supabase, id);
  const hardestDocuments = computeHardestDocuments(ctx);

  if (hardestDocuments.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nenhum dado de dificuldade disponível. Revise documentos na aba Comparar
        para gerar dados.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-4">
      <HardestDocuments hardestDocuments={hardestDocuments} projectId={id} />
    </div>
  );
}
