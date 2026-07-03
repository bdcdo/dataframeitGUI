"use client";

import type { MemberEmailLink } from "@/lib/types";

interface MemberEmailLinksProps {
  links: MemberEmailLink[];
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
            link.linked_user_id
              ? "E-mail vinculado: a conta acessa o projeto como este membro."
              : "E-mail vinculado aguardando criação da conta."
          }
        >
          <span>↳ {link.email}</span>
          {!link.linked_user_id && <span className="italic">(sem conta)</span>}
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
