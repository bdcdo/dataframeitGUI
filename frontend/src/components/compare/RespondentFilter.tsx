"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatModelLabel } from "@/lib/model-registry";

interface RespondentFilterProps {
  value: string;
  onChange: (value: string) => void;
  respondentNames: string[];
}

export function RespondentFilter({
  value,
  onChange,
  respondentNames,
}: RespondentFilterProps) {
  const humans = respondentNames.filter((n) => !n.includes("/"));
  const llms = respondentNames.filter((n) => n.includes("/"));

  if (respondentNames.length <= 1) return null;

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-7 w-auto gap-1 text-xs border-dashed">
        <SelectValue placeholder="Respondente" />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="all">Todos</SelectItem>
        {llms.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-xs">LLM</SelectLabel>
            {llms.map((name) => (
              <SelectItem key={name} value={name}>
                {formatModelLabel(name)}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {humans.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-xs">Humanos</SelectLabel>
            {humans.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}
