"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Link2, Check } from "lucide-react";
import { toast } from "sonner";

interface CopyLinkButtonProps {
  url: string;
  className?: string;
}

export function CopyLinkButton({ url, className }: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(url).then(() => {
        toast.success("Link copiado!");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    },
    [url]
  );

  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-6 w-6 ${className ?? ""}`}
      onClick={handleCopy}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <Link2 className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
