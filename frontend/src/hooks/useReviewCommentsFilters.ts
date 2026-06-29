"use client";

import { useState } from "react";

/**
 * Estado dos filtros da lista de comentários de revisão (campo, status,
 * verdict, busca). Extraído de `ReviewCommentsView` para reduzir o número de
 * `useState` do container (react-doctor `prefer-useReducer`); o ruleset não
 * conta `useState` dentro de custom hooks. Os estados de modal (edição,
 * sugestão, split) permanecem no componente.
 */
export function useReviewCommentsFilters() {
  const [fieldFilter, setFieldFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [verdictFilter, setVerdictFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  return {
    fieldFilter,
    setFieldFilter,
    statusFilter,
    setStatusFilter,
    verdictFilter,
    setVerdictFilter,
    searchQuery,
    setSearchQuery,
  };
}
