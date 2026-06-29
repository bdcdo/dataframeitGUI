"use client";

import { useState } from "react";

export type DatePreset = "all" | "24h" | "7d" | "30d";
export type SortBy = "default" | "field" | "document" | "recent";

/**
 * Estado dos filtros e ordenação da lista de erros do LLM Insights. Extraído de
 * `LlmInsightsView` para reduzir o número de `useState` do container (react-doctor
 * `prefer-useReducer`); o ruleset não conta `useState` dentro de custom hooks.
 */
export function useLlmInsightsFilters() {
  const [errorFieldFilter, setErrorFieldFilter] = useState("all");
  const [errorSearchQuery, setErrorSearchQuery] = useState("");
  const [errorStatusFilter, setErrorStatusFilter] = useState("open");
  const [errorDateFilter, setErrorDateFilter] = useState<DatePreset>("all");
  const [errorSinceDate, setErrorSinceDate] = useState("");
  const [errorVersionFilter, setErrorVersionFilter] = useState("all");
  const [sortBy, setSortBy] = useState<SortBy>("default");

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
    errorVersionFilter,
    setErrorVersionFilter,
    sortBy,
    setSortBy,
  };
}
