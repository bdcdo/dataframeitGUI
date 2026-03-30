"use server";

import { unstable_cache } from "next/cache";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export interface ResearcherProgress {
  completed: number;
  total: number;
  nextDeadline: string | null;
  daysUntilDeadline: number | null;
  requiredPace: number | null;
  streak: number;
  dailyAverage: number;
  activityMap: { date: string; count: number }[];
  deadlines: { date: string; pending: number; completed: number }[];
  dailyCompletions: { date: string; count: number }[];
}

export async function getResearcherProgress(
  projectId: string,
  userId: string
): Promise<ResearcherProgress> {
  return unstable_cache(
    async () => {
      const supabase = createSupabaseAdmin();

      const { data: assignments } = await supabase
        .from("assignments")
        .select("id, status, deadline, completed_at")
        .eq("project_id", projectId)
        .eq("user_id", userId);

      const all = assignments || [];
      const total = all.length;
      const completedAssignments = all.filter((a) => a.status === "concluido");
      const completed = completedAssignments.length;

      // Next deadline
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const futureDeadlines = all
        .filter((a) => a.deadline && a.status !== "concluido")
        .map((a) => a.deadline!)
        .sort();

      const nextDeadline = futureDeadlines.length > 0 ? futureDeadlines[0] : null;

      let daysUntilDeadline: number | null = null;
      if (nextDeadline) {
        const dl = new Date(nextDeadline);
        dl.setHours(0, 0, 0, 0);
        daysUntilDeadline = Math.ceil(
          (dl.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
        );
      }

      // Required pace
      const pendingWithDeadline = all.filter(
        (a) => a.status !== "concluido" && a.deadline
      ).length;
      let requiredPace: number | null = null;
      if (daysUntilDeadline !== null && daysUntilDeadline > 0) {
        const pendingBeforeDeadline = all.filter(
          (a) =>
            a.status !== "concluido" && a.deadline && a.deadline <= nextDeadline!
        ).length;
        requiredPace = Math.ceil(pendingBeforeDeadline / daysUntilDeadline);
      } else if (daysUntilDeadline !== null && daysUntilDeadline <= 0 && pendingWithDeadline > 0) {
        requiredPace = pendingWithDeadline; // overdue
      }

      // Streak: consecutive days with completions ending at today
      const completionDates = completedAssignments
        .filter((a) => a.completed_at)
        .map((a) => a.completed_at!.split("T")[0]);

      const uniqueDates = [...new Set(completionDates)].sort().reverse();

      let streak = 0;
      const checkDate = new Date(today);
      for (const dateStr of uniqueDates) {
        const d = checkDate.toISOString().split("T")[0];
        if (dateStr === d) {
          streak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else if (dateStr < d) {
          if (streak === 0) {
            checkDate.setDate(checkDate.getDate() - 1);
            if (dateStr === checkDate.toISOString().split("T")[0]) {
              streak++;
              checkDate.setDate(checkDate.getDate() - 1);
            } else {
              break;
            }
          } else {
            break;
          }
        }
      }

      // Daily average: completed / count of distinct active days
      const activeDays = new Set(completionDates).size;
      const dailyAverage = activeDays > 0 ? completed / activeDays : 0;

      // Activity map: last 365 days
      const activityCounts: Record<string, number> = {};
      for (const dateStr of completionDates) {
        activityCounts[dateStr] = (activityCounts[dateStr] || 0) + 1;
      }
      const activityMap: { date: string; count: number }[] = [];
      const mapStart = new Date(today);
      mapStart.setDate(mapStart.getDate() - 364);
      for (let d = new Date(mapStart); d <= today; d.setDate(d.getDate() + 1)) {
        const ds = d.toISOString().split("T")[0];
        activityMap.push({ date: ds, count: activityCounts[ds] || 0 });
      }

      // Deadlines grouped
      const deadlineGroups: Record<
        string,
        { pending: number; completed: number }
      > = {};
      for (const a of all) {
        if (!a.deadline) continue;
        if (!deadlineGroups[a.deadline]) {
          deadlineGroups[a.deadline] = { pending: 0, completed: 0 };
        }
        if (a.status === "concluido") {
          deadlineGroups[a.deadline].completed++;
        } else {
          deadlineGroups[a.deadline].pending++;
        }
      }
      const deadlines = Object.entries(deadlineGroups)
        .map(([date, counts]) => ({ date, ...counts }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Daily completions for chart
      const dailyCompletionCounts: Record<string, number> = {};
      for (const dateStr of completionDates) {
        dailyCompletionCounts[dateStr] =
          (dailyCompletionCounts[dateStr] || 0) + 1;
      }
      const dailyCompletions = Object.entries(dailyCompletionCounts)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      return {
        completed,
        total,
        nextDeadline,
        daysUntilDeadline,
        requiredPace,
        streak,
        dailyAverage: Math.round(dailyAverage * 10) / 10,
        activityMap,
        deadlines,
        dailyCompletions,
      };
    },
    [`researcher-progress-${projectId}-${userId}`],
    { tags: [`project-${projectId}-progress`], revalidate: 60 }
  )();
}
