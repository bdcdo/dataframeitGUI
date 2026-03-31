import { createSupabaseServer } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import {
  fetchReviewBaseData,
  computeReviewedDocuments,
} from "@/lib/reviews/queries";
import { GabaritoByDocument } from "@/components/reviews/GabaritoByDocument";

export default async function GabaritoPage({
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
  const reviewedDocuments = computeReviewedDocuments(ctx);

  if (reviewedDocuments.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nenhuma revisão encontrada. Comece revisando documentos na aba Comparar.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <GabaritoByDocument
        reviewedDocuments={reviewedDocuments}
        fields={ctx.comparableFields}
        projectId={id}
      />
    </div>
  );
}
