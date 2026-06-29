"use client";

import { useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

type SetOptions = { method?: "replace" | "push"; scroll?: boolean };

/**
 * Leitura e escrita de search params da URL sem navegação completa.
 *
 * `get(key)` lê via `useSearchParams` (já é a subscription reativa do Next, não
 * gera `set-state-in-effect`). `set(updates, opts)` constrói a query a partir da
 * atual, aplica os updates (`null` remove o param) e navega com
 * `router.replace`/`router.push`. O 2º argumento de navegação só é passado
 * quando `scroll` é definido — assim, omitir `scroll` reproduz exatamente o
 * default do Next (preserva o comportamento dos call sites migrados).
 *
 * Requer um boundary de `Suspense` no componente (regra
 * `nextjs-no-use-search-params-without-suspense`) — todos os consumidores atuais
 * já estão sob Suspense.
 */
export function useUrlState(): {
  get: (key: string) => string | null;
  set: (updates: Record<string, string | null>, opts?: SetOptions) => void;
} {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const get = useCallback(
    (key: string) => searchParams.get(key),
    [searchParams],
  );

  const set = useCallback(
    (updates: Record<string, string | null>, opts?: SetOptions) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      const url = `${pathname}${qs ? `?${qs}` : ""}`;
      const navFn = opts?.method === "push" ? router.push : router.replace;
      if (opts?.scroll === undefined) navFn(url);
      else navFn(url, { scroll: opts.scroll });
    },
    [searchParams, router, pathname],
  );

  return { get, set };
}

/**
 * Especialização de `useUrlState` para o param `doc` (replace + `scroll:false`),
 * usado em várias páginas data-heavy.
 */
export function useDocParam(): [string | null, (docId: string | null) => void] {
  const { get, set } = useUrlState();
  const docId = get("doc");
  const setDocId = useCallback(
    (id: string | null) => set({ doc: id }, { scroll: false }),
    [set],
  );
  return [docId, setDocId];
}
