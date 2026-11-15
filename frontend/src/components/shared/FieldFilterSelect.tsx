"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface FieldFilterSelectProps {
  value: string;
  onChange: (value: string) => void;
  fields: { name: string; description: string }[];
  /** Classes do gatilho: cada tela tem a sua largura e densidade. */
  className?: string;
}

// Filtro "Todos os campos" / um campo do schema, comum à Comparação, ao LLM
// Insights, aos Comentários, ao gabarito e ao histórico do schema. O valor
// "all" é o sem filtro, então sempre há um valor visível no gatilho; o
// aria-label diz ao leitor de tela o que ele filtra.
export function FieldFilterSelect({
  value,
  onChange,
  fields,
  className,
}: FieldFilterSelectProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className} aria-label="Filtrar por campo">
        <SelectValue />
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
  );
}
