"use client";

import { useState } from "react";

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
 *
 * State (not refs) holds the ids, mirroring `length` in `prevLength` per
 * React's "adjusting state when a prop changes" pattern. A ref-mutation
 * reconcile would misfire here: `removeIdAt`/`appendId` call `setIds`, which
 * (unlike a ref write) triggers its own re-render — for one render, `ids`
 * already reflects the mutation while the caller's `length` prop hasn't
 * caught up yet. Comparing directly against `length` in that window would
 * fabricate a spurious id; the `prevLength` mirror only advances on a real
 * external length change.
 */
export function useStableListIds(length: number): StableListIds {
  const [ids, setIds] = useState<string[]>(() =>
    Array.from({ length }, () => makeId())
  );
  const [prevLength, setPrevLength] = useState(length);

  if (length !== prevLength) {
    setPrevLength(length);
    setIds((cur) => Array.from({ length }, (_, i) => cur[i] ?? makeId()));
  }

  return {
    ids,
    removeIdAt: (index) => setIds((cur) => cur.filter((_, i) => i !== index)),
    appendId: () => setIds((cur) => [...cur, makeId()]),
  };
}
