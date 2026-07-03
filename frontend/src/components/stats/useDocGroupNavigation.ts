import { useMemo, useState } from "react";
import type { ReviewComment } from "./comment-card-utils";

interface DocGroup {
  docId: string;
  title: string;
  comments: ReviewComment[];
}

export function useDocGroupNavigation(
  comments: ReviewComment[],
  initialDocId: string,
) {
  // Group comments by document, preserving order of first occurrence
  const docGroups = useMemo<DocGroup[]>(() => {
    const map = new Map<string, { title: string; comments: ReviewComment[] }>();
    for (const c of comments) {
      if (!map.has(c.documentId)) {
        map.set(c.documentId, { title: c.documentTitle, comments: [] });
      }
      map.get(c.documentId)!.comments.push(c);
    }
    return [...map.entries()].map(([docId, data]) => ({
      docId,
      ...data,
    }));
  }, [comments]);

  const initialIdx = Math.max(
    docGroups.findIndex((g) => g.docId === initialDocId),
    0,
  );
  const [docIndex, setDocIndex] = useState(initialIdx);

  const currentGroup = docGroups[docIndex];
  const currentDocId = currentGroup?.docId;

  return { docGroups, docIndex, setDocIndex, currentGroup, currentDocId };
}
