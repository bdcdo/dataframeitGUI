"use client";

import { useCallback, useState } from "react";
import { usePinnedDocNavigation } from "@/hooks/usePinnedDoc";

interface ReviewQueueDoc {
  docId: string;
}

export function useReviewQueueNavigation<TDoc extends ReviewQueueDoc>(
  storageKey: string,
  docs: readonly TDoc[],
) {
  const { docIndex, navigateToIndex } = usePinnedDocNavigation(storageKey, docs);
  const [listCollapsed, setListCollapsed] = useState(false);

  const toggleList = useCallback(() => {
    setListCollapsed((collapsed) => !collapsed);
  }, []);

  return {
    docIndex,
    listCollapsed,
    navigate: navigateToIndex,
    toggleList,
  };
}
