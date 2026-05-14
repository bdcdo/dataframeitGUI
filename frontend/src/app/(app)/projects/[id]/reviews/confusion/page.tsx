import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  fetchReviewBaseData,
  computeConfusionData,
} from "@/lib/reviews/queries";
import { ConfusionMatrix } from "@/components/reviews/ConfusionMatrix";
import { TruncationBanner } from "@/components/reviews/TruncationBanner";

export default async function ConfusionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const supabase = await createSupabaseServer();

  const ctx = await fetchReviewBaseData(supabase, id);
  const confusionDataList = computeConfusionData(ctx);

  if (confusionDataList.length === 0) {
    return (
      <div className="mx-auto max-w-5xl p-6 space-y-4">
        <TruncationBanner truncated={ctx.truncated} />
        <p className="py-12 text-center text-sm text-muted-foreground">
          Nenhum dado de confusão disponível. Revise documentos na aba Comparar
          para gerar dados.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-4">
      <TruncationBanner truncated={ctx.truncated} />
      <ConfusionMatrix confusionDataList={confusionDataList} />
    </div>
  );
}
