"use client";

import type { MemberEmailLinkView } from "./member-list-utils";

interface MemberEmailLinksProps {
  links: MemberEmailLinkView[];
  onUnlink: (linkId: string) => void;
}

export function MemberEmailLinks({ links, onUnlink }: MemberEmailLinksProps) {
  return (
    <>
      {links.map((link) => (
        <p
          key={link.id}
          className="flex items-center gap-1 text-xs text-muted-foreground"
          title={
            link.accessReady
              ? "E-mail vinculado: a conta acessa o projeto como este membro."
              : "E-mail vinculado aguardando a conclusão do acesso da conta."
          }
        >
          <span>↳ {link.email}</span>
          {!link.accessReady && (
            <span className="italic">(acesso pendente)</span>
          )}
          <button
            type="button"
            onClick={() => onUnlink(link.id)}
            className="ml-1 text-destructive hover:underline"
          >
            desvincular
          </button>
        </p>
      ))}
    </>
  );
}
