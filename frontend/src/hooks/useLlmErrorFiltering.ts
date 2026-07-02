"use client";

import { useState, useMemo, useEffect } from "react";

export type DatePreset = "all" | "24h" | "7d" | "30d";
export type SortBy = "default" | "field" | "document" | "recent";

// Campos mínimos que os filtros de escopo consultam (numerador e denominador).
interface ScopeFilterable {
  fieldName: string;
  documentTitle: string;
  reviewedAt: string;
  schemaVersion: string | null;
}

interface FilterableError extends ScopeFilterable {
  fieldDescription: string;
  resolvedAt: string | null;
}

function presetCutoffMs(preset: DatePreset, now: number): number | null {
  if (preset === "24h") return now - 24 * 3600_000;
  if (preset === "7d") return now - 7 * 24 * 3600_000;
  if (preset === "30d") return now - 30 * 24 * 3600_000;
  return null;
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return db - da;
  }
  return 0;
}

// Estado dos 6 filtros + ordenação da lista de erros do LLM, junto com toda a
// derivação (população filtrada, taxa de erro, ordenação, contagem de abertos).
// Extraído de LlmInsightsView (#355): pura relocação de estado e derivação.
export function useLlmErrorFiltering<
  E extends FilterableError,
  R extends ScopeFilterable,
>(errors: E[], reviewedEntries: R[]) {
  const [errorFieldFilter, setErrorFieldFilter] = useState("all");
  const [errorSearchQuery, setErrorSearchQuery] = useState("");
  const [errorStatusFilter, setErrorStatusFilter] = useState("open");
  const [errorDateFilter, setErrorDateFilter] = useState<DatePreset>("all");
  const [errorSinceDate, setErrorSinceDate] = useState("");
  const [errorVersionFilter, setErrorVersionFilter] = useState("all");
  const [sortBy, setSortBy] = useState<SortBy>("default");

  // Tick the "now" reference once a minute so the "Últimas 24h/7d/30d"
  // cutoff doesn't freeze on long-open pages. State (rather than a raw
  // Date.now() in render) keeps the component pure per React rules.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Derived from the full reviewed population so a version with 0 errors is
  // still selectable — useful for "0% rate" sanity checks.
  const availableVersions = useMemo(() => {
    const set = new Set<string>();
    for (const r of reviewedEntries) if (r.schemaVersion) set.add(r.schemaVersion);
    return Array.from(set).toSorted(compareSemverDesc);
  }, [reviewedEntries]);

  // Derive the effective version filter: if the selected version is no
  // longer present (status filter toggled, all errors of that version
  // resolved, etc.) treat it as "all" instead of letting the stale value
  // zero out the list with no UI to fix it. Derivation in render avoids
  // a setState-in-effect cascade.
  const effectiveVersionFilter = availableVersions.includes(errorVersionFilter)
    ? errorVersionFilter
    : "all";

  const sinceMs = errorSinceDate
    ? new Date(errorSinceDate + "T00:00:00").getTime()
    : presetCutoffMs(errorDateFilter, now);

  // Scope filters affect both numerator and denominator (so the rate matches
  // the population the user is looking at). Status only affects which errors
  // the user wants to see in the list and in the card.
  const matchesScopeFilters = (e: ScopeFilterable): boolean => {
    if (errorFieldFilter !== "all" && e.fieldName !== errorFieldFilter)
      return false;
    if (
      errorSearchQuery &&
      !e.documentTitle
        .toLowerCase()
        .includes(errorSearchQuery.toLowerCase())
    )
      return false;
    if (sinceMs && new Date(e.reviewedAt).getTime() < sinceMs) return false;
    if (
      effectiveVersionFilter !== "all" &&
      e.schemaVersion !== effectiveVersionFilter
    )
      return false;
    return true;
  };

  const filteredReviewed = reviewedEntries.filter(matchesScopeFilters);

  const filteredErrors = errors.filter((e) => {
    if (errorStatusFilter === "open" && e.resolvedAt) return false;
    if (errorStatusFilter === "resolved" && !e.resolvedAt) return false;
    return matchesScopeFilters(e);
  });

  // Rate uses the same numerator shown in the card (so the two are always
  // consistent) over the scope-filtered reviewed population.
  const filteredErrorRate =
    filteredReviewed.length > 0
      ? Math.round((filteredErrors.length / filteredReviewed.length) * 100)
      : 0;

  const sortedErrors = (() => {
    if (sortBy === "default") return filteredErrors;
    const arr = [...filteredErrors];
    if (sortBy === "field") {
      arr.sort((a, b) => {
        const fa = a.fieldDescription.localeCompare(b.fieldDescription, "pt-BR");
        if (fa !== 0) return fa;
        return a.documentTitle.localeCompare(b.documentTitle, "pt-BR");
      });
    } else if (sortBy === "document") {
      arr.sort((a, b) =>
        a.documentTitle.localeCompare(b.documentTitle, "pt-BR"),
      );
    } else if (sortBy === "recent") {
      arr.sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
    }
    return arr;
  })();

  // Counted within the current scope so the badge matches the cards.
  const openErrorCount = errors.filter(
    (e) => !e.resolvedAt && matchesScopeFilters(e),
  ).length;

  return {
    errorFieldFilter,
    setErrorFieldFilter,
    errorSearchQuery,
    setErrorSearchQuery,
    errorStatusFilter,
    setErrorStatusFilter,
    errorDateFilter,
    setErrorDateFilter,
    errorSinceDate,
    setErrorSinceDate,
    setErrorVersionFilter,
    sortBy,
    setSortBy,
    availableVersions,
    effectiveVersionFilter,
    filteredErrors,
    filteredErrorRate,
    sortedErrors,
    openErrorCount,
  };
}

export type LlmErrorFiltering = ReturnType<typeof useLlmErrorFiltering>;
