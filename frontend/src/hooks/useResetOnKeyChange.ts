"use client";

import { useState } from "react";

/**
 * Runs `onKeyChange` once, during render, whenever `key` differs from its
 * value on the previous render — React's documented "adjusting state when a
 * prop changes" pattern, generalized so callers don't each re-derive it.
 *
 * A `useRef` mirror can't stand in for the `prevKey` state here: refs may
 * not be read/written in a component/hook body outside effects or handlers
 * (`react-hooks/refs`). A `useEffect`-based reset would instead fire one
 * render *after* `key` changes, painting a stale frame first.
 */
export function useResetOnKeyChange(
  key: string | number,
  onKeyChange: () => void
) {
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    onKeyChange();
  }
}
