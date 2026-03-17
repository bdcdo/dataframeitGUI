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

  // Fetch discussions with author profiles, linked documents, and comment counts
  const { data: rawDiscussions } = await supabase
    .from("discussions")
    .select(
      "id, title, body, status, created_at, document_id, created_by, profiles(first_name, last_name, email), documents(title, external_id)"
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  // Count comments per discussion
  const discussionIds = (rawDiscussions ?? []).map((d) => d.id);
  let commentCounts: Record<string, number> = {};

  if (discussionIds.length > 0) {
    const { data: counts } = await supabase
      .from("discussion_comments")
      .select("discussion_id")
      .in("discussion_id", discussionIds);

    if (counts) {
      for (const c of counts) {
        commentCounts[c.discussion_id] = (commentCounts[c.discussion_id] || 0) + 1;
      }
    }
  }

  const discussions: DiscussionItem[] = (rawDiscussions ?? []).map((d) => ({
    ...d,
    profiles: d.profiles as unknown as Pick<Profile, "first_name" | "last_name" | "email">,
    documents: d.documents as unknown as { title: string | null; external_id: string | null } | null,
    comment_count: commentCounts[d.id] || 0,
  }));

  // Fetch documents for the combobox in the create dialog
  const { data: documents } = await supabase
    .from("documents")
    .select("id, title, external_id")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  return (
    <DiscussionsList
      projectId={projectId}
      discussions={discussions}
      documents={documents ?? []}
    />
  );
}
