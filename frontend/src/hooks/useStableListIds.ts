"use client";

import { useState } from "react";
import { useResetOnKeyChange } from "./useResetOnKeyChange";
import { makeId } from "@/lib/utils";

const makeListId = () => makeId("lid");

export interface StableListIds {
  /** One stable id per item, aligned by position to the controlled list. */
  ids: string[];
  /** Drop the id at `index`. Call alongside the caller's own array removal. */
  removeIdAt: (index: number) => void;
  /**
   * Append a fresh id and return it. Call alongside the caller's own array
   * append. The return value lets a caller that tracks a selected/expanded item
   * by id point at the new row in the same handler, before the next render
   * makes `ids` observable.
   */
  appendId: () => string;
  /**
   * Move the id at `from` to `to`, so the id travels with the item instead of
   * staying on the position. Call alongside the caller's own array move: any
   * caller-side state keyed by id (selection, expansion) then survives the
   * reorder untouched.
   */
  moveId: (from: number, to: number) => void;
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
 * before the next render. The `useResetOnKeyChange` reconcile below only kicks
 * in for *external* length changes (field switch, toggling subfields, schema
 * reset), preserving the ids of positions that remain — it can't run on every
 * mutation, because `removeIdAt`/`appendId` themselves call `setIds`, which
 * (unlike a ref write) triggers its own re-render: for one render, `ids`
 * already reflects the mutation while the caller's `length` prop hasn't
 * caught up yet. Comparing `ids.length` directly against `length` in that
 * window would fabricate/drop an id; keying the reconcile on `length` itself
 * only re-fires on a real external length change.
 */
export function useStableListIds(length: number): StableListIds {
  const [ids, setIds] = useState<string[]>(() =>
    Array.from({ length }, () => makeListId())
  );

  useResetOnKeyChange(length, () => {
    setIds((cur) => Array.from({ length }, (_, i) => cur[i] ?? makeListId()));
  });

  return {
    ids,
    removeIdAt: (index) => setIds((cur) => cur.filter((_, i) => i !== index)),
    appendId: () => {
      const id = makeListId();
      setIds((cur) => [...cur, id]);
      return id;
    },
    moveId: (from, to) =>
      setIds((cur) => {
        // Espelha o splice que o caller faz nos valores. Fora de faixa devolve
        // `cur` intocado em vez de embaralhar: o reconcile é keyed em `length`,
        // que um move não altera, então um id perdido aqui não seria refeito.
        if (from === to || from < 0 || to < 0) return cur;
        if (from >= cur.length || to >= cur.length) return cur;
        const next = [...cur];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      }),
  };
}
