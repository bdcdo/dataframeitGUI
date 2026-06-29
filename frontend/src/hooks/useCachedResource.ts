"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Núcleo de cache-por-chave compartilhado pelos lazy-loaders do app
 * (`useDocumentText`, `useDocumentForCoding`, `useBrowseDocuments`). Captura, num
 * só lugar, o padrão antes triplicado: cache em `useState`, `useEffect` que só
 * faz `setState` ASSÍNCRONO no `.then`/`.catch` (nada de `setState` síncrono em
 * effect — é o que mantém o react-doctor zerado), `loading` derivado no render e
 * flag `cancelled` no cleanup para descartar fetch obsoleto.
 *
 * Política de erro (intencionalmente simples): o genérico só cacheia valores
 * RESOLVIDOS. Uma rejeição do `fetcher` vira a flag `error` (sem cachear). Um
 * caller que prefira "erro como valor" (ex.: `null` ou um sentinel) faz o
 * `catch` no próprio `fetcher` e devolve esse valor — assim a rejeição nunca
 * chega aqui e o `error` permanece `false`.
 *
 * `maxEntries` (opt-in) limita o cache: ao inserir uma chave nova acima do teto,
 * despeja a mais antiga por ORDEM DE INSERÇÃO (FIFO). Reabrir uma chave em cache
 * não renova sua posição (não é LRU-por-acesso, que exigiria escrita em tempo de
 * render); o tradeoff é um eventual refetch de uma chave reaberta após despejo.
 * Sem `maxEntries`, o cache não tem teto (ok para conjuntos limitados como docs
 * atribuídos; quem percorre conjunto aberto — o browse — deve passar um teto).
 *
 * Contrato de `data` (tri-state, sempre lido junto de `loading`):
 *  - `undefined`: nada pedido (`!enabled`/`key` nulo) OU fetch em andamento;
 *  - valor `T` cacheado (inclui valores "falsy" como `null`, distinguidos de
 *    "não cacheado" via `key in entries`): resolvido.
 *
 * IMPORTANTE: `fetcher` DEVE ser estável (envolver em `useCallback` no caller),
 * pois entra nas deps do effect.
 */
interface CacheStore<T> {
  entries: Record<string, T>;
  /** Chaves em ordem de inserção, para o despejo FIFO quando há `maxEntries`. */
  order: string[];
}

function insertCapped<T>(
  prev: CacheStore<T>,
  key: string,
  value: T,
  maxEntries?: number,
): CacheStore<T> {
  const entries = { ...prev.entries, [key]: value };
  let order = prev.order.includes(key) ? prev.order : [...prev.order, key];
  if (maxEntries && order.length > maxEntries) {
    const evicted = order.slice(0, order.length - maxEntries);
    order = order.slice(order.length - maxEntries);
    for (const k of evicted) delete entries[k];
  }
  return { entries, order };
}

function removeKey<T>(prev: CacheStore<T>, key: string): CacheStore<T> {
  if (!(key in prev.entries)) return prev;
  const entries = { ...prev.entries };
  delete entries[key];
  return { entries, order: prev.order.filter((k) => k !== key) };
}

/** Remove uma chave de um `Record<string, V>` imutavelmente (no-op se ausente). */
export function deleteKey<V>(
  record: Record<string, V>,
  key: string,
): Record<string, V> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function useCachedResource<T>(
  key: string | null | undefined,
  fetcher: (key: string) => Promise<T>,
  options?: { enabled?: boolean; maxEntries?: number },
): {
  data: T | undefined;
  loading: boolean;
  error: boolean;
  invalidate: (key: string) => void;
  retry: () => void;
} {
  const enabled = options?.enabled ?? true;
  const maxEntries = options?.maxEntries;

  const [store, setStore] = useState<CacheStore<T>>({ entries: {}, order: [] });
  const [errors, setErrors] = useState<Record<string, true>>({});

  useEffect(() => {
    if (!enabled || !key || key in store.entries || errors[key]) return;
    let cancelled = false;
    fetcher(key)
      .then((value) => {
        if (cancelled) return;
        setStore((prev) => insertCapped(prev, key, value, maxEntries));
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("useCachedResource: fetch failed:", e);
        setErrors((prev) => ({ ...prev, [key]: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, store, errors, fetcher, maxEntries]);

  const invalidate = useCallback((k: string) => {
    setStore((prev) => removeKey(prev, k));
    setErrors((prev) => deleteKey(prev, k));
  }, []);

  // Limpa cache+erro da chave CORRENTE para que o effect refaça o fetch.
  const retry = useCallback(() => {
    if (!key) return;
    setStore((prev) => removeKey(prev, key));
    setErrors((prev) => deleteKey(prev, key));
  }, [key]);

  const data = useMemo(
    () => (enabled && key && key in store.entries ? store.entries[key] : undefined),
    [enabled, key, store],
  );
  const error = enabled && !!key && !!errors[key];
  const loading =
    enabled && !!key && !(key in store.entries) && !errors[key];

  return { data, loading, error, invalidate, retry };
}
