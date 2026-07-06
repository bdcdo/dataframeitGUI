import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  resolveReviewComment,
  reopenReviewComment,
  resolveDifficulty,
  reopenDifficulty,
} from "@/actions/stats";
import type { ReviewComment } from "./comment-card-utils";

export function useCommentResolution(projectId: string) {
  const { refresh } = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleResolve = (comment: ReviewComment) => {
    startTransition(async () => {
      let result;
      if (comment.source === "dificuldade" && comment.difficultyResponseId) {
        result = await resolveDifficulty(
          projectId,
          comment.difficultyResponseId,
          comment.difficultyDocumentId!,
        );
      } else {
        result = await resolveReviewComment(comment.id, projectId);
      }
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Comentário resolvido");
        refresh();
      }
    });
  };

  const handleReopen = (comment: ReviewComment) => {
    startTransition(async () => {
      let result;
      if (comment.source === "dificuldade" && comment.difficultyResponseId) {
        result = await reopenDifficulty(projectId, comment.difficultyResponseId);
      } else {
        result = await reopenReviewComment(comment.id, projectId);
      }
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Comentário reaberto");
        refresh();
      }
    });
  };

  return { isPending, handleResolve, handleReopen };
}
