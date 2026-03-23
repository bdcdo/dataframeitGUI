"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface CompareFieldFilterProps {
  value: string;
  onChange: (value: string) => void;
  fields: { name: string; description: string }[];
}

export function CompareFieldFilter({ value, onChange, fields }: CompareFieldFilterProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-[200px] text-xs">
        <SelectValue placeholder="Filtrar campos" />
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
