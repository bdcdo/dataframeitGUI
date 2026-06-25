"use client";

import { Card, CardContent } from "@/components/ui/card";

interface CsvDropzoneProps {
  onFile: (file: File) => void;
}

export function CsvDropzone({ onFile }: CsvDropzoneProps) {
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  return (
    <Card
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      className="border-dashed"
    >
      <CardContent className="flex flex-col items-center gap-2 py-8">
        <p className="text-sm text-muted-foreground">Arraste um CSV ou clique para selecionar</p>
        <input
          type="file"
          accept=".csv"
          aria-label="Selecionar arquivo CSV"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="text-sm"
        />
      </CardContent>
    </Card>
  );
}
