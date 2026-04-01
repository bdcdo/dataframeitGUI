import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getResearcherProgress } from "@/actions/progress";
import { ProgressCards } from "@/components/progress/ProgressCards";
import { ActivityCalendar } from "@/components/progress/ActivityCalendar";
import { NextDeliveries } from "@/components/progress/NextDeliveries";
import { DailyPaceChart } from "@/components/progress/DailyPaceChart";

export default async function MyProgressPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ viewAsUser?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const effectiveUserId =
    user.isMaster && sp.viewAsUser ? sp.viewAsUser : user.id;

  const progress = await getResearcherProgress(id, effectiveUserId);

  return (
    <div className="space-y-6 p-6">
      <h2 className="text-lg font-semibold">Meu Progresso</h2>

      <ProgressCards
        completed={progress.completed}
        total={progress.total}
        streak={progress.streak}
        dailyAverage={progress.dailyAverage}
        requiredPace={progress.requiredPace}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border p-4">
          <ActivityCalendar activityMap={progress.activityMap} />
        </div>
        <div className="rounded-lg border p-4">
          <DailyPaceChart
            dailyCompletions={progress.dailyCompletions}
            requiredPace={progress.requiredPace}
          />
        </div>
      </div>

      <div className="rounded-lg border p-4">
        <NextDeliveries deadlines={progress.deadlines} />
      </div>
    </div>
  );
}
