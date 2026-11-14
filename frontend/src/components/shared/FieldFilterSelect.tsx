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
  placeholder?: string;
}

// Filtro "Todos os campos" / um campo do schema, comum à Comparação, ao LLM
// Insights e aos Comentários. O valor "all" é o sem filtro.
export function FieldFilterSelect({
  value,
  onChange,
  fields,
  className,
  placeholder = "Campo",
}: FieldFilterSelectProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder} />
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
