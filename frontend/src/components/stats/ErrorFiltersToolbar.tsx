"use client";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { DatePreset, SortBy } from "@/hooks/useLlmErrorFiltering";

interface ErrorFiltersToolbarProps {
  fields: { name: string; description: string }[];
  errorSearchQuery: string;
  setErrorSearchQuery: (v: string) => void;
  errorFieldFilter: string;
  setErrorFieldFilter: (v: string) => void;
  errorStatusFilter: string;
  setErrorStatusFilter: (v: string) => void;
  errorDateFilter: DatePreset;
  setErrorDateFilter: (v: DatePreset) => void;
  errorSinceDate: string;
  setErrorSinceDate: (v: string) => void;
  availableVersions: string[];
  effectiveVersionFilter: string;
  setErrorVersionFilter: (v: string) => void;
  sortBy: SortBy;
  setSortBy: (v: SortBy) => void;
  sortedCount: number;
  openErrorCount: number;
}

export function ErrorFiltersToolbar({
  fields,
  errorSearchQuery,
  setErrorSearchQuery,
  errorFieldFilter,
  setErrorFieldFilter,
  errorStatusFilter,
  setErrorStatusFilter,
  errorDateFilter,
  setErrorDateFilter,
  errorSinceDate,
  setErrorSinceDate,
  availableVersions,
  effectiveVersionFilter,
  setErrorVersionFilter,
  sortBy,
  setSortBy,
  sortedCount,
  openErrorCount,
}: ErrorFiltersToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="Buscar documento..."
        value={errorSearchQuery}
        onChange={(e) => setErrorSearchQuery(e.target.value)}
        className="w-56"
      />
      <Select value={errorFieldFilter} onValueChange={setErrorFieldFilter}>
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Campo" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todos os campos</SelectItem>
          {fields.map((f) => (
            <SelectItem key={f.name} value={f.name}>
              {f.description || f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={errorStatusFilter} onValueChange={setErrorStatusFilter}>
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="open">Abertos</SelectItem>
          <SelectItem value="resolved">Resolvidos</SelectItem>
          <SelectItem value="all">Todos</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={errorDateFilter}
        onValueChange={(v) => {
          setErrorDateFilter(v as DatePreset);
          setErrorSinceDate("");
        }}
      >
        <SelectTrigger className="w-36" title="Data de criação da revisão">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Qualquer data</SelectItem>
          <SelectItem value="24h">Últimas 24h</SelectItem>
          <SelectItem value="7d">Últimos 7 dias</SelectItem>
          <SelectItem value="30d">Últimos 30 dias</SelectItem>
        </SelectContent>
      </Select>
      <Input
        type="date"
        value={errorSinceDate}
        onChange={(e) => {
          setErrorSinceDate(e.target.value);
          if (e.target.value) setErrorDateFilter("all");
        }}
        className="w-40"
        title="Apenas revisões criadas a partir desta data"
      />
      {availableVersions.length > 0 && (
        <Select
          value={effectiveVersionFilter}
          onValueChange={setErrorVersionFilter}
        >
          <SelectTrigger className="w-36" title="Versão do schema">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as versões</SelectItem>
            {availableVersions.map((v) => (
              <SelectItem key={v} value={v}>
                v{v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
        <SelectTrigger className="w-44" title="Ordenar por">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Ordem padrão</SelectItem>
          <SelectItem value="field">Por pergunta (A→Z)</SelectItem>
          <SelectItem value="document">Por documento (A→Z)</SelectItem>
          <SelectItem value="recent">Mais recentes primeiro</SelectItem>
        </SelectContent>
      </Select>
      <span className="ml-auto text-sm text-muted-foreground">
        {sortedCount} erro{sortedCount !== 1 ? "s" : ""}
        {openErrorCount > 0 && (
          <Badge variant="destructive" className="ml-1.5">
            {openErrorCount} aberto{openErrorCount !== 1 ? "s" : ""}
          </Badge>
        )}
      </span>
    </div>
  );
}
