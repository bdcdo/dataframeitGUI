"use client";


interface CompareFilterProps {
  value: string;
  onChange: (value: string) => void;
  fields: { name: string; description: string }[];
}

export function CompareFilter({ value, onChange, fields }: CompareFilterProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border bg-background px-2 py-1 text-sm"
    >
      <option value="all">Todos os campos</option>
      <option value="alta">Só ALTA prioridade</option>
      {fields.map((f) => (
        <option key={f.name} value={f.name}>{f.description}</option>
      ))}
    </select>
  );
}
