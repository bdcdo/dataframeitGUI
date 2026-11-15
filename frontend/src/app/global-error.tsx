"use client";

import "./globals.css";
import { ErrorPanel, type ErrorBoundaryProps } from "@/components/shell/ErrorPanel";

// Último boundary do app (#653). Substitui o layout raiz quando ativo, por isso
// declara `<html>`, `<body>` e o CSS global.
export default function GlobalError({ error, retry }: ErrorBoundaryProps) {
  return (
    <html lang="pt-BR">
      <body className="antialiased">
        <title>Erro — dataframeit</title>
        <main>
          <ErrorPanel error={error} retry={retry} />
        </main>
      </body>
    </html>
  );
}
