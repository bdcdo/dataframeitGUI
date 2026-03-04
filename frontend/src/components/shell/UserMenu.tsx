"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { createBrowserClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

interface UserMenuProps {
  email: string;
  firstName?: string | null;
}

export function UserMenu({ email, firstName }: UserMenuProps) {
  const router = useRouter();

  const handleLogout = async () => {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    router.push("/auth/login");
  };

  const initials = firstName
    ? firstName.charAt(0).toUpperCase()
    : email.charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs font-medium text-brand-foreground">
            {initials}
          </div>
          <span className="text-sm">{firstName || email}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <div className="px-2 py-1.5">
          <p className="text-sm font-medium">{firstName || "Usuário"}</p>
          <p className="text-xs text-muted-foreground">{email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout}>Sair</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
