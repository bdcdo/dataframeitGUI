"use client";

import "./globals.css";
import { ErrorPanel } from "@/components/shell/ErrorPanel";

// Último boundary do app (#653). Substitui o layout raiz quando ativo, por isso
// declara `<html>`, `<body>` e o CSS global.
export default function GlobalError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <html lang="pt-BR">
      <body className="antialiased">
        <title>Erro — dataframeit</title>
        <ErrorPanel error={error} retry={retry} />
      </body>
    </html>
  );
}
