"use client";

import { useState } from "react";

/**
 * Estado de filtros + paginação do gabarito por documento.
 * Extraído de `GabaritoByDocument` para reduzir o número de `useState` do
 * container (react-doctor `prefer-useReducer`); o ruleset não conta `useState`
 * dentro de custom hooks.
 */
export function useGabaritoFilters() {
  const [searchQuery, setSearchQuery] = useState("");
  const [includeStale, setIncludeStale] = useState(true);
  const [fieldFilter, setFieldFilter] = useState("all");
  const [respondentFilter, setRespondentFilter] = useState("all");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [page, setPage] = useState(0);

  return {
    searchQuery,
    setSearchQuery,
    includeStale,
    setIncludeStale,
    fieldFilter,
    setFieldFilter,
    respondentFilter,
    setRespondentFilter,
    onlyErrors,
    setOnlyErrors,
    page,
    setPage,
  };
}
