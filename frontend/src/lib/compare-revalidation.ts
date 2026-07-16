import "server-only";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { errorMessage } from "@/lib/utils";

function revalidateComparePaths(
  projectId: string,
  options: { comments?: boolean; llmInsights?: boolean },
): void {
  if (options.comments) {
    revalidatePath(`/projects/${projectId}/reviews/comments`);
  }
  if (options.llmInsights) {
    revalidatePath(`/projects/${projectId}/reviews/llm-insights`);
  }
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
}

export function scheduleCompareRevalidation(
  projectId: string,
  operation: string,
  options: { comments?: boolean; llmInsights?: boolean } = {},
): void {
  after(() => {
    try {
      revalidateComparePaths(projectId, options);
    } catch (error) {
      console.error(
        `[${operation}] falha ao revalidar após o commit: ${errorMessage(error)}`,
      );
    }
  });
}
