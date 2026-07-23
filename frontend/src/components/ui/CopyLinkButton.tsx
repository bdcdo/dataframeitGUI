"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Link2, Check } from "lucide-react";
import { toast } from "sonner";

interface CopyLinkButtonProps {
  /**
   * Absoluta (ex.: `parecerUrl`, que aponta para fora do app) ou relativa à
   * raiz (ex.: `/projects/:id/analyze/code?doc=:docId`). A resolução para
   * absoluta acontece no clique, não no render: montar a URL com
   * `window.location.origin` durante o render faz o servidor emitir `""` e o
   * cliente emitir a origin, divergindo na hidratação.
   */
  url: string;
  className?: string;
}

export function CopyLinkButton({ url, className }: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // Base ignorada quando `url` já é absoluta, então o mesmo caminho serve
      // aos dois casos — não há ramo por tipo de URL.
      const absoluteUrl = new URL(url, window.location.href).toString();
      navigator.clipboard
        .writeText(absoluteUrl)
        .then(() => {
          toast.success("Link copiado!");
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {
          toast.error("Não foi possível copiar o link.");
        });
    },
    [url]
  );

  return (
    <Button
      variant="ghost"
      size="icon"
      className={`size-6 ${className ?? ""}`}
      onClick={handleCopy}
    >
      {copied ? (
        <Check className="size-3.5 text-green-600" />
      ) : (
        <Link2 className="size-3.5" />
      )}
    </Button>
  );
}
