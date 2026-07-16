import { createSupabaseServer } from "@/lib/supabase/server";
import { getProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { RoundsConfig } from "@/components/config/RoundsConfig";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import type { Round, RoundStrategy } from "@/lib/types";
import { versionLabel } from "@/lib/rounds";

export default async function RoundsConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user, supabase] = await Promise.all([
    params,
    requirePageAuthUser(),
    createSupabaseServer(),
  ]);

  const [{ data: project }, { data: rounds }, accessResult] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "round_strategy, current_round_id, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .eq("id", id)
      .single(),
    supabase
      .from("rounds")
      .select("id, project_id, label, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
    getProjectAccessContext(id, user),
  ]);

  const { isCoordinator } = requireResolvedProjectAccess(accessResult);

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
