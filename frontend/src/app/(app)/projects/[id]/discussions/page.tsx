import { createSupabaseServer } from "@/lib/supabase/server";
import { DiscussionsList, type DiscussionItem } from "@/components/discussions/DiscussionsList";
import type { Profile } from "@/lib/types";

export default async function DiscussionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;
  const supabase = await createSupabaseServer();

  // Fetch discussions (with embedded comment count) and documents in parallel
  const [{ data: rawDiscussions }, { data: documents }] = await Promise.all([
    supabase
      .from("discussions")
      .select(
        "id, title, body, status, created_at, document_id, created_by, profiles(first_name, last_name, email), documents(title, external_id), discussion_comments(count)"
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
  ]);

  const discussions: DiscussionItem[] = (rawDiscussions ?? []).map((d) => ({
    ...d,
    profiles: d.profiles as unknown as Pick<Profile, "first_name" | "last_name" | "email">,
    documents: d.documents as unknown as { title: string | null; external_id: string | null } | null,
    comment_count: (d.discussion_comments as unknown as { count: number }[])?.[0]?.count || 0,
  }));

  return (
    <DiscussionsList
      projectId={projectId}
      discussions={discussions}
      documents={documents ?? []}
    />
  );
}
