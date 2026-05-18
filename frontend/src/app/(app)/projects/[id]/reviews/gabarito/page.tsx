import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  fetchReviewBaseData,
  computeReviewedDocuments,
} from "@/lib/reviews/queries";
import { GabaritoByDocument } from "@/components/reviews/GabaritoByDocument";
import { TruncationBanner } from "@/components/reviews/TruncationBanner";

export default async function GabaritoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user, supabase] = await Promise.all([
    params,
    getAuthUser(),
    createSupabaseServer(),
  ]);
  if (!user) redirect("/auth/login");

  const ctx = await fetchReviewBaseData(supabase, id);
  const reviewedDocuments = computeReviewedDocuments(ctx);

  if (reviewedDocuments.length === 0) {
    return (
      <div className="mx-auto max-w-5xl p-6 space-y-4">
        <TruncationBanner truncated={ctx.truncated} />
        <p className="py-12 text-center text-sm text-muted-foreground">
          Nenhuma revisão encontrada. Comece revisando documentos na aba
          Comparar.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-4">
      <TruncationBanner truncated={ctx.truncated} />
      <GabaritoByDocument
        reviewedDocuments={reviewedDocuments}
        fields={ctx.comparableFields}
        projectId={id}
      />
    </div>
  );
}
