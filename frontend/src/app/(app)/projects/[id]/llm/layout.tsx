import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { notFound } from "next/navigation";
import LlmNav from "@/components/llm/LlmNav";

export default async function LlmLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) notFound();

  const supabase = await createSupabaseServer();
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
    membership?.role === "coordenador" ||
    project?.created_by === user.id ||
    user.isMaster;

  if (!isCoordinator) notFound();

  return (
    <div className="flex flex-col">
      <LlmNav />
      <div className="flex-1">{children}</div>
    </div>
  );
}
