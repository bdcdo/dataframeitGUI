"use client";

import Link from "next/link";
import { UserMenu } from "./UserMenu";

interface HeaderProps {
  projectName?: string;
  user?: { email: string; firstName?: string | null };
}

export function Header({ projectName, user }: HeaderProps) {
  return (
    <header className="flex h-12 items-center justify-between border-b px-4">
      <div className="flex items-center gap-3">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand">
            <span className="text-sm font-bold text-brand-foreground">AC</span>
          </div>
        </Link>
        {projectName && (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="font-medium">{projectName}</span>
          </>
        )}
      </div>
      {user && <UserMenu email={user.email} firstName={user.firstName} />}
    </header>
  );
}
