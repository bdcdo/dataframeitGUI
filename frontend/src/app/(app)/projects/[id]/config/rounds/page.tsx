import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { RoundsConfig } from "@/components/config/RoundsConfig";
import type { Round, RoundStrategy } from "@/lib/types";
import { versionLabel } from "@/lib/rounds";

export default async function RoundsConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const supabase = await createSupabaseServer();

  const [{ data: project }, { data: rounds }, { data: membership }] =
    await Promise.all([
      supabase
        .from("projects")
        .select(
          "round_strategy, current_round_id, schema_version_major, schema_version_minor, schema_version_patch, created_by",
        )
        .eq("id", id)
        .single(),
      supabase
        .from("rounds")
        .select("id, project_id, label, created_at")
        .eq("project_id", id)
        .order("created_at", { ascending: true }),
      supabase
        .from("project_members")
        .select("role")
        .eq("project_id", id)
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

  const isCoordinator =
    project?.created_by === user.id ||
    membership?.role === "coordenador";

  const currentVersion = versionLabel({
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  });

  return (
    <div className="mx-auto max-w-3xl p-6">
      <RoundsConfig
        projectId={id}
        strategy={(project?.round_strategy as RoundStrategy) ?? "schema_version"}
        currentRoundId={project?.current_round_id ?? null}
        currentVersion={currentVersion}
        rounds={(rounds ?? []) as Round[]}
        isCoordinator={isCoordinator}
      />
    </div>
  );
}
