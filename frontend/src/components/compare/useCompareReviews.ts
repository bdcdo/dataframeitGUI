"use client";

import { useCallback, useMemo, useState } from "react";
import {
  mergeReviews,
  type ReviewsByDoc,
  type VerdictInfo,
} from "@/lib/compare-reviews";

/**
 * Vereditos da Comparação: mantém em estado apenas os deltas otimistas da
 * sessão (`overrides`) e deriva `localReviews` mesclando-os sobre a prop
 * `existingReviews` do servidor. Extraído de `ComparePage` para tirar o
 * `useState(prop)` (que disparava `no-derived-useState`) do container e fazer
 * mudanças do servidor fluírem para a UI.
 */
export function useCompareReviews(existingReviews: ReviewsByDoc): {
  localReviews: ReviewsByDoc;
  recordReview: (docId: string, fieldName: string, info: VerdictInfo) => void;
} {
  const [overrides, setOverrides] = useState<ReviewsByDoc>({});

  const localReviews = useMemo(
    () => mergeReviews(existingReviews, overrides),
    [existingReviews, overrides],
  );

  const recordReview = useCallback(
    (docId: string, fieldName: string, info: VerdictInfo) => {
      setOverrides((prev) => ({
        ...prev,
        [docId]: { ...prev[docId], [fieldName]: info },
      }));
    },
    [],
  );

  return { localReviews, recordReview };
}
