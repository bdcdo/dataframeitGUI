import { createSupabaseServer } from "@/lib/supabase/server";
import { DiscussionDetail } from "@/components/discussions/DiscussionDetail";
import { notFound } from "next/navigation";
import type { Profile } from "@/lib/types";

export default async function DiscussionDetailPage({
  params,
}: {
  params: Promise<{ id: string; discussionId: string }>;
}) {
  const { id: projectId, discussionId } = await params;
  const supabase = await createSupabaseServer();

  // Fetch discussion with author and linked document
  const { data: discussion } = await supabase
    .from("discussions")
    .select(
      "id, title, body, status, created_at, document_id, profiles(first_name, last_name, email), documents(title, external_id)"
    )
    .eq("id", discussionId)
    .eq("project_id", projectId)
    .single();

  if (!discussion) notFound();

  // Fetch comments with author profiles
  const { data: comments } = await supabase
    .from("discussion_comments")
    .select("id, body, created_at, profiles(first_name, last_name, email)")
    .eq("discussion_id", discussionId)
    .order("created_at", { ascending: true });

  // Check if current user is coordinator
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let isCoordinator = false;
  if (user) {
    const { data: membership } = await supabase
      .from("project_members")
      .select("role")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .single();

    isCoordinator = membership?.role === "coordenador";
  }

  return (
    <DiscussionDetail
      projectId={projectId}
      discussion={{
        ...discussion,
        profiles: discussion.profiles as unknown as Pick<Profile, "first_name" | "last_name" | "email">,
        documents: discussion.documents as unknown as { title: string | null; external_id: string | null } | null,
      }}
      comments={
        (comments ?? []).map((c) => ({
          ...c,
          profiles: c.profiles as unknown as Pick<Profile, "first_name" | "last_name" | "email">,
        }))
      }
      isCoordinator={isCoordinator}
    />
  );
}
