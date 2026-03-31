import { createSupabaseServer } from "@/lib/supabase/server";
import { ReviewsNav } from "@/components/reviews/ReviewsNav";
import { redirect } from "next/navigation";

export default async function ReviewsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/auth/login");

  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase
      .from("projects")
      .select("created_by")
      .eq("id", id)
      .single(),
    supabase
      .from("project_members")
      .select("role")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .single(),
  ]);

  const isCoordinator =
    membership?.role === "coordenador" || project?.created_by === user.id;

  return (
    <div className="flex flex-col">
      <ReviewsNav projectId={id} isCoordinator={isCoordinator} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
