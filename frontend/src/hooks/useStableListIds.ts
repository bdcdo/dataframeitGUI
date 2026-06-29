"use client";

import { useRef } from "react";

// crypto.randomUUID is only exposed in secure contexts (HTTPS/localhost); fall
// back so a dev server reached over a plain-http LAN IP doesn't crash editing.
const makeId = () =>
  crypto.randomUUID?.() ?? `lid-${Math.random().toString(36).slice(2)}`;

export interface StableListIds {
  /** One stable id per item, aligned by position to the controlled list. */
  ids: string[];
  /** Drop the id at `index`. Call alongside the caller's own array removal. */
  removeIdAt: (index: number) => void;
  /** Append a fresh id. Call alongside the caller's own array append. */
  appendId: () => void;
}

/**
 * Stable React keys for a *controlled* editable list whose external contract is
 * a plain `T[]` (no ids of its own). The component owns the values; this hook
 * owns a parallel array of ids aligned by position, so removing/reordering an
 * item in the middle doesn't leak input state (focus/cursor) between rows via
 * index keys (`no-array-index-as-key`).
 *
 * Mutations go through the caller's own handlers: call `removeIdAt`/`appendId`
 * together with the value mutation + `onChange`, so ids and values stay aligned
 * before the next render. The render-time reconcile below only kicks in for
 * *external* length changes (field switch, toggling subfields, schema reset),
 * preserving the ids of positions that remain.
 */
export function useStableListIds(length: number): StableListIds {
  const idsRef = useRef<string[]>([]);

  if (idsRef.current.length !== length) {
    const cur = idsRef.current;
    idsRef.current = Array.from({ length }, (_, i) => cur[i] ?? makeId());
  }

  const handlers = useRef<Pick<StableListIds, "removeIdAt" | "appendId">>({
    removeIdAt: (index) => {
      idsRef.current = idsRef.current.filter((_, i) => i !== index);
    },
    appendId: () => {
      idsRef.current = [...idsRef.current, makeId()];
    },
  });

  return {
    ids: idsRef.current,
    removeIdAt: handlers.current.removeIdAt,
    appendId: handlers.current.appendId,
  };
}
